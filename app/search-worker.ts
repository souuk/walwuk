/// <reference lib="webworker" />

import type { AnalysisLimits, GameState } from "./engine";
import { analyzeWasmSelectiveSplit, analyzeWasmSplit } from "./wasm-engine";

type SearchLane = "main" | "verify" | "hybrid";

interface SearchRequest {
  state: GameState;
  limits: AnalysisLimits;
  workerIndex: number;
  workerCount: number;
  lane: SearchLane;
}

self.onmessage = async (event: MessageEvent<SearchRequest>) => {
  const { state, limits, workerIndex, workerCount, lane } = event.data;
  try {
    const run = async (searchLane: "main" | "verify", laneLimits: AnalysisLimits) => {
      const analyzeLane = searchLane === "main"
        ? analyzeWasmSelectiveSplit
        : analyzeWasmSplit;
      const result = await analyzeLane(
        state,
        laneLimits,
        workerIndex,
        workerCount,
        (progress) => self.postMessage({ type: "progress", lane: searchLane, result: progress }),
      );
      self.postMessage({ type: "done", lane: searchLane, result });
    };

    if (lane === "hybrid") {
      if (Number.isFinite(limits.timeMs)) {
        const verifierTime = Math.max(25, Math.floor(limits.timeMs * 0.15));
        const mainTime = Math.max(25, Math.floor(limits.timeMs * 0.6));
        await run("verify", { ...limits, timeMs: verifierTime });
        await new Promise((resolve) => setTimeout(resolve, Math.floor(limits.timeMs * 0.25)));
        await run("main", { ...limits, timeMs: mainTime });
      } else {
        await run("verify", { ...limits, maxDepth: Math.min(5, limits.maxDepth), timeMs: 1000 });
        await run("main", limits);
      }
    } else {
      await run(lane, limits);
    }
  } catch (error) {
    self.postMessage({
      type: "error",
      lane,
      error: error instanceof Error ? error.message : "engine worker failed",
    });
  }
};

export {};
