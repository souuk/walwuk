/// <reference lib="webworker" />
/// <reference types="vite/client" />

import { analyze, type AnalysisLimits, type GameState } from "./engine";
import { analyzeWasm } from "./wasm-engine";

type BackendSelection = "typescript" | "wasm" | "compare";

const configuredBackend = (import.meta.env.VITE_ENGINE_BACKEND ?? "wasm") as BackendSelection;

const postProgress = (result: ReturnType<typeof analyze>) => {
  self.postMessage({ type: "progress", result });
};

const sameMove = (left: ReturnType<typeof analyze>["bestMove"], right: ReturnType<typeof analyze>["bestMove"]) =>
  JSON.stringify(left) === JSON.stringify(right);

self.onmessage = async (event: MessageEvent<{ state: GameState; limits: AnalysisLimits }>) => {
  const { state, limits } = event.data;
  if (configuredBackend === "typescript") {
    const result = analyze(state, limits, postProgress);
    self.postMessage({ type: "done", result });
    return;
  }

  try {
    const result = await analyzeWasm(state, limits, postProgress);
    if (configuredBackend === "compare") {
      const reference = analyze(state, limits);
      if (reference.depth === result.depth &&
          (reference.score !== result.score || !sameMove(reference.bestMove, result.bestMove))) {
        self.postMessage({
          type: "warning",
          message: "engine comparison found a result mismatch; using the typescript reference.",
        });
        self.postMessage({ type: "done", result: reference });
        return;
      }
    }
    self.postMessage({ type: "done", result });
  } catch {
    self.postMessage({
      type: "warning",
      message: "webassembly was unavailable, so the typescript engine is running instead.",
    });
    const result = analyze(state, limits, postProgress);
    self.postMessage({ type: "done", result });
  }
};

export {};
