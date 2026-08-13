import { parentPort, workerData } from "node:worker_threads";

import { nativeSearchRootMove } from "./engine-harness.mjs";

parentPort.on("message", ({ id, moveCode, depth, alpha, beta }) => {
  try {
    const result = nativeSearchRootMove(
      workerData.state,
      moveCode,
      depth,
      alpha,
      beta,
    );
    parentPort.postMessage({ id, moveCode, result });
  } catch (error) {
    parentPort.postMessage({
      id,
      error: error instanceof Error ? error.message : `${error}`,
    });
  }
});
