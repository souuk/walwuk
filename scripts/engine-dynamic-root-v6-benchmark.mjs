import assert from "node:assert/strict";
import {availableParallelism, totalmem} from "node:os";
import {performance} from "node:perf_hooks";
import {Worker} from "node:worker_threads";

import {fixtures, nativeAnalyze, nativeRootMoves} from "./engine-harness.mjs";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function moveCode(move) {
  if (move.kind === "pawn") return move.to.r * 9 + move.to.c;
  return 0x8000 | (move.wall.o === "v" ? 0x4000 : 0) |
    (move.wall.r * 8 + move.wall.c);
}

const INFINITY = 1_000_000;
const depth = Math.max(2, Number.parseInt(option("depth", "5"), 10));
const batchSize = Math.max(1, Number.parseInt(option("batch-size", "2"), 10));
const selected = option("positions", "opening,channelled routes,low reserves,transposition rich")
  .split(",")
  .map((name) => {
    const fixture = fixtures.find((value) => value.name === name);
    if (!fixture) throw new Error(`unknown fixture: ${name}`);
    return fixture;
  });
const cpuLimit = Math.max(1, Math.floor(availableParallelism() * 0.75));
const memoryBudget = Math.min(Math.floor(totalmem() * 0.5), 1536 * 1024 * 1024);
const memoryLimit = Math.max(1, Math.floor(memoryBudget / (192 * 1024 * 1024)));
const workerCount = Math.min(
  Math.max(1, Number.parseInt(option("workers", `${cpuLimit}`), 10)),
  cpuLimit,
  memoryLimit,
);

function makeWorker(state) {
  const worker = new Worker(new URL("./engine-root-batch-worker.mjs", import.meta.url), {
    workerData: {state, warmDepth: depth - 1},
  });
  let nextTaskId = 0;
  const pending = new Map();
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  worker.on("message", (message) => {
    if (message.ready) {
      readyResolve();
      return;
    }
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
    ready,
    worker,
    search(moves, alpha, options = {}) {
      return new Promise((resolve, reject) => {
        const id = ++nextTaskId;
        pending.set(id, {resolve, reject});
        worker.postMessage({id, moves, depth, alpha, ...options});
      });
    },
  };
}

async function dynamicSearch(fixture, prior, expected, predictionStable) {
  const predictedMove = moveCode(prior.bestMove);
  const rootMoves = nativeRootMoves(fixture.state);
  const rank = new Map(rootMoves.map((move, index) => [move, index + 1]));
  if (predictionStable) rank.set(predictedMove, 0);
  const alternatives = rootMoves.filter((move) => move !== predictedMove);
  const workers = Array.from({length: workerCount}, () => makeWorker(fixture.state));
  await Promise.all(workers.map((worker) => worker.ready));

  let preIndex = 0;
  let seedDone = false;
  let nodes = 0;
  let researches = 0;
  const preResults = [];
  const started = performance.now();
  const seedPromise = workers[0].search([predictedMove], -INFINITY, {fullWindow: true});

  async function prescreen(worker) {
    while (!seedDone && preIndex < alternatives.length) {
      const start = preIndex;
      preIndex += batchSize;
      const message = await worker.search(
        alternatives.slice(start, start + batchSize), prior.score, {research: false},
      );
      nodes += message.nodes;
      preResults.push(...message.results);
    }
  }

  const prescreening = predictionStable
    ? workers.slice(1).map(prescreen)
    : [];
  const seed = await seedPromise;
  seedDone = true;
  await Promise.all(prescreening);
  nodes += seed.nodes;
  researches += seed.researches;
  let incumbent = {move: predictedMove, result: seed.results[0].result};
  const safeUpperBounds = incumbent.result.score >= prior.score;
  const uncertain = preResults.filter(({result}) =>
    !safeUpperBounds || result.bound !== "upper" ||
      result.score >= incumbent.result.score).map(({moveCode: move}) => move);
  const queue = [...uncertain, ...alternatives.slice(preIndex)];
  let queueIndex = 0;

  async function finish(worker) {
    while (queueIndex < queue.length) {
      const start = queueIndex;
      queueIndex += batchSize;
      const message = await worker.search(
        queue.slice(start, start + batchSize), incumbent.result.score,
      );
      nodes += message.nodes;
      researches += message.researches;
      for (const {moveCode: move, result} of message.results) {
        if (result.bound !== "exact") continue;
        if (result.score > incumbent.result.score ||
            (result.score === incumbent.result.score &&
             rank.get(move) < rank.get(incumbent.move))) {
          incumbent = {move, result};
        }
      }
    }
  }

  await Promise.all(workers.map(finish));
  const wallMs = performance.now() - started;
  await Promise.all(workers.map(({worker}) => worker.terminate()));
  assert.equal(incumbent.result.score, expected.score, "dynamic root score differs");
  const expectedMove = moveCode(expected.bestMove);
  return {
    position: fixture.name,
    legalRootMoves: rootMoves.length,
    prescreenedMoves: preResults.length,
    repeatedMoves: uncertain.length,
    nodes,
    researches,
    wallMs: Math.round(wallMs),
    aggregateNps: Math.round(nodes * 1000 / Math.max(1, wallMs)),
    priorMoveStable: predictedMove === expectedMove,
    moveParity: incumbent.move === expectedMove,
    dynamicMove: incumbent.move,
    expectedMove,
  };
}

const records = [];
for (const fixture of selected) {
  const priorPrior = nativeAnalyze(fixture.state, depth - 2);
  const prior = nativeAnalyze(fixture.state, depth - 1);
  const predictionStable = Boolean(priorPrior.bestMove && prior.bestMove &&
    moveCode(priorPrior.bestMove) === moveCode(prior.bestMove) &&
    Math.abs(prior.score - priorPrior.score) <= 120);
  const referenceStarted = performance.now();
  const expected = nativeAnalyze(fixture.state, depth);
  const referenceMs = performance.now() - referenceStarted;
  assert.ok(prior.bestMove && expected.bestMove, "reference returned no move");
  if (!predictionStable) {
    records.push({
      position: fixture.name,
      mode: "serial-fallback",
      predictionStable: false,
      referenceMs: Math.round(referenceMs),
      wallMs: Math.round(referenceMs),
      speedup: 1,
      efficiency: 1,
      aggregateNps: expected.nps,
      repeatedMoves: 0,
      moveParity: true,
    });
    continue;
  }
  const dynamic = await dynamicSearch(fixture, prior, expected, predictionStable);
  records.push({
    ...dynamic,
    mode: "dynamic",
    predictionStable,
    referenceMs: Math.round(referenceMs),
    speedup: Number((referenceMs / Math.max(1, dynamic.wallMs)).toFixed(2)),
    efficiency: Number((referenceMs /
      Math.max(1, dynamic.wallMs * workerCount)).toFixed(3)),
  });
}

console.table(records.map(({position, referenceMs, wallMs, speedup, efficiency,
  aggregateNps, repeatedMoves, moveParity}) => ({
  position, referenceMs, wallMs, speedup, efficiency, aggregateNps, repeatedMoves,
  moveParity,
})));
console.log(JSON.stringify({
  scheduling: "persistent-ready-pv-first-dynamic-root-v6",
  depth,
  workerCount,
  batchSize,
  records,
}, null, 2));
