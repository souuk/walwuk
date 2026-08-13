/// <reference lib="webworker" />
/// <reference types="vite/client" />

import {
  analyze,
  type AnalysisLimits,
  type AnalysisResult,
  type GameState,
  type Move,
} from "./engine";
import { engineResourceBudget } from "./engine-resources";

type BackendSelection = "typescript" | "wasm" | "compare";
type SearchLane = "main" | "verify";

interface AnalysisRequest {
  type?: "start" | "continue" | "rebase" | "cancel" | "clear" | "load-policy" | "load-value";
  searchId?: string;
  state?: GameState;
  limits?: AnalysisLimits;
  continuous?: boolean;
  bytes?: ArrayBuffer;
}

interface ChildMessage {
  type: "progress" | "done" | "error";
  epochId?: number;
  lane?: SearchLane;
  result?: AnalysisResult;
  error?: string;
}

interface WorkerSpec {
  lanes: SearchLane[];
  workerIndex: number;
  workerCount: number;
  lane: SearchLane | "hybrid";
}

interface WorkerState {
  worker: Worker;
  spec: WorkerSpec;
  busy: boolean;
  epochId: number;
  latest: Map<SearchLane, AnalysisResult>;
  depths: Map<SearchLane, Map<number, AnalysisResult>>;
  done: Set<SearchLane>;
}

interface Session {
  searchId: string;
  state: GameState;
  limits: AnalysisLimits;
  continuous: boolean;
  epochId: number;
  round: number;
  completedNodes: number;
  completedVerifierNodes: number;
  completedTimeMs: number;
  completedTtHits: number;
  completedReusedNodes: number;
  completedTopologyHits: number;
  completedTopologyRepairs: number;
  completedDiagnostics: Record<DiagnosticField, number>;
}

const EPOCH_TIMES = [1000, 2000, 4000, 8000] as const;
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
] as const;
type DiagnosticField = typeof DIAGNOSTIC_FIELDS[number];
const configuredBackend = (import.meta.env.VITE_ENGINE_BACKEND ?? "wasm") as BackendSelection;
const budget = engineResourceBudget();
let pool: WorkerState[] = [];
let session: Session | null = null;
let nextEpochId = 0;
let fallbackRunning = false;
let policyBytesPerWorker = 0;
let valueBytesPerWorker = 0;

function distributeAsset(kind: "policy" | "value", bytes: ArrayBuffer): void {
  ensurePool();
  const nextPolicyBytes = kind === "policy" ? bytes.byteLength : policyBytesPerWorker;
  const nextValueBytes = kind === "value" ? bytes.byteLength : valueBytesPerWorker;
  const allocatedBytes = (nextPolicyBytes + nextValueBytes) * budget.searchWorkers;
  if (budget.wasmMemoryBytes + allocatedBytes > budget.memoryBudgetBytes) {
    self.postMessage({
      type: "warning",
      searchId: session?.searchId,
      message: `${kind} model exceeds the engine memory budget and was not loaded.`,
    });
    return;
  }
  policyBytesPerWorker = nextPolicyBytes;
  valueBytesPerWorker = nextValueBytes;
  budget.assetMemoryBytes = allocatedBytes;
  for (const state of pool) {
    state.worker.postMessage({
      type: `load-${kind}`,
      bytes: bytes.slice(0),
    });
  }
}

function moveRank(move: Move | null): number {
  if (!move) return Number.MAX_SAFE_INTEGER;
  if (move.kind === "pawn") return move.to.r * 9 + move.to.c;
  return 0x8000 | (move.wall.o === "v" ? 0x4000 : 0) |
    (move.wall.r * 8 + move.wall.c);
}

