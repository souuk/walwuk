const MAX_ENGINE_WORKERS = 12;

function availableWorkerCount() {
  const logicalProcessors = navigator.hardwareConcurrency || 2;
  return Math.max(1, Math.min(MAX_ENGINE_WORKERS, logicalProcessors - 1 || 1));
}

function moveRank(move) {
  if (!move) return Number.MAX_SAFE_INTEGER;
  if (move.kind === "pawn") return move.to.r * 9 + move.to.c;
  return 0x8000 |
    (move.wall.o === "v" ? 0x4000 : 0) |
    (move.wall.r * 8 + move.wall.c);
}

function chooseBest(results) {
  let best = null;
  for (const result of results) {
    if (!result?.bestMove) continue;
    if (
      !best ||
      result.score > best.score ||
      (result.score === best.score &&
        moveRank(result.bestMove) < moveRank(best.bestMove))
    ) {
      best = result;
    }
  }
  return best;
}

function aggregate(states, depth, allDone) {
  const completed = states.map((state) => state.depths.get(depth));
  if (completed.some((result) => !result)) return null;
  const best = chooseBest(completed) || completed[0];
  const live = states.map((state) => state.latest || state.depths.get(depth));
  const nodes = live.reduce((total, result) => total + (result?.nodes || 0), 0);
  const ttHits = live.reduce((total, result) => total + (result?.ttHits || 0), 0);
  const timeMs = Math.max(...live.map((result) => result?.timeMs || 0), 1);
  return {
    ...best,
    depth,
    nodes,
    nps: Math.round(nodes * 1000 / timeMs),
    timeMs,
    ttHits,
    stopReason: allDone ? "depth" : best.stopReason,
    backend: states.length === 1 ? "wasm" : `wasm-pool-${states.length}`,
  };
}

self.onmessage = ({ data }) => {
  if (data?.type !== "start") return;
  const { requestId, signature } = data;
  let fallbackStarted = false;
  let pool = [];
  let poolGeneration = 0;
  let lastDepth = -1;
  let lastProgressAt = 0;

  const terminatePool = () => {
    for (const state of pool) state.worker.terminate();
    pool = [];
  };

  const startPool = (workerCount) => {
    terminatePool();
    const generation = ++poolGeneration;
    lastDepth = -1;
    lastProgressAt = 0;
    pool = Array.from({ length: workerCount }, (_, workerIndex) => {
      const worker = new Worker(new URL("./search-worker.js", import.meta.url), {
        type: "module",
      });
      const state = {
        worker,
        latest: null,
        depths: new Map(),
        done: false,
      };
      worker.onmessage = ({ data: workerMessage }) => {
        if (generation !== poolGeneration) return;
        if (workerMessage?.type === "error") {
          if (workerCount > 1 && !fallbackStarted) {
            fallbackStarted = true;
            startPool(1);
            return;
          }
          self.postMessage({
            type: "error",
            requestId,
            signature,
            error: workerMessage.error || "engine worker failed",
          });
          terminatePool();
          return;
        }
        if (!workerMessage?.result) return;
        state.latest = workerMessage.result;
        state.depths.set(workerMessage.result.depth, workerMessage.result);
        state.done = workerMessage.type === "done";

        const commonDepth = Math.min(...pool.map((item) => item.latest?.depth ?? -1));
        if (commonDepth < 0) return;
        const allDone = pool.every((item) => item.done);
        const now = performance.now();
        const advanced = commonDepth > lastDepth;
        if (!allDone && !advanced && now - lastProgressAt < 1000) return;
        const result = aggregate(pool, commonDepth, allDone);
        if (!result) return;
        lastDepth = Math.max(lastDepth, commonDepth);
        lastProgressAt = now;
        self.postMessage({
          type: allDone ? "done" : "progress",
          requestId,
          signature,
          result,
        });
        if (allDone) terminatePool();
      };
      worker.onerror = (event) => {
        worker.onmessage({
          data: {
            type: "error",
            error: event.message || "engine worker failed",
          },
        });
      };
      worker.postMessage({
        type: "start",
        state: data.state,
        workerIndex,
        workerCount,
      });
      return state;
    });
  };

  try {
    startPool(availableWorkerCount());
  } catch (error) {
    self.postMessage({
      type: "error",
      requestId,
      signature,
      error: error instanceof Error ? error.message : "engine pool failed",
    });
    terminatePool();
  }
};
