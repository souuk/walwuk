import assert from "node:assert/strict";

import {
  comparableResult,
  fixtures,
  formatMove,
  generateRandomPositions,
  nativeAnalyze,
  nativeAnalyzeSplit,
  nativeBeginSearch,
  nativeRootMoves,
  nativeSearchRootMove,
  nativeSnapshot,
  typescriptAnalyze,
  typescriptSnapshot,
} from "./engine-harness.mjs";

const full = process.argv.includes("--full");
const randomPositionCount = full ? 2_000 : 250;
const maximumDepth = full ? 3 : 2;

assert.equal(
  formatMove({ kind: "wall", wall: { r: 0, c: 0, o: "h" } }),
  "H-a8",
  "top wall rank should match the visible Wallz board",
);
assert.equal(
  formatMove({ kind: "wall", wall: { r: 7, c: 7, o: "v" } }),
  "V-h1",
  "bottom wall rank should match the visible Wallz board",
);

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

for (const fixture of fixtures.slice(0, 3)) {
  for (let depth = 1; depth <= maximumDepth; ++depth) {
    const fullResult = nativeAnalyze(fixture.state, depth);
    const splitResults = Array.from({ length: 4 }, (_, rootIndex) =>
      nativeAnalyzeSplit(fixture.state, depth, rootIndex, 4),
    ).filter((result) => result.bestMove !== null);
    assert.ok(splitResults.length > 0, `${fixture.name}: split search found no move`);
    const splitScore = Math.max(...splitResults.map((result) => result.score));
    assert.equal(
      splitScore,
      fullResult.score,
      `${fixture.name}: split search score differs at depth ${depth}`,
    );
  }
}

for (const fixture of fixtures.slice(0, 3)) {
  for (let depth = 1; depth <= maximumDepth; ++depth) {
    nativeBeginSearch();
    const rootResults = nativeRootMoves(fixture.state).map((moveCode) => ({
      moveCode,
      result: nativeSearchRootMove(fixture.state, moveCode, depth),
    }));
    const rootScore = Math.max(...rootResults.map(({ result }) => result.score));
    assert.equal(
      rootScore,
      nativeAnalyze(fixture.state, depth).score,
      `${fixture.name}: fixed-root search score differs at depth ${depth}`,
    );
    assert.ok(
      rootResults.every(({ result }) => result.bound === "exact"),
      `${fixture.name}: full-window root search returned an inexact bound`,
    );
  }
}

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
