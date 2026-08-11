import assert from "node:assert/strict";
import test from "node:test";

await import("../src/core.js");

const { formatEvaluation, formatMove, stateSignature, toEngineState } = globalThis.WalperCore;

const scan = {
  pawns: {
    p1: { x: 4, y: 2 },
    p2: { x: 5, y: 7 },
  },
  walls: [
    { x: 3, y: 4, o: "h" },
    { x: 6, y: 1, o: "v" },
  ],
  wallsRemaining: { p1: 8, p2: 7 },
  turn: "p1",
};

test("maps Wallz p2 to engine player zero and p1 to player one", () => {
  assert.deepEqual(toEngineState(scan), {
    pawns: [{ r: 7, c: 5 }, { r: 2, c: 4 }],
    walls: [{ r: 4, c: 3, o: "h" }, { r: 1, c: 6, o: "v" }],
    wallsLeft: [7, 8],
    turn: 1,
  });
});

test("applies bounded manual turn and reserve overrides", () => {
  const state = toEngineState(scan, { turn: "p2", p1Walls: 14, p2Walls: -3 });
  assert.equal(state.turn, 0);
  assert.deepEqual(state.wallsLeft, [0, 10]);
});

test("position signatures do not depend on wall array order", () => {
  const state = toEngineState(scan);
  const reversed = { ...state, walls: [...state.walls].reverse() };
  assert.equal(stateSignature(state), stateSignature(reversed));
});

test("formats engine moves in Wallz board coordinates", () => {
  assert.equal(formatMove({ kind: "pawn", to: { r: 6, c: 4 } }), "pawn → e7");
  assert.equal(
    formatMove({ kind: "wall", wall: { r: 3, c: 2, o: "v" } }),
    "vertical wall · c4",
  );
});

test("describes an evaluation from the root side-to-move perspective", () => {
  assert.equal(formatEvaluation({ score: 325 }, { turn: 1 }), "p1 ahead · +3.25");
  assert.equal(formatEvaluation({ score: -125 }, { turn: 1 }), "p2 ahead · +1.25");
  assert.equal(formatEvaluation({ score: 100000 }, { turn: 0 }), "p2 · forced win");
  assert.equal(formatEvaluation({ score: 0 }, { turn: 0 }), "even");
});
