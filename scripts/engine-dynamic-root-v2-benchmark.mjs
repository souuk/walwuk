import assert from "node:assert/strict";
import { availableParallelism, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";

import {
  fixtures,
  nativeAnalyze,
  nativeRootMoves,
} from "./engine-harness.mjs";

const INFINITY = 1_000_000;

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function moveCode(move) {
  if (move.kind === "pawn") return move.to.r * 9 + move.to.c;
  return 0x8000 | (move.wall.o === "v" ? 0x4000 : 0) |
    (move.wall.r * 8 + move.wall.c);
}

const depth = Math.max(1, Number.parseInt(option("depth", "5"), 10));
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
assert.ok(expected.bestMove, "reference search returned no root move");
const expectedMove = moveCode(expected.bestMove);
const moves = nativeRootMoves(fixture.state);
const prediction = option("prediction", "best");
const predictedMove = prediction === "first"
  ? moves[0]
  : prediction === "last" ? moves.at(-1) : expectedMove;
const predictedIndex = moves.indexOf(predictedMove);
assert.notEqual(predictedIndex, -1, "reference move was absent from legal roots");
moves.splice(predictedIndex, 1);

let nextTaskId = 0;
const workers = Array.from({ length: workerCount }, () => {
  const worker = new Worker(new URL("./engine-root-worker.mjs", import.meta.url), {
    workerData: { state: fixture.state },
  });
  const pending = new Map();
  worker.on("message", (message) => {
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    if (message.error) task.reject(new Error(message.error));
    else task.resolve(message.result);
  });
  worker.on("error", (error) => {
    for (const task of pending.values()) task.reject(error);
    pending.clear();
  });
  return {
    worker,
    search(move, alpha, beta) {
      return new Promise((resolve, reject) => {
        const id = ++nextTaskId;
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, moveCode: move, depth, alpha, beta });
      });
    },
  };
});

const started = performance.now();
const seed = await workers[0].search(predictedMove, -INFINITY, INFINITY);
let incumbent = { move: predictedMove, result: seed };
let nextMove = 0;
let nodes = seed.nodes;
let researches = 0;

async function consume(worker) {
  while (nextMove < moves.length) {
    const move = moves[nextMove++];
    const alpha = incumbent.result.score;
    let result = await worker.search(move, alpha, alpha + 1);
    nodes += result.nodes;
    if (result.score >= alpha) {
      ++researches;
      result = await worker.search(move, -INFINITY, INFINITY);
      nodes += result.nodes;
    }
    if (result.score > incumbent.result.score ||
        (result.score === incumbent.result.score && move < incumbent.move)) {
      incumbent = { move, result };
    }
  }
}

await Promise.all(workers.map(consume));
const elapsedMs = performance.now() - started;
await Promise.all(workers.map(({ worker }) => worker.terminate()));

assert.equal(incumbent.result.score, expected.score, "dynamic root score differs");
assert.equal(incumbent.move, expectedMove, "dynamic root move differs");
console.log(JSON.stringify({
  position: fixtureName,
  depth,
  workers: workerCount,
  legalRootMoves: moves.length + 1,
  score: incumbent.result.score,
  nodes,
  researches,
  wallMs: Math.round(elapsedMs),
  aggregateNps: Math.round(nodes * 1000 / Math.max(1, elapsedMs)),
  parity: true,
  predictedBest: predictedMove === expectedMove,
  scheduling: "predicted-first-dynamic-null-window",
}, null, 2));
