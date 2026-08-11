/// <reference lib="webworker" />

import type { AnalysisLimits, GameState } from "./engine";
import { analyzeWasmSelectiveSplit } from "./wasm-engine";

interface SearchRequest {
  state: GameState;
  limits: AnalysisLimits;
  workerIndex: number;
  workerCount: number;
}

self.onmessage = async (event: MessageEvent<SearchRequest>) => {
  const { state, limits, workerIndex, workerCount } = event.data;
  try {
    const result = await analyzeWasmSelectiveSplit(
      state,
      limits,
      workerIndex,
      workerCount,
      (progress) => self.postMessage({ type: "progress", result: progress }),
    );
    self.postMessage({ type: "done", result });
  } catch (error) {
    self.postMessage({
      type: "error",
      error: error instanceof Error ? error.message : "engine worker failed",
    });
  }
};

export {};
