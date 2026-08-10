/// <reference lib="webworker" />

import { analyze, type AnalysisLimits, type GameState } from "./engine";

self.onmessage = (event: MessageEvent<{ state: GameState; limits: AnalysisLimits }>) => {
  const result = analyze(event.data.state, event.data.limits, (progress) => {
    self.postMessage({ type: "progress", result: progress });
  });
  self.postMessage({ type: "done", result });
};

export {};
