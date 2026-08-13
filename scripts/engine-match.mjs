import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

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
const challenger = option("challenger", "hybrid");
const challengerMask = Math.max(
  0,
  Number.parseInt(option("challenger-mask", "0"), 10),
);
if (!new Set(["hybrid", "selective"]).has(challenger)) {
  throw new Error("--challenger must be hybrid or selective");
}
const openingOffset = Math.max(
  0,
  Number.parseInt(option("opening-offset", "0"), 10),
);
const jsonOutput = option("json-output", "");
const requestedMoveTimeMs = Math.min(
  15_000,
  Math.max(1, Number.parseInt(option("move-ms", "5000"), 10)),
);
const moveTimeMs = requestedMoveTimeMs >= 5_000
  ? requestedMoveTimeMs - 100
  : requestedMoveTimeMs;
const initialClockMs = Math.max(0, Number.parseInt(option("clock-ms", "0"), 10));
const incrementMs = Math.max(0, Number.parseInt(option("increment-ms", "1000"), 10));
const maxDepth = Math.max(1, Number.parseInt(option("max-depth", "15"), 10));
const maxPlies = Math.max(1, Number.parseInt(option("max-plies", "120"), 10));
const verbose = process.argv.includes("--verbose");

const challengerModulePath = option("module", "");
const moduleUrl = challengerModulePath
  ? pathToFileURL(path.resolve(challengerModulePath))
  : new URL("../public/engine/walwuk-engine.mjs", import.meta.url);
const wasmUrl = new URL("walwuk-engine.wasm", moduleUrl);
const createEngine = (await import(moduleUrl.href)).default;
const engineSha256 = createHash("sha256")
  .update(await readFile(wasmUrl))
  .digest("hex");
const selectiveEngine = await createEngine({
  locateFile: (path) => fileURLToPath(new URL(path, moduleUrl)),
});
exhaustiveEngine._walwuk_set_experiments(0);
selectiveEngine._walwuk_set_experiments(challengerMask);

function runNative(engine, style, state, timeLimitMs) {
  const started = performance.now();
  if (style === "selective") {
    engine._walwuk_analyze_selective(
      ...packPosition(state),
      maxDepth,
      timeLimitMs,
    );
  } else {
    engine._walwuk_analyze(...packPosition(state), maxDepth, timeLimitMs);
  }
  const elapsedMs = performance.now() - started;
  const result = JSON.parse(engine.UTF8ToString(engine._walwuk_result()));
  return { ...result, elapsedMs };
}

function analyze(engine, style, state, availableTimeMs = moveTimeMs) {
  if (style !== "hybrid") {
    return runNative(engine, style, state, availableTimeMs);
  }

  const verifierTimeMs = Math.max(1, Math.floor(availableTimeMs * 0.25));
  const mainTimeMs = Math.max(1, availableTimeMs - verifierTimeMs);
  const verified = runNative(engine, "exhaustive", state, verifierTimeMs);
  const main = runNative(engine, "selective", state, mainTimeMs);
  const agrees = JSON.stringify(main.bestMove) === JSON.stringify(verified.bestMove);
  return {
    ...main,
    bestMove: agrees ? main.bestMove : verified.bestMove,
    score: agrees ? main.score : verified.score,
    verifiedDepth: verified.depth,
    verifierNodes: verified.nodes,
    confidence: verified.depth > 0 ? "verified" : "provisional",
    nodes: main.nodes + verified.nodes,
    timeMs: main.timeMs + verified.timeMs,
    elapsedMs: main.elapsedMs + verified.elapsedMs,
  };
}

function clockAllocation(state, remainingMs) {
  const ownWalls = state.wallsLeft[state.turn];
  const totalWalls = state.wallsLeft[0] + state.wallsLeft[1];
  const reserveMs = Math.min(10_000, Math.max(2_000, remainingMs * 0.08));
  const usableMs = Math.max(1, remainingMs - reserveMs);
  const expectedTurns = totalWalls === 0 ? 16 : 12 + ownWalls;
  const planned = usableMs / expectedTurns + incrementMs * 0.75;
  return Math.max(25, Math.min(15_000, Math.floor(planned), Math.floor(usableMs)));
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
  challenger: { moves: 0, nodes: 0, timeMs: 0, depth: 0, maxDepth: 0 },
};
const results = [];

