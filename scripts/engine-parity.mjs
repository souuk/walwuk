import assert from "node:assert/strict";

import {
  applyMove,
  comparableResult,
  explainMove,
  fixtures,
  formatMove,
  generateRandomPositions,
  nativeAnalyze,
  nativeAnalyzeSelective,
  nativeAnalyzeSelectiveSplit,
  nativeAnalyzeSplit,
  nativeBeginSearch,
  nativeRootMoves,
  nativeSearchRootMove,
  nativeSnapshot,
  typescriptAnalyze,
  typescriptSnapshot,
} from "./engine-harness.mjs";

const full = process.argv.includes("--full");
const randomOptionIndex = process.argv.indexOf("--random");
const randomPositionCount = randomOptionIndex >= 0
  ? Math.max(1, Number.parseInt(process.argv[randomOptionIndex + 1], 10))
  : full ? 2_000 : 250;
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
assert.equal(depthLimited.verifiedDepth, 1, "exhaustive search should report verified depth");
assert.equal(depthLimited.selectiveDepth, 0, "exhaustive search must not report selective depth");
assert.equal(depthLimited.confidence, "verified", "exhaustive search should be verified");
assert.equal(depthLimited.verifierNodes, depthLimited.nodes, "exhaustive nodes should be verifier nodes");

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

const selectiveFinishedResult = nativeAnalyzeSelective(finishedState, 4);
assert.equal(selectiveFinishedResult.bestMove, null, "selective search must stop after a win");
assert.equal(selectiveFinishedResult.selective, true, "selective search must identify its result mode");

const wallReserveRich = {
  pawns: [{ r: 6, c: 4 }, { r: 2, c: 4 }],
  walls: [],
  wallsLeft: [8, 3],
  turn: 0,
};
const wallReservePoor = { ...wallReserveRich, wallsLeft: [3, 8] };
assert.ok(
  nativeSnapshot(wallReserveRich).evaluation > nativeSnapshot(wallReservePoor).evaluation,
  "wall reserves should carry a meaningful long-horizon evaluation value",
);

const openingOnePly = nativeAnalyze(fixtures[0].state, 1);
assert.deepEqual(
  openingOnePly.bestMove,
  { kind: "pawn", to: { r: 7, c: 4 } },
  "an uncommitted opening should preserve walls and advance the pawn",
);

const zeroReserveRace = {
  pawns: [{ r: 2, c: 4 }, { r: 5, c: 4 }],
  walls: [],
  wallsLeft: [0, 0],
  turn: 0,
};
const solvedRace = nativeAnalyze(zeroReserveRace, 1);
assert.deepEqual(
  solvedRace.bestMove,
  { kind: "pawn", to: { r: 1, c: 4 } },
  "the exact zero-reserve solver should preserve the fastest winning move",
);
assert.ok(solvedRace.score > 99_000, "the zero-reserve race should be proven");
assert.ok(solvedRace.exactEndgameHits > 0, "the zero-reserve solver should be used");

const backwardPawnState = {
  pawns: [{ r: 6, c: 4 }, { r: 2, c: 4 }],
  walls: [],
  wallsLeft: [10, 0],
  turn: 1,
};
const backwardPawnMove = { kind: "pawn", to: { r: 1, c: 4 } };
const backwardPawnExplanation = explainMove(
  backwardPawnState,
  backwardPawnMove,
  applyMove(backwardPawnState, backwardPawnMove),
);
assert.match(backwardPawnExplanation.text, /gives up 1 step/);
assert.match(backwardPawnExplanation.text, /has no walls left/);

const pooledSplitFixture = fixtures.find(({ name }) => name === "channelled routes");
assert.ok(pooledSplitFixture, "pooled split fixture must exist");
const pooledSplitResults = Array.from({ length: 12 }, (_, rootIndex) =>
  nativeAnalyzeSelectiveSplit(pooledSplitFixture.state, 4, rootIndex, 12),
);
assert.ok(
  pooledSplitResults.every(({ bestMove }) => bestMove !== null),
  "every assigned walper root worker must report its completed best move",
);

for (const fixture of fixtures) {
  const selectiveResult = nativeAnalyzeSelective(fixture.state, 2);
  assert.equal(selectiveResult.selective, true, `${fixture.name}: selective flag missing`);
  assert.equal(selectiveResult.selectiveDepth, selectiveResult.depth, `${fixture.name}: selective depth missing`);
  assert.equal(selectiveResult.verifiedDepth, 0, `${fixture.name}: selective search cannot claim verification`);
  assert.equal(selectiveResult.confidence, "provisional", `${fixture.name}: selective result must be provisional`);
  assert.ok(
    selectiveResult.bestMove === null ||
      typescriptSnapshot(fixture.state).moves.includes(
        selectiveResult.bestMove.kind === "pawn"
          ? `p${selectiveResult.bestMove.to.r}${selectiveResult.bestMove.to.c}`
          : `${selectiveResult.bestMove.wall.o}${selectiveResult.bestMove.wall.r}${selectiveResult.bestMove.wall.c}`,
      ),
    `${fixture.name}: selective search returned an illegal move`,
  );
}

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

for (const fixture of fixtures.filter(({ name }) =>
  ["opening", "channelled routes", "transposition rich"].includes(name))) {
  const exhaustive = nativeAnalyze(fixture.state, 5);
  const selective = nativeAnalyzeSelective(fixture.state, 5);
  assert.ok(
    Math.abs(selective.score - exhaustive.score) <= 100,
    `${fixture.name}: plausible search exceeded the verifier safety margin at five ply`,
  );
}

console.log(
  `engine parity passed: ${fixtures.length} fixtures through ${maximumDepth} ply and ${randomPositionCount} random positions`,
);
