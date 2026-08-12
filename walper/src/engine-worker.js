const MAX_ENGINE_WORKERS = 12;
const WASM_MEMORY_PER_WORKER = 96 * 1024 * 1024;
const FALLBACK_MEMORY_BUDGET = 256 * 1024 * 1024;
const MAX_MEMORY_BUDGET = 1536 * 1024 * 1024;

function resourceBudget() {
  const logicalProcessors = Math.max(1, Math.floor(navigator.hardwareConcurrency || 1));
  const cpuWorkers = logicalProcessors === 1
    ? 1
    : Math.max(1, Math.floor(logicalProcessors * 0.75));
  const candidates = [MAX_MEMORY_BUDGET];
  if (navigator.deviceMemory && Number.isFinite(navigator.deviceMemory)) {
    candidates.push(navigator.deviceMemory * 0.5 * 1024 * 1024 * 1024);
  } else {
    candidates.push(FALLBACK_MEMORY_BUDGET);
  }
  if (performance.memory?.jsHeapSizeLimit) {
    candidates.push(performance.memory.jsHeapSizeLimit * 0.65);
  }
  const memoryBudgetBytes = Math.max(
    WASM_MEMORY_PER_WORKER,
    Math.floor(Math.min(...candidates)),
  );
  const memoryWorkers = Math.max(1, Math.floor(memoryBudgetBytes / WASM_MEMORY_PER_WORKER));
  const searchWorkers = Math.max(
    1,
    Math.min(MAX_ENGINE_WORKERS, cpuWorkers, memoryWorkers),
  );
  return {
    searchWorkers,
    wasmMemoryBytes: searchWorkers * WASM_MEMORY_PER_WORKER,
    assetMemoryBytes: 0,
  };
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
      (result.score === best.score && moveRank(result.bestMove) < moveRank(best.bestMove))
    ) {
      best = result;
    }
  }
  return best;
}

function workerSpecs(workerCount) {
  if (workerCount === 1) {
    return [{ lanes: ["main", "verify"], lane: "hybrid", workerIndex: 0, workerCount: 1 }];
  }
  const verifierCount = Math.max(1, Math.floor(workerCount * 0.25));
  const mainCount = workerCount - verifierCount;
  const specs = [];
  for (let index = 0; index < mainCount; ++index) {
    specs.push({ lanes: ["main"], lane: "main", workerIndex: index, workerCount: mainCount });
  }
  for (let index = 0; index < verifierCount; ++index) {
    specs.push({ lanes: ["verify"], lane: "verify", workerIndex: index, workerCount: verifierCount });
  }
  return specs;
}

function aggregateLane(states, lane) {
  const participants = states.filter((state) => state.lanes.includes(lane));
  if (!participants.length || participants.some((state) => !state.latest.has(lane))) return null;
  const depth = Math.min(...participants.map((state) => state.latest.get(lane)?.depth ?? -1));
  if (depth < 0) return null;
  const completed = participants.map((state) => state.depths.get(lane)?.get(depth));
  if (completed.some((result) => !result)) return null;
  const best = chooseBest(completed) || completed[0];
  const live = participants.map((state) => state.latest.get(lane) || best);
  const nodes = live.reduce((total, result) => total + result.nodes, 0);
  const ttHits = live.reduce((total, result) => total + result.ttHits, 0);
  const timeMs = Math.max(...live.map((result) => result.timeMs), 1);
  return {
    ...best,
    depth,
    selectiveDepth: lane === "main" ? depth : 0,
    verifiedDepth: lane === "verify" ? depth : 0,
    selDepth: Math.max(...live.map((result) => result.selDepth ?? result.depth)),
    nodes,
    verifierNodes: lane === "verify" ? nodes : 0,
    nps: Math.round(nodes * 1000 / timeMs),
    timeMs,
    ttHits,
    leafNodes: live.reduce((total, result) => total + (result.leafNodes || 0), 0),
    cutoffs: live.reduce((total, result) => total + (result.cutoffs || 0), 0),
    reducedSearches: live.reduce((total, result) => total + (result.reducedSearches || 0), 0),
    researches: live.reduce((total, result) => total + (result.researches || 0), 0),
    prunedMoves: live.reduce((total, result) => total + (result.prunedMoves || 0), 0),
  };
}

