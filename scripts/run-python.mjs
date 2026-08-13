import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const bundled = resolve(".emsdk", "python", "3.13.3_64bit", "python.exe");
const candidates = [
  process.env.WALWUK_PYTHON,
  process.platform === "win32" && existsSync(bundled) ? bundled : null,
  process.platform === "win32" ? "python" : "python3",
].filter(Boolean);
let failure = "";
for (const executable of candidates) {
  const result = spawnSync(executable, process.argv.slice(2), {
    cwd: process.cwd(),
    stdio: "inherit",
  });
  if (result.status === 0) process.exit(0);
  failure = `${result.error ?? `exit ${result.status}`}`;
  if (!result.error || result.error.code !== "ENOENT") process.exit(result.status ?? 1);
}
console.error(`Python was unavailable: ${failure}`);
process.exit(1);
