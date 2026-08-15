import {
  closeSync,
  openSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));
const STALE_AFTER_MS = 10 * 60 * 1000;
const WAIT_LIMIT_MS = 3 * 60 * 1000;

export function acquireBuildLock(output) {
  const lockPath = `${output}.build-lock`;
  const started = Date.now();
  while (true) {
    try {
      const descriptor = openSync(lockPath, "wx");
      writeFileSync(descriptor, `${process.pid}\n`);
      return () => {
        closeSync(descriptor);
        try {
          unlinkSync(lockPath);
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > STALE_AFTER_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch (statError) {
        if (statError?.code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() - started > WAIT_LIMIT_MS) {
        throw new Error(`Timed out waiting for engine build lock: ${lockPath}`);
      }
      Atomics.wait(WAIT_BUFFER, 0, 0, 250);
    }
  }
}