function sameMove(left: Move | null, right: Move | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function chooseBest(results: AnalysisResult[]): AnalysisResult | null {
  let best: AnalysisResult | null = null;
  for (const result of results) {
    if (!result.bestMove) continue;
    if (!best || result.score > best.score ||
        (result.score === best.score && moveRank(result.bestMove) < moveRank(best.bestMove))) {
      best = result;
    }
  }
  return best;
}

function workerSpecs(workerCount: number): WorkerSpec[] {
  if (workerCount === 1) {
    return [{ lanes: ["main", "verify"], lane: "hybrid", workerIndex: 0, workerCount: 1 }];
  }
  const verifierCount = Math.max(1, Math.floor(workerCount * 0.25));
  const mainCount = workerCount - verifierCount;
  return [
    ...Array.from({ length: mainCount }, (_, workerIndex) => ({
      lanes: ["main"] as SearchLane[], lane: "main" as const, workerIndex, workerCount: mainCount,
    })),
    ...Array.from({ length: verifierCount }, (_, workerIndex) => ({
      lanes: ["verify"] as SearchLane[], lane: "verify" as const, workerIndex,
      workerCount: verifierCount,
    })),
  ];
}

function aggregateLane(lane: SearchLane): AnalysisResult | null {
  const participants = pool.filter((state) => state.spec.lanes.includes(lane));
  if (!participants.length || participants.some((state) => !state.latest.has(lane))) return null;
  const depth = Math.min(...participants.map((state) => state.latest.get(lane)?.depth ?? -1));
  if (depth < 0) return null;
  const completed = participants.map((state) => state.depths.get(lane)?.get(depth));
  if (completed.some((result) => !result)) return null;
  const results = completed as AnalysisResult[];
  const best = chooseBest(results) ?? results[0];
  const live = participants.map((state) => state.latest.get(lane) ?? best);
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
    ttHits: live.reduce((total, result) => total + result.ttHits, 0),
    leafNodes: live.reduce((total, result) => total + result.leafNodes, 0),
    cutoffs: live.reduce((total, result) => total + result.cutoffs, 0),
    reducedSearches: live.reduce((total, result) => total + result.reducedSearches, 0),
    researches: live.reduce((total, result) => total + result.researches, 0),
    prunedMoves: live.reduce((total, result) => total + result.prunedMoves, 0),
    reverseFutilityCuts: live.reduce((total, result) => total + (result.reverseFutilityCuts ?? 0), 0),
    razoringCuts: live.reduce((total, result) => total + (result.razoringCuts ?? 0), 0),
    probCutCuts: live.reduce((total, result) => total + (result.probCutCuts ?? 0), 0),
    historyPrunes: live.reduce((total, result) => total + (result.historyPrunes ?? 0), 0),
    multiCutCuts: live.reduce((total, result) => total + (result.multiCutCuts ?? 0), 0),
    singularExtensions: live.reduce((total, result) => total + (result.singularExtensions ?? 0), 0),
    forcedDefenseExtensions: live.reduce(
      (total, result) => total + (result.forcedDefenseExtensions ?? 0), 0,
    ),
    exactEndgameHits: live.reduce((total, result) => total + (result.exactEndgameHits ?? 0), 0),
    reusedNodes: live.reduce((total, result) => total + (result.reusedNodes ?? 0), 0),
    canonicalTtHits: live.reduce((total, result) => total + (result.canonicalTtHits ?? 0), 0),
    topologyCacheHits: live.reduce((total, result) => total + (result.topologyCacheHits ?? 0), 0),
    topologyRepairs: live.reduce((total, result) => total + (result.topologyRepairs ?? 0), 0),
  };
}

