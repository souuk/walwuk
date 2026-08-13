const WASM_MEMORY_PER_WORKER = 96 * 1024 * 1024;
const FALLBACK_MEMORY_BUDGET = 256 * 1024 * 1024;
const MAX_MEMORY_BUDGET = 1536 * 1024 * 1024;
const MAX_SEARCH_DEPTH = 64;
const EPOCH_TIMES = [1000, 2000, 4000, 8000];
const DIAGNOSTIC_FIELDS = [
  "leafNodes",
  "cutoffs",
  "reducedSearches",
  "researches",
  "prunedMoves",
  "reverseFutilityCuts",
  "razoringCuts",
  "probCutCuts",
  "historyPrunes",
  "multiCutCuts",
  "singularExtensions",
  "forcedDefenseExtensions",
  "exactEndgameHits",
  "canonicalTtHits",
];

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
  const searchWorkers = Math.max(1, Math.min(cpuWorkers, memoryWorkers));
  return {
    searchWorkers,
    memoryBudgetBytes,
    wasmMemoryBytes: searchWorkers * WASM_MEMORY_PER_WORKER,
    assetMemoryBytes: 0,
    singleCoreDutyCycle: logicalProcessors === 1 ? 0.75 : 1,
    sharedMemoryAvailable: globalThis.crossOriginIsolated === true &&
      typeof SharedArrayBuffer !== "undefined",
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
    if (!best || result.score > best.score ||
        (result.score === best.score && moveRank(result.bestMove) < moveRank(best.bestMove))) {
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
  return [
    ...Array.from({ length: mainCount }, (_, workerIndex) => ({
      lanes: ["main"], lane: "main", workerIndex, workerCount: mainCount,
    })),
    ...Array.from({ length: verifierCount }, (_, workerIndex) => ({
      lanes: ["verify"], lane: "verify", workerIndex, workerCount: verifierCount,
    })),
  ];
}

function aggregateLane(states, lane) {
  const participants = states.filter((state) => state.spec.lanes.includes(lane));
  if (!participants.length || participants.some((state) => !state.latest.has(lane))) return null;
  const depth = Math.min(...participants.map((state) => state.latest.get(lane)?.depth ?? -1));
  if (depth < 0) return null;
  const completed = participants.map((state) => state.depths.get(lane)?.get(depth));
  if (completed.some((result) => !result)) return null;
  const best = chooseBest(completed) || completed[0];
  const live = participants.map((state) => state.latest.get(lane) || best);
  const nodes = live.reduce((total, result) => total + result.nodes, 0);
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
    ttHits: live.reduce((total, result) => total + (result.ttHits || 0), 0),
    leafNodes: live.reduce((total, result) => total + (result.leafNodes || 0), 0),
    cutoffs: live.reduce((total, result) => total + (result.cutoffs || 0), 0),
    reducedSearches: live.reduce((total, result) => total + (result.reducedSearches || 0), 0),
    researches: live.reduce((total, result) => total + (result.researches || 0), 0),
    prunedMoves: live.reduce((total, result) => total + (result.prunedMoves || 0), 0),
    reverseFutilityCuts: live.reduce((total, result) => total + (result.reverseFutilityCuts || 0), 0),
    razoringCuts: live.reduce((total, result) => total + (result.razoringCuts || 0), 0),
    probCutCuts: live.reduce((total, result) => total + (result.probCutCuts || 0), 0),
    historyPrunes: live.reduce((total, result) => total + (result.historyPrunes || 0), 0),
    multiCutCuts: live.reduce((total, result) => total + (result.multiCutCuts || 0), 0),
    singularExtensions: live.reduce((total, result) => total + (result.singularExtensions || 0), 0),
    forcedDefenseExtensions: live.reduce(
      (total, result) => total + (result.forcedDefenseExtensions || 0), 0,
    ),
    exactEndgameHits: live.reduce((total, result) => total + (result.exactEndgameHits || 0), 0),
    reusedNodes: live.reduce((total, result) => total + (result.reusedNodes || 0), 0),
    canonicalTtHits: live.reduce((total, result) => total + (result.canonicalTtHits || 0), 0),
    topologyCacheHits: live.reduce((total, result) => total + (result.topologyCacheHits || 0), 0),
    topologyRepairs: live.reduce((total, result) => total + (result.topologyRepairs || 0), 0),
  };
}

