import { Worker } from "node:worker_threads";
import { performance } from "node:perf_hooks";

import { fixtures, nativeAnalyze, packPosition } from "./engine-harness.mjs";

const workerCount = Math.max(1, Number.parseInt(process.argv[2] ?? "4", 10));
const fixedDepth = Math.max(0, Number.parseInt(process.argv[3] ?? "0", 10));
const poolOnly = process.argv.includes("--pool-only");
const maxDepth = fixedDepth || 15;
const timeMs = fixedDepth ? -1 : 2_000;
const fixture = fixtures.find(({ name }) => name === "opening");
let single = null;
let singleWallMs = 0;
if (!poolOnly) {
  const singleStarted = performance.now();
  single = nativeAnalyze(fixture.state, maxDepth, timeMs);
  singleWallMs = performance.now() - singleStarted;
}
const poolStarted = performance.now();
const split = await Promise.all(
  Array.from({ length: workerCount }, (_, rootIndex) =>
    new Promise((resolve, reject) => {
      const worker = new Worker(new URL("./engine-split-worker.mjs", import.meta.url), {
        workerData: {
          position: packPosition(fixture.state),
          maxDepth,
          timeMs,
          rootIndex,
          rootCount: workerCount,
        },
      });
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", (code) => {
        if (code !== 0) reject(new Error(`engine worker exited with code ${code}`));
      });
    }),
  ),
);
const poolWallMs = performance.now() - poolStarted;

const poolNodes = split.reduce((total, result) => total + result.nodes, 0);
const poolTime = Math.max(...split.map((result) => result.timeMs));
const poolNps = Math.round(poolNodes * 1000 / poolTime);
const rows = [{
  mode: "pool",
  workers: workerCount,
  nps: poolNps,
  nodes: poolNodes,
  minimumDepth: Math.min(...split.map((result) => result.depth)),
  wallMs: Math.round(poolWallMs),
}];
if (single) {
  rows.unshift({
    mode: "single",
    workers: 1,
    nps: single.nps,
    nodes: single.nodes,
    minimumDepth: single.depth,
    wallMs: Math.round(singleWallMs),
  });
}
console.table(rows);
if (single) {
  console.log(`worker-pool throughput: ${(poolNps / single.nps).toFixed(2)}x`);
}
if (single && fixedDepth) {
  console.log(`fixed-depth wall-clock speedup: ${(singleWallMs / poolWallMs).toFixed(2)}x`);
}
