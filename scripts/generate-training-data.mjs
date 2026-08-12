import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";

import {
  generateRandomPositions,
  nativeAnalyze,
  nativeSnapshot,
} from "./engine-harness.mjs";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const output = option("output", "");
if (!output) throw new Error("pass --output <file.jsonl>");
const positionCount = Math.max(1, Number.parseInt(option("positions", "1000"), 10));
const maxDepth = Math.max(1, Number.parseInt(option("max-depth", "10"), 10));
const timeMs = Math.min(15_000, Math.max(25, Number.parseInt(option("time-ms", "1000"), 10)));
const positions = generateRandomPositions(positionCount);
const wasmBytes = await readFile(
  new URL("../public/engine/walwuk-engine.wasm", import.meta.url),
);
const engineSha256 = createHash("sha256").update(wasmBytes).digest("hex");
await mkdir(path.dirname(path.resolve(output)), { recursive: true });
const outputFile = await open(output, "w");

try {
  for (let index = 0; index < positions.length; ++index) {
    const state = positions[index];
    const snapshot = nativeSnapshot(state);
    const label = nativeAnalyze(state, maxDepth, timeMs);
    await outputFile.write(`${JSON.stringify({
      version: 1,
      engineSha256,
      index,
      state,
      features: {
        distances: snapshot.distances,
        evaluation: snapshot.evaluation,
        wallsLeft: state.wallsLeft,
        turn: state.turn,
        legalMoveCount: snapshot.moves.length,
        legalPawnMoveCount: snapshot.pawnMoves.length,
      },
      label: {
        bestMove: label.bestMove,
        score: label.score,
        depth: label.depth,
        pv: label.pv,
        nodes: label.nodes,
      },
    })}\n`);
    if ((index + 1) % 100 === 0) {
      console.log(`labeled ${index + 1}/${positionCount}`);
    }
  }
} finally {
  await outputFile.close();
}

console.log(`wrote ${positionCount} labeled positions to ${output}`);