function hybridResult(main, verifier, budget, session) {
  const agrees = Boolean(
    main?.bestMove && verifier?.bestMove && JSON.stringify(main.bestMove) === JSON.stringify(verifier.bestMove),
  );
  const selected = agrees && main?.bestMove ? main : (verifier?.bestMove ? verifier : main);
  if (!selected) return null;
  const epochNodes = (main?.nodes || 0) + (verifier?.nodes || 0);
  const epochTimeMs = budget.searchWorkers === 1
    ? Math.max((main?.timeMs || 0) + (verifier?.timeMs || 0), 1)
    : Math.max(main?.timeMs || 0, verifier?.timeMs || 0, 1);
  const nodes = session.completedNodes + epochNodes;
  const timeMs = session.completedTimeMs + epochTimeMs;
  const diagnostics = Object.fromEntries(DIAGNOSTIC_FIELDS.map((field) => [
    field,
    session.completedDiagnostics[field] +
      (main?.[field] || 0) + (verifier?.[field] || 0),
  ]));
  return {
    ...selected,
    ...diagnostics,
    searchId: session.requestId,
    depth: main?.depth || 0,
    selectiveDepth: main?.depth || 0,
    verifiedDepth: verifier?.depth || 0,
    selDepth: Math.max(main?.selDepth || 0, verifier?.selDepth || 0),
    nodes,
    verifierNodes: session.completedVerifierNodes + (verifier?.nodes || 0),
    nps: Math.round(nodes * 1000 / Math.max(1, timeMs)),
    timeMs,
    ttHits: session.completedTtHits + (main?.ttHits || 0) + (verifier?.ttHits || 0),
    reusedNodes: session.completedReusedNodes + (main?.reusedNodes || 0) + (verifier?.reusedNodes || 0),
    topologyCacheHits: session.completedTopologyHits +
      (main?.topologyCacheHits || 0) + (verifier?.topologyCacheHits || 0),
    topologyRepairs: session.completedTopologyRepairs +
      (main?.topologyRepairs || 0) + (verifier?.topologyRepairs || 0),
    confidence: selected.proof || verifier?.proof || verifier?.depth > 0
      ? "verified"
      : "provisional",
    selective: true,
    stopReason: "time",
    backend: `wasm-hybrid-${budget.searchWorkers}-` +
      (budget.sharedMemoryAvailable ? "isolated-capable" : "isolated-workers"),
    resourceUsage: budget,
  };
}

const budget = resourceBudget();
let pool = [];
let session = null;
let nextSessionGeneration = 0;
let nextEpochId = 0;
let policyBytesPerWorker = 0;
let valueBytesPerWorker = 0;

function distributeAsset(kind, bytes) {
  ensurePool();
  const nextPolicyBytes = kind === "policy" ? bytes.byteLength : policyBytesPerWorker;
  const nextValueBytes = kind === "value" ? bytes.byteLength : valueBytesPerWorker;
  const allocatedBytes = (nextPolicyBytes + nextValueBytes) * budget.searchWorkers;
  if (budget.wasmMemoryBytes + allocatedBytes > budget.memoryBudgetBytes) {
    self.postMessage({
      type: "warning",
      requestId: session?.requestId,
      signature: session?.signature,
      error: `${kind} model exceeds the engine memory budget and was not loaded.`,
    });
    return;
  }
  policyBytesPerWorker = nextPolicyBytes;
  valueBytesPerWorker = nextValueBytes;
  budget.assetMemoryBytes = allocatedBytes;
  for (const state of pool) {
    state.worker.postMessage({ type: `load-${kind}`, bytes: bytes.slice(0) });
  }
}

function resetRoundState() {
  for (const state of pool) {
    state.latest.clear();
    for (const depths of state.depths.values()) depths.clear();
    state.done.clear();
  }
}

function allWorkersIdle() {
  return pool.every((state) => !state.busy);
}

function emitResult(type = "progress") {
  if (!session) return null;
  const main = aggregateLane(pool, "main");
  const verifier = aggregateLane(pool, "verify");
  const result = hybridResult(main, verifier, budget, session);
  if (!result) return null;
  self.postMessage({
    type,
    requestId: session.requestId,
    signature: session.signature,
    result,
  });
  return result;
}

