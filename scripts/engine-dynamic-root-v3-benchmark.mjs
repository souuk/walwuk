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

// Both are outside the timed region. In production they are the previously
// completed iteration and the post-search parity reference respectively.
const prior = nativeAnalyze(fixture.state, depth - 1);
const expected = nativeAnalyze(fixture.state, depth);
assert.ok(prior.bestMove && expected.bestMove, "reference search returned no move");
const priorMove = moveCode(prior.bestMove);
const expectedMove = moveCode(expected.bestMove);
const moves = nativeRootMoves(fixture.state);
moves.sort((left, right) => Number(right === priorMove) - Number(left === priorMove));

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

let nextMove = 0;
let incumbent = null;
let nodes = 0;
let researches = 0;
let failLowFallback = false;
const started = performance.now();

async function consume(worker, fullWindow = false) {
  while (nextMove < moves.length) {
    const move = moves[nextMove++];
    const alpha = fullWindow
      ? -INFINITY
      : Math.max(prior.score, incumbent?.result.score ?? -INFINITY);
    let result = await worker.search(
      move,
      alpha,
      fullWindow ? INFINITY : alpha + 1,
    );
    nodes += result.nodes;
    if (!fullWindow && result.score >= alpha) {
      ++researches;
      result = await worker.search(move, -INFINITY, INFINITY);
      nodes += result.nodes;
    }
    if ((fullWindow || result.bound === "exact") &&
        (!incumbent || result.score > incumbent.result.score ||
         (result.score === incumbent.result.score && move < incumbent.move))) {
      incumbent = { move, result };
    }
  }
}

await Promise.all(workers.map((worker) => consume(worker)));
if (!incumbent) {
  failLowFallback = true;
  nextMove = 0;
  await Promise.all(workers.map((worker) => consume(worker, true)));
}
const elapsedMs = performance.now() - started;
await Promise.all(workers.map(({ worker }) => worker.terminate()));

assert.ok(incumbent, "dynamic root search produced no exact candidate");
assert.equal(incumbent.result.score, expected.score, "dynamic root score differs");
assert.equal(incumbent.move, expectedMove, "dynamic root move differs");
console.log(JSON.stringify({
  position: fixtureName,
  depth,
  workers: workerCount,
  legalRootMoves: moves.length,
  priorScore: prior.score,
  score: incumbent.result.score,
  nodes,
  researches,
  failLowFallback,
  wallMs: Math.round(elapsedMs),
  aggregateNps: Math.round(nodes * 1000 / Math.max(1, elapsedMs)),
  parity: true,
  priorMoveStable: priorMove === expectedMove,
  scheduling: "previous-iteration-aspiration-dynamic-null-window",
}, null, 2));
