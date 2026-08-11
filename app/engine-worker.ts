/// <reference lib="webworker" />
/// <reference types="vite/client" />

import {
  analyze,
  type AnalysisLimits,
  type AnalysisResult,
  type GameState,
  type Move,
} from "./engine";

type BackendSelection = "typescript" | "wasm" | "compare";

interface AnalysisRequest {
  state: GameState;
  limits: AnalysisLimits;
}

interface ChildMessage {
  type: "progress" | "done" | "error";
  result?: AnalysisResult;
  error?: string;
}

interface WorkerState {
  worker: Worker;
  latest: AnalysisResult | null;
  depths: Map<number, AnalysisResult>;
  done: boolean;
}

const MAX_ENGINE_WORKERS = 12;
const configuredBackend = (import.meta.env.VITE_ENGINE_BACKEND ?? "wasm") as BackendSelection;

function availableWorkerCount(): number {
  const logicalProcessors = navigator.hardwareConcurrency || 2;
  return Math.max(1, Math.min(MAX_ENGINE_WORKERS, logicalProcessors - 1 || 1));
}

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

function aggregate(
  states: WorkerState[],
  depth: number,
  allDone: boolean,
  limits: AnalysisLimits,
): AnalysisResult | null {
  const completed = states.map((state) => state.depths.get(depth));
  if (completed.some((result) => !result)) return null;
  const depthResults = completed as AnalysisResult[];
  const best = chooseBest(depthResults) ?? depthResults[0];
  const live = states.map((state) => state.latest ?? state.depths.get(depth));
  const nodes = live.reduce((total, result) => total + (result?.nodes ?? 0), 0);
  const ttHits = live.reduce((total, result) => total + (result?.ttHits ?? 0), 0);
  const timeMs = Math.max(...live.map((result) => result?.timeMs ?? 0), 1);
  return {
    ...best,
    depth,
    nodes,
    nps: Math.round(nodes * 1000 / timeMs),
    timeMs,
    ttHits,
    stopReason: allDone
      ? (depth >= limits.maxDepth ? "depth" : "time")
      : best.stopReason,
    backend: "wasm",
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

  let pool: WorkerState[] = [];
  let poolGeneration = 0;
  let fallbackStarted = false;
  let lastDepth = -1;
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
    lastDepth = -1;
    lastProgressAt = 0;
    pool = Array.from({ length: workerCount }, (_, workerIndex) => {
      const worker = new Worker(new URL("./search-worker.ts", import.meta.url), {
        type: "module",
      });
      const workerState: WorkerState = {
        worker,
        latest: null,
        depths: new Map(),
        done: false,
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
        if (!message.result) return;
        workerState.latest = message.result;
        workerState.depths.set(message.result.depth, message.result);
        workerState.done = message.type === "done";

        const commonDepth = Math.min(...pool.map((item) => item.latest?.depth ?? -1));
        if (commonDepth < 0) return;
        const allDone = pool.every((item) => item.done);
        const now = performance.now();
        const advanced = commonDepth > lastDepth;
        if (!allDone && !advanced && now - lastProgressAt < 1000) return;
        const result = aggregate(pool, commonDepth, allDone, limits);
        if (!result) return;

        lastDepth = Math.max(lastDepth, commonDepth);
        lastProgressAt = now;
        if (allDone && configuredBackend === "compare") {
          const reference = analyze(state, { ...limits, timeMs: Infinity });
          if (
            reference.depth === result.depth &&
            (reference.score !== result.score || !sameMove(reference.bestMove, result.bestMove))
          ) {
            self.postMessage({
              type: "warning",
              message: "engine comparison found a result mismatch; using the typescript reference.",
            });
            self.postMessage({ type: "done", result: reference });
            terminatePool();
            return;
          }
        }
        self.postMessage({ type: allDone ? "done" : "progress", result });
        if (allDone) terminatePool();
      };

      worker.onmessage = (childEvent: MessageEvent<ChildMessage>) => {
        handleMessage(childEvent.data);
      };
      worker.onerror = (errorEvent) => {
        handleMessage({
          type: "error",
          error: errorEvent.message || "engine worker failed",
        });
      };
      worker.postMessage({ state, limits, workerIndex, workerCount });
      return workerState;
    });
  };

  try {
    startPool(availableWorkerCount());
  } catch (error) {
    runTypeScriptFallback(
      error instanceof Error ? error.message : "the engine switched to its compatibility mode.",
    );
  }
};

export {};