function mergedResult(): AnalysisResult | null {
  if (!session) return null;
  const activeSession = session;
  const main = aggregateLane("main");
  const verifier = aggregateLane("verify");
  const agrees = Boolean(main?.bestMove && verifier?.bestMove && sameMove(main.bestMove, verifier.bestMove));
  const selected = agrees && main?.bestMove ? main : (verifier?.bestMove ? verifier : main);
  if (!selected) return null;
  const epochNodes = (main?.nodes ?? 0) + (verifier?.nodes ?? 0);
  const epochTimeMs = budget.searchWorkers === 1
    ? Math.max((main?.timeMs ?? 0) + (verifier?.timeMs ?? 0), 1)
    : Math.max(main?.timeMs ?? 0, verifier?.timeMs ?? 0, 1);
  const nodes = activeSession.completedNodes + epochNodes;
  const timeMs = activeSession.completedTimeMs + epochTimeMs;
  const diagnostics = Object.fromEntries(DIAGNOSTIC_FIELDS.map((field) => [
    field,
    activeSession.completedDiagnostics[field] +
      (main?.[field] ?? 0) + (verifier?.[field] ?? 0),
  ])) as Record<DiagnosticField, number>;
  return {
    ...selected,
    ...diagnostics,
    searchId: activeSession.searchId,
    depth: main?.depth ?? 0,
    selectiveDepth: main?.depth ?? 0,
    verifiedDepth: verifier?.depth ?? 0,
    selDepth: Math.max(main?.selDepth ?? 0, verifier?.selDepth ?? 0),
    nodes,
    verifierNodes: activeSession.completedVerifierNodes + (verifier?.nodes ?? 0),
    nps: Math.round(nodes * 1000 / Math.max(1, timeMs)),
    timeMs,
    ttHits: activeSession.completedTtHits + (main?.ttHits ?? 0) + (verifier?.ttHits ?? 0),
    reusedNodes: activeSession.completedReusedNodes +
      (main?.reusedNodes ?? 0) + (verifier?.reusedNodes ?? 0),
    topologyCacheHits: activeSession.completedTopologyHits +
      (main?.topologyCacheHits ?? 0) + (verifier?.topologyCacheHits ?? 0),
    topologyRepairs: activeSession.completedTopologyRepairs +
      (main?.topologyRepairs ?? 0) + (verifier?.topologyRepairs ?? 0),
    confidence: selected.proof || verifier?.proof || (verifier?.depth ?? 0) > 0
      ? "verified"
      : "provisional",
    stopReason: "time",
    backend: "wasm",
    resourceUsage: budget,
  };
}

function allWorkersIdle(): boolean {
  return pool.every((state) => !state.busy);
}

function resetRoundState(): void {
  for (const state of pool) {
    state.latest.clear();
    for (const depths of state.depths.values()) depths.clear();
    state.done.clear();
  }
}

function emit(type: "progress" | "done"): AnalysisResult | null {
  const result = mergedResult();
  if (result) self.postMessage({ type, searchId: session?.searchId, result });
  return result;
}

function beginRound(): void {
  if (!session || !allWorkersIdle()) return;
  resetRoundState();
  const epochId = ++nextEpochId;
  session.epochId = epochId;
  const timeMs = session.continuous
    ? EPOCH_TIMES[Math.min(session.round, EPOCH_TIMES.length - 1)]
    : session.limits.timeMs;
  for (const state of pool) {
    state.busy = true;
    state.epochId = epochId;
    state.worker.postMessage({
      type: "start",
      epochId,
      state: session.state,
      limits: { maxDepth: session.limits.maxDepth, timeMs },
      workerIndex: state.spec.workerIndex,
      workerCount: state.spec.workerCount,
      lane: state.spec.lane,
    });
  }
}

