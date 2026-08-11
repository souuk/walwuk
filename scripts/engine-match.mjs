import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import createEngine from "../public/engine/walwuk-engine.mjs";
import {
  INITIAL_STATE,
  applyMove,
  formatMove,
  generateMoves,
  nativeEngine as exhaustiveEngine,
  packPosition,
  winner,
} from "./engine-harness.mjs";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const gameCount = Math.max(1, Number.parseInt(option("games", "8"), 10));
const requestedMoveTimeMs = Math.min(
  15_000,
  Math.max(1, Number.parseInt(option("move-ms", "5000"), 10)),
);
const moveTimeMs = requestedMoveTimeMs >= 5_000
  ? requestedMoveTimeMs - 100
  : requestedMoveTimeMs;
const maxDepth = Math.max(1, Number.parseInt(option("max-depth", "15"), 10));
const maxPlies = Math.max(1, Number.parseInt(option("max-plies", "120"), 10));
const verbose = process.argv.includes("--verbose");

const moduleUrl = new URL("../public/engine/walwuk-engine.mjs", import.meta.url);
const selectiveEngine = await createEngine({
  locateFile: (path) => fileURLToPath(new URL(path, moduleUrl)),
});

function analyze(engine, style, state) {
  const started = performance.now();
  if (style === "selective") {
    engine._walwuk_analyze_selective(
      ...packPosition(state),
      maxDepth,
      moveTimeMs,
    );
  } else {
    engine._walwuk_analyze(...packPosition(state), maxDepth, moveTimeMs);
  }
  const elapsedMs = performance.now() - started;
  const result = JSON.parse(engine.UTF8ToString(engine._walwuk_result()));
  return { ...result, elapsedMs };
}

function randomGenerator(seed) {
  let state = (seed ^ 0x9e3779b9) >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function openingForPair(pairIndex) {
  let state = structuredClone(INITIAL_STATE);
  if (pairIndex === 0) return state;
  const random = randomGenerator(pairIndex);
  const openingPlies = 2 * (1 + ((pairIndex - 1) % 3));
  for (let ply = 0; ply < openingPlies && winner(state) === null; ++ply) {
    const moves = generateMoves(state);
    const pawnMoves = moves.filter((move) => move.kind === "pawn");
    const wallMoves = moves.filter((move) => move.kind === "wall");
    const candidates = random() % 5 < 3 || wallMoves.length === 0
      ? pawnMoves
      : wallMoves;
    state = applyMove(state, candidates[random() % candidates.length]);
  }
  return state;
}

const totals = {
  exhaustive: { moves: 0, nodes: 0, timeMs: 0, depth: 0, maxDepth: 0 },
  selective: { moves: 0, nodes: 0, timeMs: 0, depth: 0, maxDepth: 0 },
};
const results = [];

for (let gameIndex = 0; gameIndex < gameCount; ++gameIndex) {
  const pairIndex = Math.floor(gameIndex / 2);
  let state = openingForPair(pairIndex);
  const selectivePlayer = gameIndex % 2;
  let ply = 0;
  let maxMoveElapsedMs = 0;

  while (winner(state) === null && ply < maxPlies) {
    const style = state.turn === selectivePlayer ? "selective" : "exhaustive";
    const engine = style === "selective" ? selectiveEngine : exhaustiveEngine;
    const result = analyze(engine, style, state);
    if (!result.bestMove) {
      throw new Error(`${style} returned no move in game ${gameIndex + 1}, ply ${ply + 1}`);
    }
    maxMoveElapsedMs = Math.max(maxMoveElapsedMs, result.elapsedMs);
    const stats = totals[style];
    ++stats.moves;
    stats.nodes += result.nodes;
    stats.timeMs += result.timeMs;
    stats.depth += result.depth;
    stats.maxDepth = Math.max(stats.maxDepth, result.depth);
    if (verbose) {
      console.log(
        `game ${gameIndex + 1} ply ${ply + 1}: ${style} ${formatMove(result.bestMove)} ` +
        `d${result.depth} ${result.nodes.toLocaleString()} nodes ${result.timeMs} ms`,
      );
    }
    state = applyMove(state, result.bestMove);
    ++ply;
  }

  const gameWinner = winner(state);
  results.push({
    game: gameIndex + 1,
    opening: pairIndex,
    selectiveSide: selectivePlayer === 0 ? "periwinkle" : "blossom",
    winner: gameWinner === null
      ? "unresolved"
      : gameWinner === selectivePlayer ? "selective" : "exhaustive",
    plies: ply,
    maxMoveMs: Math.round(maxMoveElapsedMs),
  });
  console.log(
    `game ${gameIndex + 1}/${gameCount}: ${results.at(-1).winner} in ${ply} ply ` +
    `(selective as ${results.at(-1).selectiveSide})`,
  );
}

console.table(results);
console.table(Object.entries(totals).map(([engine, stats]) => ({
  engine,
  moves: stats.moves,
  averageDepth: Number((stats.depth / Math.max(1, stats.moves)).toFixed(2)),
  maximumDepth: stats.maxDepth,
  nodes: stats.nodes,
  nps: Math.round(stats.nodes * 1000 / Math.max(1, stats.timeMs)),
})));

const selectiveWins = results.filter(({ winner: value }) => value === "selective").length;
const exhaustiveWins = results.filter(({ winner: value }) => value === "exhaustive").length;
const unresolved = results.length - selectiveWins - exhaustiveWins;
console.log(
  `score: selective ${selectiveWins}, exhaustive ${exhaustiveWins}, unresolved ${unresolved}; ` +
  `${moveTimeMs} ms native search budget per move ` +
  `(${requestedMoveTimeMs} ms wall-clock limit)`,
);
