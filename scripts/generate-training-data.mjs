import { createHash } from "node:crypto";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  iterateRandomPositions,
  nativeAnalyze,
  nativeBeginSearch,
  nativeRootMoves,
  nativeSearchRootMove,
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
const seed = Number.parseInt(option("seed", "1831565813"), 10) >>> 0;
const candidateLimit = Math.max(0, Number.parseInt(option("candidate-limit", "16"), 10));
const candidateDepth = Math.max(
  1,
  Math.min(maxDepth, Number.parseInt(option("candidate-depth", "4"), 10)),
);
const maximumBytes = Math.min(
  Math.floor(22.5 * 1024 ** 3),
  Math.max(1, Number.parseInt(option("max-bytes", `${Math.floor(22.5 * 1024 ** 3)}`), 10)),
);
const wasmBytes = await readFile(
  new URL("../public/engine/walwuk-engine.wasm", import.meta.url),
);
const engineSha256 = createHash("sha256").update(wasmBytes).digest("hex");
await mkdir(path.dirname(path.resolve(output)), { recursive: true });
const checkpointPath = option("checkpoint", `${output}.checkpoint.json`);
let checkpoint = null;
try {
  checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const settings = { seed, maxDepth, timeMs, candidateLimit, candidateDepth };
if (checkpoint &&
    (checkpoint.engineSha256 !== engineSha256 ||
     JSON.stringify(checkpoint.settings) !== JSON.stringify(settings))) {
  throw new Error("training checkpoint does not match the engine or generation settings");
}
const resumeIndex = checkpoint?.nextIndex ?? 0;
if (checkpoint) {
  const recoveryFile = await open(output, "r+");
  try {
    await recoveryFile.truncate(checkpoint.bytes);
  } finally {
    await recoveryFile.close();
  }
}
const outputFile = await open(output, checkpoint ? "a" : "w");
let nextCheckpointAt = Date.now() + 10 * 60 * 1000;
let completed = resumeIndex;
let stopRequested = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => { stopRequested = true; });
}

async function saveCheckpoint() {
  await outputFile.sync();
  const size = (await outputFile.stat()).size;
  checkpoint = {
    version: 1,
    engineSha256,
    settings,
    nextIndex: completed,
    bytes: size,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
  nextCheckpointAt = Date.now() + 10 * 60 * 1000;
  return size;
}

function moveCode(move) {
  if (!move) return -1;
  if (move.kind === "pawn") return move.to.r * 9 + move.to.c;
  return 0x8000 |
    (move.wall.o === "v" ? 0x4000 : 0) |
    (move.wall.r * 8 + move.wall.c);
}

function sampleCandidates(rootMoves, bestMove, limit, positionIndex) {
  if (limit <= 0) return [];
  const selected = new Set();
  const best = moveCode(bestMove);
  if (rootMoves.includes(best)) selected.add(best);
  const groups = [
    rootMoves.filter((move) => (move & 0x8000) === 0),
    rootMoves.filter((move) => (move & 0xC000) === 0x8000),
    rootMoves.filter((move) => (move & 0xC000) === 0xC000),
  ];
  for (const pawn of groups[0]) {
    if (selected.size >= limit) break;
    selected.add(pawn);
  }
  let round = 0;
  while (selected.size < Math.min(limit, rootMoves.length)) {
    const before = selected.size;
    for (const group of groups.slice(1)) {
      if (!group.length || selected.size >= limit) continue;
      const offset = (positionIndex * 29 + round * 17) % group.length;
      for (let probe = 0; probe < group.length; ++probe) {
        const candidate = group[(offset + probe) % group.length];
        if (selected.has(candidate)) continue;
        selected.add(candidate);
        break;
      }
    }
    if (selected.size === before) break;
    ++round;
  }
  return [...selected];
}

try {
  let index = 0;
  for (const state of iterateRandomPositions(positionCount, seed)) {
    if (index < resumeIndex) {
      ++index;
      continue;
    }
    const snapshot = nativeSnapshot(state);
    if (!Array.isArray(snapshot.pawnMoveCounts) ||
        snapshot.pawnMoveCounts.length !== 2) {
      throw new Error(
        "engine artifact is incompatible with training schema 3: rebuild it before generating data",
      );
    }
    const label = nativeAnalyze(state, maxDepth, timeMs);
    const rootMoves = candidateLimit > 0 ? nativeRootMoves(state) : [];
    const sampledMoves = sampleCandidates(
      rootMoves, label.bestMove, candidateLimit, index,
    );
    if (sampledMoves.length > 0) nativeBeginSearch();
    const candidates = sampledMoves.map((moveCode) => {
      const result = nativeSearchRootMove(state, moveCode, candidateDepth);
      return {
        moveCode,
        moveClass: (moveCode & 0x8000) === 0
          ? "pawn"
          : (moveCode & 0x4000) === 0 ? "horizontal-wall" : "vertical-wall",
        score: result.score,
        nodes: result.nodes,
        pv: result.pv,
      };
    });
    await outputFile.write(`${JSON.stringify({
      version: 3,
      engineSha256,
      seed,
      index,
      state,
      features: {
        distances: snapshot.distances,
        evaluation: snapshot.evaluation,
        wallsLeft: state.wallsLeft,
        turn: state.turn,
        legalMoveCount: snapshot.moves.length,
        legalPawnMoveCount: snapshot.pawnMoves.length,
        pawnMoveCounts: snapshot.pawnMoveCounts,
      },
      label: {
        bestMove: label.bestMove,
        score: label.score,
        depth: label.depth,
        pv: label.pv,
        nodes: label.nodes,
      },
      candidates: {
        depth: candidateDepth,
        total: rootMoves.length,
        sampling: "best-pawn-stratified-walls-v3",
        sampled: candidates,
      },
    })}\n`);
    ++index;
    completed = index;
    if (index % 100 === 0 || Date.now() >= nextCheckpointAt) {
      console.log(`labeled ${index}/${positionCount}`);
      const size = await saveCheckpoint();
      if (size >= maximumBytes) {
        console.log(`stopping at ${size} bytes (configured data ceiling)`);
        break;
      }
    }
    if (stopRequested) break;
  }
} finally {
  try {
    await saveCheckpoint();
  } finally {
    await outputFile.close();
  }
}

console.log(`wrote labeled positions to ${output}`);
