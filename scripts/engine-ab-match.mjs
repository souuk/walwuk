import { performance } from "node:perf_hooks";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

import {
  INITIAL_STATE,
  applyMove,
  generateMoves,
  packPosition,
  winner,
} from "./engine-harness.mjs";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function integerOption(name, fallback, minimum = 0) {
  const value = Number.parseInt(option(name, `${fallback}`), 10);
  return Number.isFinite(value) ? Math.max(minimum, value) : fallback;
}

const games = integerOption("games", 8, 2);
const moveMs = Math.min(15_000, integerOption("move-ms", 25, 1));
const nodeLimit = integerOption("nodes", 0);
const maxDepth = integerOption("max-depth", 20, 1);
const maxPlies = integerOption("max-plies", 120, 1);
const openingOffset = integerOption("opening-offset", 0);
const candidateMask = integerOption("candidate-mask", 0);
const baselineMask = integerOption("baseline-mask", 0);
const output = option("json-output", "");
const moduleUrl = pathToFileURL(path.resolve(option(
  "module",
  "outputs/phase2-experimental/walwuk-engine.mjs",
)));
const createEngine = (await import(moduleUrl.href)).default;

async function create(mask) {
  const engine = await createEngine({
    locateFile: (name) => fileURLToPath(new URL(name, moduleUrl)),
  });
  engine._walwuk_set_experiments(mask);
  return engine;
}

const candidateEngine = await create(candidateMask);
const baselineEngine = await create(baselineMask);

function analyze(engine, state) {
  const started = performance.now();
  const entry = nodeLimit > 0
    ? engine._walwuk_analyze_selective_nodes
    : engine._walwuk_analyze_selective;
  entry(...packPosition(state), maxDepth, nodeLimit > 0 ? nodeLimit : moveMs);
  const elapsedMs = performance.now() - started;
  return {
    ...JSON.parse(engine.UTF8ToString(engine._walwuk_result())),
    elapsedMs,
  };
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
  candidate: { moves: 0, nodes: 0, timeMs: 0, depth: 0 },
  baseline: { moves: 0, nodes: 0, timeMs: 0, depth: 0 },
};
const results = [];
for (let gameIndex = 0; gameIndex < games; ++gameIndex) {
  // Preserve caches within a game, including across consecutive moves, while
  // keeping each color-swapped game an independent statistical observation.
  candidateEngine._walwuk_clear_context();
  baselineEngine._walwuk_clear_context();
  const pair = openingOffset + Math.floor(gameIndex / 2);
  const candidatePlayer = gameIndex % 2;
  let state = openingForPair(pair);
  let ply = 0;
  while (winner(state) === null && ply < maxPlies) {
    const side = state.turn === candidatePlayer ? "candidate" : "baseline";
    const engine = side === "candidate" ? candidateEngine : baselineEngine;
    const analysis = analyze(engine, state);
    if (!analysis.bestMove) {
      throw new Error(`${side} returned no move in game ${gameIndex + 1}, ply ${ply + 1}`);
    }
    const stats = totals[side];
    ++stats.moves;
    stats.nodes += analysis.nodes;
    stats.timeMs += analysis.timeMs;
    stats.depth += analysis.depth;
    state = applyMove(state, analysis.bestMove);
    ++ply;
  }
  const gameWinner = winner(state);
  results.push({
    game: gameIndex + 1,
    opening: pair,
    candidateSide: candidatePlayer === 0 ? "periwinkle" : "blossom",
    winner: gameWinner === null
      ? "unresolved"
      : gameWinner === candidatePlayer ? "candidate" : "baseline",
    plies: ply,
  });
}

const score = {
  candidate: results.filter((game) => game.winner === "candidate").length,
  baseline: results.filter((game) => game.winner === "baseline").length,
  unresolved: results.filter((game) => game.winner === "unresolved").length,
};
const report = {
  generatedAt: new Date().toISOString(),
  settings: { games, moveMs: nodeLimit > 0 ? null : moveMs, nodeLimit, maxDepth, maxPlies, openingOffset },
  candidateMask,
  baselineMask,
  score,
  winsByColor: {
    candidate: {
      periwinkle: results.filter((game) =>
        game.winner === "candidate" && game.candidateSide === "periwinkle").length,
      blossom: results.filter((game) =>
        game.winner === "candidate" && game.candidateSide === "blossom").length,
    },
    baseline: {
      periwinkle: results.filter((game) =>
        game.winner === "baseline" && game.candidateSide === "blossom").length,
      blossom: results.filter((game) =>
        game.winner === "baseline" && game.candidateSide === "periwinkle").length,
    },
  },
  averagePlies: results.reduce((sum, game) => sum + game.plies, 0) / results.length,
  totals: Object.fromEntries(Object.entries(totals).map(([name, stats]) => [name, {
    ...stats,
    averageDepth: stats.depth / Math.max(1, stats.moves),
    nps: Math.round(stats.nodes * 1000 / Math.max(1, stats.timeMs)),
  }])),
  results,
};

console.table(results);
console.table(report.totals);
console.log(
  `candidate ${score.candidate}, baseline ${score.baseline}, ` +
  `unresolved ${score.unresolved}; ${report.averagePlies.toFixed(1)} average ply`,
);
if (output) {
  await mkdir(path.dirname(path.resolve(output)), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
}
