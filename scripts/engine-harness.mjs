import { fileURLToPath } from "node:url";

import createEngine from "../public/engine/walwuk-engine.mjs";
import {
  INITIAL_STATE,
  analyze,
  applyMove,
  formatMove,
  generateMoves,
  isLegalWall,
  legalPawnMoves,
  moveKey,
  shortestPath,
  staticEvaluation,
  winner,
} from "../.engine-test/engine.js";

const moduleUrl = new URL("../public/engine/walwuk-engine.mjs", import.meta.url);

export { formatMove };

export const nativeEngine = await createEngine({
  locateFile: (path) => fileURLToPath(new URL(path, moduleUrl)),
});

export const fixtures = [
  { name: "opening", state: INITIAL_STATE },
  {
    name: "pawn jump",
    state: { pawns: [{ r: 4, c: 4 }, { r: 3, c: 4 }], walls: [], wallsLeft: [10, 10], turn: 0 },
  },
  {
    name: "diagonal jump",
    state: {
      pawns: [{ r: 4, c: 4 }, { r: 3, c: 4 }],
      walls: [{ r: 2, c: 4, o: "h" }],
      wallsLeft: [9, 10],
      turn: 0,
    },
  },
  {
    name: "horizontal overlap pressure",
    state: {
      pawns: [{ r: 6, c: 3 }, { r: 2, c: 5 }],
      walls: [{ r: 4, c: 3, o: "h" }, { r: 1, c: 5, o: "v" }],
      wallsLeft: [9, 9],
      turn: 1,
    },
  },
  {
    name: "crossing pressure",
    state: {
      pawns: [{ r: 7, c: 2 }, { r: 1, c: 6 }],
      walls: [{ r: 3, c: 3, o: "v" }, { r: 5, c: 5, o: "h" }],
      wallsLeft: [9, 9],
      turn: 0,
    },
  },
  {
    name: "channelled routes",
    state: {
      pawns: [{ r: 6, c: 4 }, { r: 2, c: 4 }],
      walls: [
        { r: 5, c: 3, o: "h" },
        { r: 3, c: 4, o: "h" },
        { r: 4, c: 1, o: "v" },
        { r: 2, c: 6, o: "v" },
      ],
      wallsLeft: [8, 8],
      turn: 1,
    },
  },
  {
    name: "low reserves",
    state: {
      pawns: [{ r: 5, c: 1 }, { r: 3, c: 7 }],
      walls: [
        { r: 6, c: 0, o: "h" },
        { r: 1, c: 6, o: "h" },
        { r: 4, c: 3, o: "v" },
        { r: 2, c: 4, o: "v" },
      ],
      wallsLeft: [1, 2],
      turn: 0,
    },
  },
  {
    name: "periwinkle near win",
    state: { pawns: [{ r: 1, c: 4 }, { r: 6, c: 4 }], walls: [], wallsLeft: [10, 10], turn: 0 },
  },
  {
    name: "blossom near win",
    state: { pawns: [{ r: 2, c: 2 }, { r: 7, c: 6 }], walls: [], wallsLeft: [10, 10], turn: 1 },
  },
  {
    name: "transposition rich",
    state: {
      pawns: [{ r: 7, c: 4 }, { r: 1, c: 4 }],
      walls: [{ r: 4, c: 2, o: "h" }, { r: 4, c: 5, o: "h" }],
      wallsLeft: [9, 9],
      turn: 0,
    },
  },
];

export function packPosition(state) {
  let horizontal = 0n;
  let vertical = 0n;
  for (const wall of state.walls) {
    const bit = 1n << BigInt(wall.r * 8 + wall.c);
    if (wall.o === "h") horizontal |= bit;
    else vertical |= bit;
  }
  const lowMask = 0xffff_ffffn;
  return [
    state.pawns[0].r * 9 + state.pawns[0].c,
    state.pawns[1].r * 9 + state.pawns[1].c,
    state.wallsLeft[0],
    state.wallsLeft[1],
    state.turn,
    Number(horizontal & lowMask),
    Number((horizontal >> 32n) & lowMask),
    Number(vertical & lowMask),
    Number((vertical >> 32n) & lowMask),
  ];
}

export function nativeSnapshot(state) {
  nativeEngine._walwuk_snapshot(...packPosition(state));
  return JSON.parse(nativeEngine.UTF8ToString(nativeEngine._walwuk_result()));
}

export function nativeAnalyze(state, maxDepth, timeMs = -1) {
  nativeEngine._walwuk_analyze(...packPosition(state), maxDepth, timeMs);
  return JSON.parse(nativeEngine.UTF8ToString(nativeEngine._walwuk_result()));
}

export function typescriptSnapshot(state) {
  const pawnMoves = legalPawnMoves(state).map(moveKey);
  const moves = generateMoves(state).map(moveKey);
  const legalWalls = [];
  for (const orientation of ["h", "v"]) {
    for (let row = 0; row < 8; ++row) {
      for (let column = 0; column < 8; ++column) {
        const wall = { r: row, c: column, o: orientation };
        if (isLegalWall(state, wall)) legalWalls.push(`${orientation}${row}${column}`);
      }
    }
  }
  const evaluation = staticEvaluation(state);
  return {
    distances: [shortestPath(state, 0).distance, shortestPath(state, 1).distance],
    evaluation: Object.is(evaluation, -0) ? 0 : evaluation,
    pawnMoves,
    moves,
    legalWalls,
  };
}

export function typescriptAnalyze(state, maxDepth, timeMs = Infinity) {
  return analyze(state, { maxDepth, timeMs });
}

export function generateRandomPositions(count) {
  const positions = [];
  let state = structuredClone(INITIAL_STATE);
  let randomState = 0x6d2b79f5;
  const random = () => {
    randomState ^= randomState << 13;
    randomState ^= randomState >>> 17;
    randomState ^= randomState << 5;
    return randomState >>> 0;
  };
  while (positions.length < count) {
    if (winner(state) !== null) state = structuredClone(INITIAL_STATE);
    const moves = generateMoves(state);
    if (moves.length === 0) state = structuredClone(INITIAL_STATE);
    else state = applyMove(state, moves[random() % moves.length]);
    positions.push(structuredClone(state));
    if ((random() & 31) === 0) state = structuredClone(INITIAL_STATE);
  }
  return positions;
}

export function comparableResult(result) {
  return {
    bestMove: result.bestMove,
    score: Object.is(result.score, -0) ? 0 : result.score,
    depth: result.depth,
    pv: result.pv,
  };
}