function finishRound(): void {
  if (!session || !allWorkersIdle()) return;
  const finalType = session.continuous ? "progress" : "done";
  const result = mergedResult();
  if (!result || !session) return;
  if (configuredBackend === "compare" && !session.continuous && result.verifiedDepth > 0) {
    const reference = analyze(session.state, {
      maxDepth: result.verifiedDepth,
      timeMs: Infinity,
    });
    const verifier = aggregateLane("verify");
    if (reference.score !== verifier?.score ||
        !sameMove(reference.bestMove, verifier?.bestMove ?? null)) {
      self.postMessage({
        type: "warning",
        searchId: session.searchId,
        message: "engine comparison found a verifier mismatch; using the TypeScript reference.",
      });
      self.postMessage({
        type: "done",
        searchId: session.searchId,
        result: { ...reference, searchId: session.searchId },
      });
      session = null;
      return;
    }
  }
  self.postMessage({ type: finalType, searchId: session.searchId, result });
  if (!session.continuous) {
    session = null;
    return;
  }
  session.completedNodes = result.nodes;
  session.completedVerifierNodes = result.verifierNodes;
  session.completedTimeMs = result.timeMs;
  session.completedTtHits = result.ttHits;
  session.completedReusedNodes = result.reusedNodes ?? 0;
  session.completedTopologyHits = result.topologyCacheHits ?? 0;
  session.completedTopologyRepairs = result.topologyRepairs ?? 0;
  for (const field of DIAGNOSTIC_FIELDS) {
    session.completedDiagnostics[field] = result[field] ?? 0;
  }
  ++session.round;
  const dutyCycle = budget.singleCoreDutyCycle;
  const delay = dutyCycle < 1
    ? Math.round(EPOCH_TIMES[Math.min(session.round, EPOCH_TIMES.length - 1)] *
      (1 / dutyCycle - 1))
    : 0;
  setTimeout(beginRound, delay);
}

function handleChild(state: WorkerState, message: ChildMessage): void {
  if (message.type === "error") {
    state.busy = false;
    if (!session || message.epochId !== session.epochId) {
      beginRound();
      return;
    }
    const failedSession = session;
    session = null;
    if (failedSession) {
      self.postMessage({
        type: "warning",
        searchId: failedSession.searchId,
        message: message.error ?? "webassembly was unavailable; using the TypeScript reference.",
      });
      runTypeScript(failedSession);
    }
    return;
  }
  if (!message.result || !message.lane) return;
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
  } else {
    emit("progress");
  }
  if (allWorkersIdle()) finishRound();
}

function ensurePool(): void {
  if (pool.length) return;
  pool = workerSpecs(budget.searchWorkers).map((spec) => {
    const worker = new Worker(new URL("./search-worker.ts", import.meta.url), { type: "module" });
    const state: WorkerState = {
      worker,
      spec,
      busy: false,
      epochId: 0,
      latest: new Map(),
      depths: new Map(spec.lanes.map((lane) => [lane, new Map()])),
      done: new Set(),
    };
    worker.onmessage = (event: MessageEvent<ChildMessage>) => handleChild(state, event.data);
    worker.onerror = (event) => handleChild(state, {
      type: "error",
      epochId: state.epochId,
      error: event.message || "engine worker failed",
    });
    return state;
  });
}

function runTypeScript(request: Session): void {
  if (fallbackRunning) return;
  fallbackRunning = true;
  try {
    const result = analyze(request.state, request.limits, (progress) => {
      self.postMessage({ type: "progress", searchId: request.searchId, result: progress });
    });
    self.postMessage({ type: "done", searchId: request.searchId, result });
  } finally {
    fallbackRunning = false;
  }
}

function start(request: AnalysisRequest): void {
  if (!request.state || !request.limits) return;
  const next: Session = {
    searchId: request.searchId ?? `${Date.now()}`,
    state: request.state,
    limits: request.limits,
    continuous: request.continuous ?? false,
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
    ) as Record<DiagnosticField, number>,
  };
  if (configuredBackend === "typescript") {
    runTypeScript(next);
    return;
  }
  ensurePool();
  session = next;
  beginRound();
}

self.onmessage = (event: MessageEvent<AnalysisRequest>) => {
  const request = event.data;
  if (request.type === "cancel") {
    if (!request.searchId || request.searchId === session?.searchId) session = null;
  } else if (request.type === "clear") {
    session = null;
    for (const state of pool) state.worker.postMessage({ type: "clear" });
  } else if (request.type === "load-policy" && request.bytes) {
    distributeAsset("policy", request.bytes);
  } else if (request.type === "load-value" && request.bytes) {
    distributeAsset("value", request.bytes);
  } else {
    start(request);
  }
};

export {};
