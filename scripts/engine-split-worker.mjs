import { fileURLToPath } from "node:url";
import { parentPort, workerData } from "node:worker_threads";

import createEngine from "../public/engine/walwuk-engine.mjs";

const moduleUrl = new URL("../public/engine/walwuk-engine.mjs", import.meta.url);
const engine = await createEngine({
  locateFile: (path) => fileURLToPath(new URL(path, moduleUrl)),
});

engine._walwuk_analyze_split(
  ...workerData.position,
  workerData.maxDepth,
  workerData.timeMs,
  workerData.rootIndex,
  workerData.rootCount,
);
parentPort.postMessage(
  JSON.parse(engine.UTF8ToString(engine._walwuk_result())),
);
