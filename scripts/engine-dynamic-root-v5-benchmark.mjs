import assert from "node:assert/strict";
import { availableParallelism, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";

import { fixtures, nativeAnalyze, nativeRootMoves } from "./engine-harness.mjs";

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
const alternatives = nativeRootMoves(fixture.state)
  .filter((move) => move !== predictedMove);

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
    search(moves, alpha, options = {}) {
      return new Promise((resolve, reject) => {
        const id = ++nextTaskId;
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, moves, depth, alpha, ...options });
      });
    },
  };
});

let preIndex = 0;
let seedDone = false;
let nodes = 0;
let researches = 0;
const preResults = [];
const started = performance.now();
const seedPromise = workers[0].search(
  [predictedMove],
  -1_000_000,
  { fullWindow: true },
);

async function prescreen(worker) {
  while (!seedDone && preIndex < alternatives.length) {
    const start = preIndex;
    preIndex += batchSize;
    const message = await worker.search(
      alternatives.slice(start, start + batchSize),
      prior.score,
      { research: false },
    );
    nodes += message.nodes;
    preResults.push(...message.results);
  }
}

const prescreening = workers.slice(1).map(prescreen);
const seed = await seedPromise;
seedDone = true;
await Promise.all(prescreening);
nodes += seed.nodes;
researches += seed.researches;
let incumbent = { move: predictedMove, result: seed.results[0].result };

const safeUpperBounds = incumbent.result.score >= prior.score;
const uncertain = preResults
  .filter(({ result }) =>
    !safeUpperBounds || result.bound !== "upper" ||
    result.score >= incumbent.result.score)
  .map(({ moveCode: move }) => move);
const queue = [...uncertain, ...alternatives.slice(preIndex)];
let queueIndex = 0;

async function finish(worker) {
  while (queueIndex < queue.length) {
    const start = queueIndex;
    queueIndex += batchSize;
    const message = await worker.search(
      queue.slice(start, start + batchSize),
      incumbent.result.score,
    );
    nodes += message.nodes;
    researches += message.researches;
    for (const { moveCode: move, result } of message.results) {
      if (result.bound !== "exact") continue;
      if (result.score > incumbent.result.score ||
          (result.score === incumbent.result.score && move < incumbent.move)) {
        incumbent = { move, result };
      }
    }
  }
}

await Promise.all(workers.map(finish));
const elapsedMs = performance.now() - started;
await Promise.all(workers.map(({ worker }) => worker.terminate()));

assert.equal(incumbent.result.score, expected.score, "dynamic root score differs");
assert.equal(incumbent.move, expectedMove, "dynamic root move differs");
console.log(JSON.stringify({
  position: fixtureName,
  depth,
  workers: workerCount,
  batchSize,
  legalRootMoves: alternatives.length + 1,
  prescreenedMoves: preResults.length,
  repeatedMoves: uncertain.length,
  nodes,
  researches,
  wallMs: Math.round(elapsedMs),
  aggregateNps: Math.round(nodes * 1000 / Math.max(1, elapsedMs)),
  parity: true,
  priorMoveStable: predictedMove === expectedMove,
  scheduling: "pipelined-pv-and-alternative-prescreen",
}, null, 2));
