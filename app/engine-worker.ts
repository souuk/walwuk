/// <reference lib="webworker" />
/// <reference types="vite/client" />

import {
  analyze,
  type AnalysisLimits,
  type AnalysisResult,
  type GameState,
  type Move,
} from "./engine";
import { engineResourceBudget, type EngineResourceBudget } from "./engine-resources";

type BackendSelection = "typescript" | "wasm" | "compare";
type SearchLane = "main" | "verify";

interface AnalysisRequest {
  state: GameState;
  limits: AnalysisLimits;
}

interface ChildMessage {
  type: "progress" | "done" | "error";
  lane?: SearchLane;
  result?: AnalysisResult;
  error?: string;
}

interface WorkerState {
  worker: Worker;
  lanes: SearchLane[];
  latest: Map<SearchLane, AnalysisResult>;
  depths: Map<SearchLane, Map<number, AnalysisResult>>;
  done: Set<SearchLane>;
}

interface WorkerSpec {
  lanes: SearchLane[];
  workerIndex: number;
  workerCount: number;
  lane: SearchLane | "hybrid";
}

const configuredBackend = (import.meta.env.VITE_ENGINE_BACKEND ?? "wasm") as BackendSelection;

function moveRank(move: Move | null): number {
  if (!move) return Number.MAX_SAFE_INTEGER;
  if (move.kind === "pawn") return move.to.r * 9 + move.to.c;
  return 0x8000 |
    (move.wall.o === "v" ? 0x4000 : 0) |
    (move.wall.r * 8 + move.wall.c);
}

