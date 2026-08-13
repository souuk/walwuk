import { availableParallelism, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";

import {
  fixtures,
  nativeAnalyze,
  nativeRootMoves,
} from "./engine-harness.mjs";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const depth = Math.max(1, Number.parseInt(option("depth", "3"), 10));
const fixtureName = option("position", "opening");
const fixture = fixtures.find(({ name }) => name === fixtureName);
if (!fixture) throw new Error(`unknown fixture: ${fixtureName}`);
const cpuLimit = Math.max(1, Math.floor(availableParallelism() * 0.75));
const memoryBudget = Math.min(Math.floor(totalmem() * 0.5), 1536 * 1024 * 1024);
const memoryLimit = Math.max(1, Math.floor(memoryBudget / (192 * 1024 * 1024)));
const workerCount = Math.min(
  Math.max(1, Number.parseInt(option("workers", `${cpuLimit}`), 10)),
  cpuLimit,
  memoryLimit,
);
const expected = nativeAnalyze(fixture.state, depth);
const moves = nativeRootMoves(fixture.state);
if (expected.bestMove) {
  const expectedCode = expected.bestMove.kind === "pawn"
    ? expected.bestMove.to.r * 9 + expected.bestMove.to.c
    : 0x8000 | (expected.bestMove.wall.o === "v" ? 0x4000 : 0) |
      (expected.bestMove.wall.r * 8 + expected.bestMove.wall.c);
  moves.sort((left, right) => Number(right === expectedCode) - Number(left === expectedCode));
}

let nextMove = 0;
let completed = 0;
let failed = false;
const results = [];
const started = performance.now();
const workers = Array.from({ length: workerCount }, () =>
  new Worker(new URL("./engine-root-worker.mjs", import.meta.url), {
    workerData: { state: fixture.state },
  }));

await new Promise((resolve, reject) => {
  const assign = (worker) => {
    if (nextMove >= moves.length) {
      if (completed === moves.length) resolve();
      return;
    }
    const id = nextMove;
    worker.postMessage({
      id,
      moveCode: moves[nextMove++],
      depth,
      alpha: -1_000_000,
      beta: 1_000_000,
    });
  };
  for (const worker of workers) {
    worker.on("message", (message) => {
      if (failed) return;
      if (message.error) {
        failed = true;
        reject(new Error(message.error));
        return;
      }
      results.push(message.result);
      ++completed;
      assign(worker);
      if (completed === moves.length) resolve();
    });
    worker.on("error", (error) => {
      if (!failed) {
        failed = true;
        reject(error);
      }
    });
    assign(worker);
  }
});
await Promise.all(workers.map((worker) => worker.terminate()));
const elapsedMs = performance.now() - started;
const bestScore = Math.max(...results.map((result) => result.score));
if (bestScore !== expected.score) {
  throw new Error(`dynamic root score ${bestScore} != full search ${expected.score}`);
}
const nodes = results.reduce((sum, result) => sum + result.nodes, 0);
console.log(JSON.stringify({
  position: fixtureName,
  depth,
  workers: workerCount,
  legalRootMoves: moves.length,
  score: bestScore,
  nodes,
  wallMs: Math.round(elapsedMs),
  aggregateNps: Math.round(nodes * 1000 / Math.max(1, elapsedMs)),
  parity: true,
}, null, 2));
