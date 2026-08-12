import { spawn } from "node:child_process";
import { availableParallelism, totalmem } from "node:os";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const total = Math.max(
  1,
  Number.parseInt(option("random", "1000000"), 10),
);
const reportedProcessors = Math.max(1, availableParallelism());
const processorLimit = reportedProcessors === 1
  ? 1
  : Math.max(1, Math.floor(reportedProcessors * 0.75));
const memoryBudget = Math.min(
  Math.floor(totalmem() * 0.5),
  1536 * 1024 * 1024,
);
const estimatedBytesPerShard = 192 * 1024 * 1024;
const memoryLimit = Math.max(
  1,
  Math.floor(memoryBudget / estimatedBytesPerShard),
);
const requestedWorkers = Math.max(
  1,
  Number.parseInt(option("workers", `${processorLimit}`), 10),
);
const workerCount = Math.min(
  total,
  requestedWorkers,
  processorLimit,
  memoryLimit,
);
const baseCount = Math.floor(total / workerCount);
const remainder = total % workerCount;

function runShard(shard) {
  const count = baseCount + (shard < remainder ? 1 : 0);
  const seed = (0x6d2b79f5 + Math.imul(shard + 1, 0x9e3779b9)) >>> 0;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "scripts/engine-random-parity.mjs",
      "--count", `${count}`,
      "--seed", `${seed}`,
    ], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let errorOutput = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      errorOutput += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(
          `parity shard ${shard + 1} exited with ${code}: ${errorOutput.trim()}`,
        ));
        return;
      }
      console.log(`shard ${shard + 1}/${workerCount}: ${output.trim()}`);
      resolve();
    });
  });
}

console.log(
  `running ${total} randomized comparisons in ${workerCount} shards ` +
  `(reported processors ${reportedProcessors}, CPU limit ${processorLimit}, ` +
  `memory limit ${memoryLimit})`,
);
await Promise.all(Array.from({ length: workerCount }, (_, shard) =>
  runShard(shard)));
console.log(`parallel random parity passed: ${total} positions`);
