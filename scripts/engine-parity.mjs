import assert from "node:assert/strict";

import {
  comparableResult,
  fixtures,
  generateRandomPositions,
  nativeAnalyze,
  nativeSnapshot,
  typescriptAnalyze,
  typescriptSnapshot,
} from "./engine-harness.mjs";

const full = process.argv.includes("--full");
const randomPositionCount = full ? 2_000 : 250;
const maximumDepth = full ? 6 : 4;

const depthLimited = nativeAnalyze(fixtures[0].state, 1);
assert.equal(depthLimited.stopReason, "depth", "fixed-depth search should report depth completion");

const timeLimited = nativeAnalyze(fixtures[0].state, 15, 250);
assert.equal(timeLimited.stopReason, "time", "timed search should report the time limit");
assert.ok(timeLimited.depth < 15, "250 ms search unexpectedly completed 15 ply");

const finishedState = {
  pawns: [{ r: 0, c: 4 }, { r: 7, c: 4 }],
  walls: [],
  wallsLeft: [10, 10],
  turn: 1,
};
const finishedResult = nativeAnalyze(finishedState, 4);
assert.equal(finishedResult.bestMove, null, "finished position must not return a best move");
assert.deepEqual(finishedResult.pv, [], "finished position must not return a principal variation");

for (const fixture of fixtures) {
  assert.deepEqual(
    nativeSnapshot(fixture.state),
    typescriptSnapshot(fixture.state),
    `${fixture.name}: rules snapshot differs`,
  );
  for (let depth = 1; depth <= maximumDepth; ++depth) {
    assert.deepEqual(
      comparableResult(nativeAnalyze(fixture.state, depth)),
      comparableResult(typescriptAnalyze(fixture.state, depth)),
      `${fixture.name}: search differs at depth ${depth}`,
    );
  }
}

const randomPositions = generateRandomPositions(randomPositionCount);
for (let index = 0; index < randomPositions.length; ++index) {
  assert.deepEqual(
    nativeSnapshot(randomPositions[index]),
    typescriptSnapshot(randomPositions[index]),
    `random position ${index}: rules snapshot differs`,
  );
}

console.log(
  `engine parity passed: ${fixtures.length} fixtures through ${maximumDepth} ply and ${randomPositionCount} random positions`,
);