function hybridResult(main, verifier, budget, allDone) {
  const agrees = Boolean(
    main?.bestMove && verifier?.bestMove && JSON.stringify(main.bestMove) === JSON.stringify(verifier.bestMove),
  );
  const verifierOverrides = Boolean(verifier?.bestMove && !agrees);
  const selected = agrees && main?.bestMove ? main : (verifier?.bestMove ? verifier : main);
  if (!selected) return null;
  const nodes = (main?.nodes || 0) + (verifier?.nodes || 0);
  const timeMs = budget.searchWorkers === 1
    ? Math.max((main?.timeMs || 0) + (verifier?.timeMs || 0), 1)
    : Math.max(main?.timeMs || 0, verifier?.timeMs || 0, 1);
  return {
    ...selected,
    depth: main?.depth || 0,
    selectiveDepth: main?.depth || 0,
    verifiedDepth: verifier?.depth || 0,
    selDepth: Math.max(main?.selDepth || 0, verifier?.selDepth || 0),
    nodes,
    verifierNodes: verifier?.nodes || 0,
    nps: Math.round(nodes * 1000 / timeMs),
    timeMs,
    ttHits: (main?.ttHits || 0) + (verifier?.ttHits || 0),
    leafNodes: (main?.leafNodes || 0) + (verifier?.leafNodes || 0),
    cutoffs: (main?.cutoffs || 0) + (verifier?.cutoffs || 0),
    reducedSearches: (main?.reducedSearches || 0) + (verifier?.reducedSearches || 0),
    researches: (main?.researches || 0) + (verifier?.researches || 0),
    prunedMoves: (main?.prunedMoves || 0) + (verifier?.prunedMoves || 0),
    confidence: verifier?.depth > 0 && (agrees || verifierOverrides) ? "verified" : "provisional",
    selective: true,
    stopReason: allDone ? "depth" : selected.stopReason,
    backend: `wasm-hybrid-${budget.searchWorkers}`,
    resourceUsage: budget,
  };
}

self.onmessage = ({ data }) => {
  if (data?.type !== "start") return;
  const { requestId, signature } = data;
  const initialBudget = resourceBudget();
  let fallbackStarted = false;
  let pool = [];
  let poolGeneration = 0;
  let lastMainDepth = -1;
  let lastVerifiedDepth = -1;
  let lastProgressAt = 0;

  const terminatePool = () => {
    for (const state of pool) state.worker.terminate();
    pool = [];
  };

  const startPool = (workerCount) => {
    terminatePool();
    const generation = ++poolGeneration;
    lastMainDepth = -1;
    lastVerifiedDepth = -1;
    lastProgressAt = 0;
    pool = workerSpecs(workerCount).map((spec) => {
      const worker = new Worker(new URL("./search-worker.js", import.meta.url), { type: "module" });
      const state = {
        worker,
        lanes: spec.lanes,
        latest: new Map(),
        depths: new Map(spec.lanes.map((lane) => [lane, new Map()])),
        done: new Set(),
      };
      const handleMessage = (workerMessage) => {
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
        const lane = workerMessage?.lane;
        if (!workerMessage?.result || !lane) return;
        state.latest.set(lane, workerMessage.result);
        state.depths.get(lane)?.set(workerMessage.result.depth, workerMessage.result);
        if (workerMessage.type === "done") state.done.add(lane);

        const main = aggregateLane(pool, "main");
        const verifier = aggregateLane(pool, "verify");
        const allDone = pool.every((item) => item.lanes.every((itemLane) => item.done.has(itemLane)));
        const budget = {
          ...initialBudget,
          searchWorkers: workerCount,
          wasmMemoryBytes: workerCount * WASM_MEMORY_PER_WORKER,
        };
        const result = hybridResult(main, verifier, budget, allDone);
        if (!result) return;
        const now = performance.now();
        const advanced = result.selectiveDepth > lastMainDepth ||
          result.verifiedDepth > lastVerifiedDepth;
        if (!allDone && !advanced && now - lastProgressAt < 1000) return;
        lastMainDepth = Math.max(lastMainDepth, result.selectiveDepth);
        lastVerifiedDepth = Math.max(lastVerifiedDepth, result.verifiedDepth);
        lastProgressAt = now;
        self.postMessage({
          type: allDone ? "done" : "progress",
          requestId,
          signature,
          result,
        });
        if (allDone) terminatePool();
      };
      worker.onmessage = ({ data: workerMessage }) => handleMessage(workerMessage);
      worker.onerror = (event) => handleMessage({
        type: "error",
        error: event.message || "engine worker failed",
      });
      worker.postMessage({
        type: "start",
        state: data.state,
        workerIndex: spec.workerIndex,
        workerCount: spec.workerCount,
        lane: spec.lane,
      });
      return state;
    });
  };

  try {
    startPool(initialBudget.searchWorkers);
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