function chooseBest(results: AnalysisResult[]): AnalysisResult | null {
  let best: AnalysisResult | null = null;
  for (const result of results) {
    if (!result.bestMove) continue;
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

function workerSpecs(workerCount: number): WorkerSpec[] {
  if (workerCount === 1) {
    return [{ lanes: ["main", "verify"], workerIndex: 0, workerCount: 1, lane: "hybrid" }];
  }
  const verifierCount = Math.max(1, Math.floor(workerCount * 0.25));
  const mainCount = workerCount - verifierCount;
  const specs: WorkerSpec[] = [];
  for (let index = 0; index < mainCount; ++index) {
    specs.push({ lanes: ["main"], workerIndex: index, workerCount: mainCount, lane: "main" });
  }
  for (let index = 0; index < verifierCount; ++index) {
    specs.push({ lanes: ["verify"], workerIndex: index, workerCount: verifierCount, lane: "verify" });
  }
  return specs;
}

function aggregateLane(states: WorkerState[], lane: SearchLane): AnalysisResult | null {
  const participants = states.filter((state) => state.lanes.includes(lane));
  if (!participants.length || participants.some((state) => !state.latest.has(lane))) return null;
  const depth = Math.min(...participants.map((state) => state.latest.get(lane)?.depth ?? -1));
  if (depth < 0) return null;
  const completed = participants.map((state) => state.depths.get(lane)?.get(depth));
  if (completed.some((result) => !result)) return null;
  const results = completed as AnalysisResult[];
  const best = chooseBest(results) ?? results[0];
  const live = participants.map((state) => state.latest.get(lane) ?? best);
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
    leafNodes: live.reduce((total, result) => total + result.leafNodes, 0),
    cutoffs: live.reduce((total, result) => total + result.cutoffs, 0),
    reducedSearches: live.reduce((total, result) => total + result.reducedSearches, 0),
    researches: live.reduce((total, result) => total + result.researches, 0),
    prunedMoves: live.reduce((total, result) => total + result.prunedMoves, 0),
    exactEndgameHits: live.reduce(
      (total, result) => total + (result.exactEndgameHits ?? 0),
      0,
    ),
  };
}

function mergeHybridResult(
  main: AnalysisResult | null,
  verifier: AnalysisResult | null,
  budget: EngineResourceBudget,
  allDone: boolean,
  limits: AnalysisLimits,
): AnalysisResult | null {
  const agrees = Boolean(main?.bestMove && verifier?.bestMove && sameMove(main.bestMove, verifier.bestMove));
  const verifierOverrides = Boolean(verifier?.bestMove && !agrees);
  const selected = agrees && main?.bestMove ? main : (verifier?.bestMove ? verifier : main);
  if (!selected) return null;
  const nodes = (main?.nodes ?? 0) + (verifier?.nodes ?? 0);
  const timeMs = budget.searchWorkers === 1
    ? Math.max((main?.timeMs ?? 0) + (verifier?.timeMs ?? 0), 1)
    : Math.max(main?.timeMs ?? 0, verifier?.timeMs ?? 0, 1);
  const selectiveDepth = main?.depth ?? 0;
  const verifiedDepth = verifier?.depth ?? 0;
  return {
    ...selected,
    depth: selectiveDepth,
    selectiveDepth,
    verifiedDepth,
    selDepth: Math.max(main?.selDepth ?? 0, verifier?.selDepth ?? 0),
    nodes,
    verifierNodes: verifier?.nodes ?? 0,
    nps: Math.round(nodes * 1000 / timeMs),
    timeMs,
    ttHits: (main?.ttHits ?? 0) + (verifier?.ttHits ?? 0),
    leafNodes: (main?.leafNodes ?? 0) + (verifier?.leafNodes ?? 0),
    cutoffs: (main?.cutoffs ?? 0) + (verifier?.cutoffs ?? 0),
    reducedSearches: (main?.reducedSearches ?? 0) + (verifier?.reducedSearches ?? 0),
    researches: (main?.researches ?? 0) + (verifier?.researches ?? 0),
    prunedMoves: (main?.prunedMoves ?? 0) + (verifier?.prunedMoves ?? 0),
    exactEndgameHits:
      (main?.exactEndgameHits ?? 0) + (verifier?.exactEndgameHits ?? 0),
    selective: true,
    confidence: verifiedDepth > 0 && (agrees || verifierOverrides) ? "verified" : "provisional",
    stopReason: allDone
      ? ((selectiveDepth >= limits.maxDepth && verifiedDepth >= limits.maxDepth) ? "depth" : "time")
      : selected.stopReason,
    backend: "wasm",
    resourceUsage: {
      searchWorkers: budget.searchWorkers,
      wasmMemoryBytes: budget.wasmMemoryBytes,
      assetMemoryBytes: budget.assetMemoryBytes,
    },
  };
}

function sameMove(left: Move | null, right: Move | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

self.onmessage = (event: MessageEvent<AnalysisRequest>) => {
  const { state, limits } = event.data;
  if (configuredBackend === "typescript") {
    const result = analyze(state, limits, (progress) => {
      self.postMessage({ type: "progress", result: progress });
    });
    self.postMessage({ type: "done", result });
    return;
  }

  const budget = engineResourceBudget();
  let pool: WorkerState[] = [];
  let poolGeneration = 0;
  let fallbackStarted = false;
  let lastMainDepth = -1;
  let lastVerifiedDepth = -1;
  let lastProgressAt = 0;

  const terminatePool = () => {
    ++poolGeneration;
    for (const workerState of pool) workerState.worker.terminate();
    pool = [];
  };

  const runTypeScriptFallback = (message: string) => {
    terminatePool();
    self.postMessage({ type: "warning", message });
    const result = analyze(state, limits, (progress) => {
      self.postMessage({ type: "progress", result: progress });
    });
    self.postMessage({ type: "done", result });
  };

  const startPool = (workerCount: number) => {
    terminatePool();
    const generation = poolGeneration;
    lastMainDepth = -1;
    lastVerifiedDepth = -1;
    lastProgressAt = 0;
    const specs = workerSpecs(workerCount);
    pool = specs.map((spec) => {
      const worker = new Worker(new URL("./search-worker.ts", import.meta.url), { type: "module" });
      const workerState: WorkerState = {
        worker,
        lanes: spec.lanes,
        latest: new Map(),
        depths: new Map(spec.lanes.map((lane) => [lane, new Map()])),
        done: new Set(),
      };

      const handleMessage = (message: ChildMessage) => {
        if (generation !== poolGeneration) return;
        if (message.type === "error") {
          if (workerCount > 1 && !fallbackStarted) {
            fallbackStarted = true;
            startPool(1);
            return;
          }
          runTypeScriptFallback(
            message.error ?? "webassembly was unavailable, so the typescript engine is running instead.",
          );
          return;
        }
        const lane = message.lane;
        if (!message.result || !lane) return;
        workerState.latest.set(lane, message.result);
        workerState.depths.get(lane)?.set(message.result.depth, message.result);
        if (message.type === "done") workerState.done.add(lane);

        const main = aggregateLane(pool, "main");
        const verifier = aggregateLane(pool, "verify");
        const allDone = pool.every((item) => item.lanes.every((itemLane) => item.done.has(itemLane)));
        const workerMemoryBytes = budget.wasmMemoryBytes / budget.searchWorkers;
        const activeBudget = {
          ...budget,
          searchWorkers: workerCount,
          wasmMemoryBytes: workerMemoryBytes * workerCount,
        };
        const result = mergeHybridResult(main, verifier, activeBudget, allDone, limits);
        if (!result) return;
        const now = performance.now();
        const advanced = result.selectiveDepth > lastMainDepth || result.verifiedDepth > lastVerifiedDepth;
        if (!allDone && !advanced && now - lastProgressAt < 1000) return;
        lastMainDepth = Math.max(lastMainDepth, result.selectiveDepth);
        lastVerifiedDepth = Math.max(lastVerifiedDepth, result.verifiedDepth);
        lastProgressAt = now;

        if (allDone && configuredBackend === "compare" && result.verifiedDepth > 0) {
          const reference = analyze(state, { maxDepth: result.verifiedDepth, timeMs: Infinity });
          if (reference.score !== verifier?.score || !sameMove(reference.bestMove, verifier?.bestMove ?? null)) {
            self.postMessage({
              type: "warning",
              message: "engine comparison found a verifier mismatch; using the typescript reference.",
            });
            self.postMessage({ type: "done", result: reference });
            terminatePool();
            return;
          }
        }
        self.postMessage({ type: allDone ? "done" : "progress", result });
        if (allDone) terminatePool();
      };

      worker.onmessage = (childEvent: MessageEvent<ChildMessage>) => handleMessage(childEvent.data);
      worker.onerror = (errorEvent) => handleMessage({
        type: "error",
        error: errorEvent.message || "engine worker failed",
      });
      worker.postMessage({
        state,
        limits,
        workerIndex: spec.workerIndex,
        workerCount: spec.workerCount,
        lane: spec.lane,
      });
      return workerState;
    });
  };

  try {
    startPool(budget.searchWorkers);
  } catch (error) {
    runTypeScriptFallback(
      error instanceof Error ? error.message : "the engine switched to its compatibility mode.",
    );
  }
};

export {};