function beginRound() {
  if (!session || !allWorkersIdle()) return;
  resetRoundState();
  const epochId = ++nextEpochId;
  session.epochId = epochId;
  const timeMs = EPOCH_TIMES[Math.min(session.round, EPOCH_TIMES.length - 1)];
  for (const state of pool) {
    state.busy = true;
    state.epochId = epochId;
    state.worker.postMessage({
      type: "start",
      epochId,
      state: session.state,
      maxDepth: MAX_SEARCH_DEPTH,
      timeMs,
      workerIndex: state.spec.workerIndex,
      workerCount: state.spec.workerCount,
      lane: state.spec.lane,
    });
  }
}

function completeRound() {
  if (!session || !allWorkersIdle()) return;
  const result = emitResult("progress");
  if (result) {
    const main = aggregateLane(pool, "main");
    const verifier = aggregateLane(pool, "verify");
    session.completedNodes = result.nodes;
    session.completedVerifierNodes = result.verifierNodes;
    session.completedTimeMs = result.timeMs;
    session.completedTtHits = result.ttHits;
    session.completedReusedNodes = result.reusedNodes || 0;
    session.completedTopologyHits = result.topologyCacheHits || 0;
    session.completedTopologyRepairs = result.topologyRepairs || 0;
    for (const field of DIAGNOSTIC_FIELDS) {
      session.completedDiagnostics[field] = result[field] || 0;
    }
    session.lastMain = main;
    session.lastVerifier = verifier;
  }
  ++session.round;
  const dutyCycle = budget.singleCoreDutyCycle;
  const delay = dutyCycle < 1
    ? Math.round(EPOCH_TIMES[Math.min(session.round, EPOCH_TIMES.length - 1)] *
      (1 / dutyCycle - 1))
    : 0;
  setTimeout(beginRound, delay);
}

function handleWorkerMessage(state, message) {
  if (message?.type === "error") {
    state.busy = false;
    if (session && message.epochId === session.epochId) {
      self.postMessage({
        type: "error",
        requestId: session.requestId,
        signature: session.signature,
        error: message.error || "engine worker failed",
      });
      session = null;
    }
    beginRound();
    return;
  }
  if (!message?.result || !message.lane) return;
  if (!session || message.epochId !== session.epochId || state.epochId !== message.epochId) {
    if (message.type === "done") {
      state.busy = false;
      beginRound();
    }
    return;
  }
  state.latest.set(message.lane, message.result);
  state.depths.get(message.lane)?.set(message.result.depth, message.result);
  if (message.type === "done") {
    state.done.add(message.lane);
    if (state.spec.lanes.every((lane) => state.done.has(lane))) state.busy = false;
  }
  if (message.type === "progress") emitResult("progress");
  if (allWorkersIdle()) completeRound();
}

function ensurePool() {
  if (pool.length) return;
  pool = workerSpecs(budget.searchWorkers).map((spec) => {
    const worker = new Worker(new URL("./search-worker.js", import.meta.url), { type: "module" });
    const state = {
      worker,
      spec,
      busy: false,
      epochId: 0,
      latest: new Map(),
      depths: new Map(spec.lanes.map((lane) => [lane, new Map()])),
      done: new Set(),
    };
    worker.onmessage = ({ data }) => handleWorkerMessage(state, data);
    worker.onerror = (event) => handleWorkerMessage(state, {
      type: "error",
      epochId: state.epochId,
      error: event.message || "engine worker failed",
    });
    return state;
  });
}

function startSession(data) {
  ensurePool();
  session = {
    generation: ++nextSessionGeneration,
    requestId: data.requestId,
    signature: data.signature,
    state: data.state,
    epochId: 0,
    round: 0,
    completedNodes: 0,
    completedVerifierNodes: 0,
    completedTimeMs: 0,
    completedTtHits: 0,
    completedReusedNodes: 0,
    completedTopologyHits: 0,
    completedTopologyRepairs: 0,
    completedDiagnostics: Object.fromEntries(
      DIAGNOSTIC_FIELDS.map((field) => [field, 0]),
    ),
  };
  beginRound();
}

self.onmessage = ({ data }) => {
  if (data?.type === "start" || data?.type === "rebase" || data?.type === "continue") {
    startSession(data);
  } else if (data?.type === "cancel") {
    if (!data.requestId || data.requestId === session?.requestId) session = null;
  } else if (data?.type === "clear") {
    session = null;
    for (const state of pool) state.worker.postMessage({ type: "clear" });
  } else if (data?.type === "load-policy" && data.bytes) {
    distributeAsset("policy", data.bytes);
  } else if (data?.type === "load-value" && data.bytes) {
    distributeAsset("value", data.bytes);
  }
};
