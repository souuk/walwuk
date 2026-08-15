import assert from "node:assert/strict";
import { availableParallelism, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";

import { fixtures, nativeAnalyze, nativeRootMoves } from "./engine-harness.mjs";

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

const depth = Math.max(2, Number.parseInt(option("depth", "5"), 10));
const batchSize = Math.max(1, Number.parseInt(option("batch-size", "4"), 10));
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
const prior = nativeAnalyze(fixture.state, depth - 1);
const expected = nativeAnalyze(fixture.state, depth);
assert.ok(prior.bestMove && expected.bestMove, "reference search returned no move");
const predictedMove = moveCode(prior.bestMove);
const expectedMove = moveCode(expected.bestMove);
const rootMoves = nativeRootMoves(fixture.state);
const rootRank = new Map(rootMoves.map((move, index) => [move, index]));
const moves = rootMoves.filter((move) => move !== predictedMove);

let nextTaskId = 0;
const workers = Array.from({ length: workerCount }, () => {
  const worker = new Worker(new URL("./engine-root-batch-worker.mjs", import.meta.url), {
    workerData: { state: fixture.state },
  });
  const pending = new Map();
  worker.on("message", (message) => {
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    if (message.error) task.reject(new Error(message.error));
    else task.resolve(message);
  });
  worker.on("error", (error) => {
    for (const task of pending.values()) task.reject(error);
    pending.clear();
  });
  return {
    worker,
    search(batch, alpha) {
      return new Promise((resolve, reject) => {
        const id = ++nextTaskId;
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, moves: batch, depth, alpha });
      });
    },
  };
});

let nextMove = 0;
let nodes = 0;
let researches = 0;
const started = performance.now();
const seedMessage = await new Promise((resolve, reject) => {
  const id = ++nextTaskId;
  const handler = (message) => {
    if (message.id !== id) return;
    workers[0].worker.off("message", handler);
    if (message.error) reject(new Error(message.error));
    else resolve(message);
  };
  workers[0].worker.on("message", handler);
  workers[0].worker.postMessage({
    id,
    moves: [predictedMove],
    depth,
    alpha: -INFINITY,
  });
});
nodes += seedMessage.nodes;
researches += seedMessage.researches;
let incumbent = {
  move: predictedMove,
  result: seedMessage.results[0].result,
};

async function consume(worker) {
  while (nextMove < moves.length) {
    const start = nextMove;
    nextMove += batchSize;
    const batch = moves.slice(start, start + batchSize);
    const message = await worker.search(batch, incumbent.result.score);
    nodes += message.nodes;
    researches += message.researches;
    for (const { moveCode: move, result } of message.results) {
      if (result.bound !== "exact") continue;
      if (result.score > incumbent.result.score ||
          (result.score === incumbent.result.score &&
           rootRank.get(move) < rootRank.get(incumbent.move))) {
        incumbent = { move, result };
      }
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
  batchSize,
  legalRootMoves: moves.length + 1,
  nodes,
  researches,
  wallMs: Math.round(elapsedMs),
  aggregateNps: Math.round(nodes * 1000 / Math.max(1, elapsedMs)),
  parity: true,
  priorMoveStable: predictedMove === expectedMove,
  scheduling: "predicted-first-dynamic-batched-null-window",
}, null, 2));
