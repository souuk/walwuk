/// <reference lib="webworker" />

import type { AnalysisLimits, GameState } from "./engine";
import {
  analyzeWasmSelectiveSplit,
  analyzeWasmSplit,
  clearWasmContext,
  loadWasmPolicy,
  loadWasmValue,
} from "./wasm-engine";

type SearchLane = "main" | "verify" | "hybrid";

interface SearchRequest {
  type?: "start" | "clear" | "load-policy" | "load-value";
  epochId?: number;
  state: GameState;
  limits: AnalysisLimits;
  workerIndex: number;
  workerCount: number;
  lane: SearchLane;
  bytes?: ArrayBuffer;
}

self.onmessage = async (event: MessageEvent<SearchRequest>) => {
  if (event.data.type === "load-value" && event.data.bytes) {
    const loaded = await loadWasmValue(new Uint8Array(event.data.bytes));
    self.postMessage({ type: "value", loaded });
    return;
  }
  if (event.data.type === "load-policy" && event.data.bytes) {
    const loaded = await loadWasmPolicy(new Uint8Array(event.data.bytes));
    self.postMessage({ type: "policy", loaded });
    return;
  }
  if (event.data.type === "clear") {
    await clearWasmContext();
    return;
  }
  const { state, limits, workerIndex, workerCount, lane } = event.data;
  const epochId = event.data.epochId;
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
        (progress) => self.postMessage({ type: "progress", epochId, lane: searchLane, result: progress }),
      );
      self.postMessage({ type: "done", epochId, lane: searchLane, result });
    };

    if (lane === "hybrid") {
      if (Number.isFinite(limits.timeMs)) {
        const verifierTime = Math.max(25, Math.floor(limits.timeMs * 0.2));
        const mainTime = Math.max(25, limits.timeMs - verifierTime);
        await run("verify", { ...limits, timeMs: verifierTime });
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
      epochId,
      lane,
      error: error instanceof Error ? error.message : "engine worker failed",
    });
  }
};

export {};
