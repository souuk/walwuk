import { parentPort, workerData } from "node:worker_threads";

import { nativeAnalyze, nativeSearchRootMove } from "./engine-harness.mjs";

const INFINITY = 1_000_000;

if (workerData.warmDepth > 0) nativeAnalyze(workerData.state, workerData.warmDepth);

// Signal readiness after the persistent worker has loaded its Wasm instance.
parentPort.postMessage({ ready: true });

parentPort.on("message", ({ id, moves, depth, alpha, fullWindow = false, research = true }) => {
  try {
    let localAlpha = alpha;
    let nodes = 0;
    let researches = 0;
    const results = [];
    for (const moveCode of moves) {
      let result = nativeSearchRootMove(
        workerData.state,
        moveCode,
        depth,
        fullWindow ? -INFINITY : localAlpha,
        fullWindow ? INFINITY : localAlpha + 1,
      );
      nodes += result.nodes;
      if (!fullWindow && research && result.score >= localAlpha) {
        ++researches;
        result = nativeSearchRootMove(
          workerData.state,
          moveCode,
          depth,
          -INFINITY,
          INFINITY,
        );
        nodes += result.nodes;
        localAlpha = Math.max(localAlpha, result.score);
      }
      results.push({ moveCode, result });
    }
    parentPort.postMessage({ id, nodes, researches, results });
  } catch (error) {
    parentPort.postMessage({
      id,
      error: error instanceof Error ? error.message : `${error}`,
    });
  }
});
