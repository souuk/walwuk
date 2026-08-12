import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { availableParallelism, cpus, totalmem } from "node:os";
import path from "node:path";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const controls = option("time-controls", "250,1000,5000,10000,15000")
  .split(",")
  .map((value) => Number.parseInt(value.trim(), 10))
  .filter((value) => Number.isFinite(value) && value >= 25 && value <= 15_000);
if (!controls.length) throw new Error("no valid time controls supplied");

const maxDepth = Math.max(1, Number.parseInt(option("max-depth", "20"), 10));
const outputDirectory = path.resolve(option("output", "outputs/performance-matrix"));
await mkdir(outputDirectory, { recursive: true });

async function runControl(timeMs) {
  const output = path.join(outputDirectory, `${timeMs}ms.json`);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "scripts/engine-accuracy-benchmark.mjs",
      "--time-ms", `${timeMs}`,
      "--max-depth", `${maxDepth}`,
      "--output", output,
    ], { cwd: process.cwd(), stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => code === 0
      ? resolve()
      : reject(new Error(`${timeMs} ms benchmark exited with ${code}`)));
  });
  return JSON.parse(await readFile(output, "utf8"));
}

const runs = [];
for (const timeMs of controls) runs.push(await runControl(timeMs));

const wasm = await readFile(path.resolve("public/engine/walwuk-engine.wasm"));
const summary = {
  generatedAt: new Date().toISOString(),
  engineSha256: createHash("sha256").update(wasm).digest("hex"),
  environment: {
    cpu: cpus()[0]?.model ?? "unknown",
    reportedLogicalProcessors: availableParallelism(),
    totalMemoryBytes: totalmem(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
  },
  settings: { controls, maxDepth },
  runs,
};
await writeFile(
  path.join(outputDirectory, "summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
console.log(`performance matrix complete: ${outputDirectory}`);