for (let gameIndex = 0; gameIndex < gameCount; ++gameIndex) {
  // Each color-swapped game is an independent sample. Reuse remains enabled
  // between moves inside the game, matching Pages and walper behavior.
  exhaustiveEngine._walwuk_clear_context();
  selectiveEngine._walwuk_clear_context();
  const pairIndex = openingOffset + Math.floor(gameIndex / 2);
  let state = openingForPair(pairIndex);
  const challengerPlayer = gameIndex % 2;
  let ply = 0;
  let maxMoveElapsedMs = 0;
  const clocks = [initialClockMs, initialClockMs];
  let timeoutWinner = null;
  const moveLog = [];

  while (winner(state) === null && ply < maxPlies) {
    const style = state.turn === challengerPlayer ? challenger : "exhaustive";
    const engine = style === "exhaustive" ? exhaustiveEngine : selectiveEngine;
    const movingPlayer = state.turn;
    const allocatedMs = initialClockMs > 0
      ? clockAllocation(state, clocks[movingPlayer])
      : moveTimeMs;
    const result = analyze(engine, style, state, allocatedMs);
    if (!result.bestMove) {
      throw new Error(`${style} returned no move in game ${gameIndex + 1}, ply ${ply + 1}`);
    }
    maxMoveElapsedMs = Math.max(maxMoveElapsedMs, result.elapsedMs);
    if (initialClockMs > 0) {
      clocks[movingPlayer] -= result.elapsedMs;
      if (clocks[movingPlayer] <= 0) {
        timeoutWinner = 1 - movingPlayer;
        break;
      }
      clocks[movingPlayer] += incrementMs;
    }
    const stats = totals[style === "exhaustive" ? "exhaustive" : "challenger"];
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
    moveLog.push({
      ply: ply + 1,
      engine: style,
      move: result.bestMove,
      score: result.score,
      depth: result.depth,
      verifiedDepth: result.verifiedDepth ?? 0,
      nodes: result.nodes,
      timeMs: result.timeMs,
      allocatedMs,
      clockMs: initialClockMs > 0 ? Math.round(clocks[movingPlayer]) : null,
    });
    state = applyMove(state, result.bestMove);
    ++ply;
  }

  const gameWinner = timeoutWinner ?? winner(state);
  results.push({
    game: gameIndex + 1,
    opening: pairIndex,
    challengerSide: challengerPlayer === 0 ? "periwinkle" : "blossom",
    winner: gameWinner === null
      ? "unresolved"
      : gameWinner === challengerPlayer ? "challenger" : "exhaustive",
    plies: ply,
    maxMoveMs: Math.round(maxMoveElapsedMs),
    endedBy: timeoutWinner !== null
      ? "clock"
      : winner(state) !== null ? "goal" : "ply-limit",
    clocks: initialClockMs > 0 ? clocks.map(Math.round) : null,
    moves: moveLog,
  });
  console.log(
    `game ${gameIndex + 1}/${gameCount}: ${results.at(-1).winner} in ${ply} ply ` +
    `(${challenger} as ${results.at(-1).challengerSide})`,
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

const challengerWins = results.filter(({ winner: value }) => value === "challenger").length;
const exhaustiveWins = results.filter(({ winner: value }) => value === "exhaustive").length;
const unresolved = results.length - challengerWins - exhaustiveWins;
console.log(
  `score: ${challenger} ${challengerWins}, exhaustive ${exhaustiveWins}, unresolved ${unresolved}; ` +
  (initialClockMs > 0
    ? `${initialClockMs / 1000}+${incrementMs / 1000} clock, 15 s move cap`
    : `${moveTimeMs} ms native search budget per move ` +
      `(${requestedMoveTimeMs} ms wall-clock limit)`),
);

if (jsonOutput) {
  const summary = {
    challenger,
    challengerMask,
    engineSha256,
    requestedMoveTimeMs,
    searchBudgetMs: moveTimeMs,
    initialClockMs,
    incrementMs,
    maxDepth,
    maxPlies,
    openingOffset,
    results,
    totals,
    score: {
      challenger: challengerWins,
      exhaustive: exhaustiveWins,
      unresolved,
    },
  };
  await mkdir(path.dirname(path.resolve(jsonOutput)), { recursive: true });
  await writeFile(jsonOutput, `${JSON.stringify(summary, null, 2)}\n`);
}
