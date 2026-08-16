import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

import {
  comparableResult,
  fixtures,
  packPosition,
  typescriptAnalyze,
  winner,
  applyMove,
  iterateRandomPositions,
} from "./engine-harness.mjs";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const moduleUrl = pathToFileURL(path.resolve(option(
  "module",
  "outputs/phase2-experimental/walwuk-engine.mjs",
)));
const createEngine = (await import(moduleUrl.href)).default;
const engine = await createEngine({
  locateFile: (name) => fileURLToPath(new URL(name, moduleUrl)),
});
const result = () => JSON.parse(engine.UTF8ToString(engine._walwuk_result()));
const analyze = (state, depth, timeMs = -1) => {
  engine._walwuk_analyze(...packPosition(state), depth, timeMs);
  return result();
};
const analyzeSelective = (state, depth, timeMs) => {
  engine._walwuk_analyze_selective(...packPosition(state), depth, timeMs);
  return result();
};
const analyzeNodes = (state, depth, nodes, selective = false) => {
  const entry = selective
    ? engine._walwuk_analyze_selective_nodes
    : engine._walwuk_analyze_nodes;
  entry(...packPosition(state), depth, nodes);
  return result();
};

function zeroModel(magic, tensors) {
  const parts = [Buffer.from(magic)];
  const header = Buffer.alloc(8);
  header.writeUInt32LE(2, 0);
  header.writeUInt32LE(tensors.length, 4);
  parts.push(header);
  for (const shape of tensors) {
    const values = shape.reduce((product, value) => product * value, 1);
    const metadata = Buffer.alloc(4 + shape.length * 4 + 4);
    metadata.writeUInt32LE(shape.length, 0);
    shape.forEach((value, index) => metadata.writeUInt32LE(value, 4 + index * 4));
    metadata.writeUInt32LE(values * 2, 4 + shape.length * 4);
    parts.push(metadata, Buffer.alloc(values * 2));
  }
  return Buffer.concat(parts);
}

engine._walwuk_set_experiments(0);
for (const selective of [false, true]) {
  engine._walwuk_clear_context();
  const fixedNodes = analyzeNodes(fixtures[0].state, 20, 5000, selective);
  assert.equal(fixedNodes.stopReason, "nodes");
  assert.ok(fixedNodes.bestMove, "fixed-node search must retain its last completed move");
  assert.ok(fixedNodes.nodes >= 5000, "fixed-node search stopped below its budget");
}
const policy = zeroModel("WLPY", [[64, 16], [64], [64, 64], [64], [1, 64], [1]]);
const policyPointer = engine._malloc(policy.length);
engine.HEAPU8.set(policy, policyPointer);
assert.equal(engine._walwuk_load_policy(policyPointer, policy.length), 1);
engine._free(policyPointer);
assert.equal(analyze(fixtures[0].state, 1).policyVersion, "learned-policy-q10-v2");
assert.equal(engine._walwuk_load_policy(0, 0), 0);
const value = zeroModel("WLVL", [[256, 12], [256], [32, 256], [32], [1, 32], [1]]);
const valuePointer = engine._malloc(value.length);
engine.HEAPU8.set(value, valuePointer);
assert.equal(engine._walwuk_load_value(valuePointer, value.length), 1);
engine._free(valuePointer);
engine._walwuk_set_experiments(256);
assert.equal(analyze(fixtures[0].state, 1).evaluatorVersion, "learned-value-q10-v2-experiment");
assert.equal(engine._walwuk_load_value(0, 0), 0);
engine._walwuk_set_experiments(0);
for (const fixture of fixtures) {
  for (let depth = 1; depth <= 2; ++depth) {
    assert.deepEqual(
      comparableResult(analyze(fixture.state, depth)),
      comparableResult(typescriptAnalyze(fixture.state, depth)),
      `${fixture.name}: production-mask parity differs at ${depth} ply`,
    );
  }
}
for (const mask of [1, 16, 262144, 2097152]) {
  engine._walwuk_set_experiments(mask);
  for (const fixture of fixtures) {
    assert.deepEqual(
      comparableResult(analyze(fixture.state, 2)),
      comparableResult(typescriptAnalyze(fixture.state, 2)),
      `${fixture.name}: exact experiment ${mask} differs at two ply`,
    );
  }
}
for (const mask of [
  512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072, 524288, 1048576, 2097152,
]) {
  engine._walwuk_set_experiments(mask);
  for (const fixture of fixtures) {
    assert.deepEqual(
      comparableResult(analyze(fixture.state, 2)),
      comparableResult(typescriptAnalyze(fixture.state, 2)),
      `${fixture.name}: verifier changed under selective-only experiment ${mask}`,
    );
  }
}

let topologyRandomCount = 0;
for (const state of iterateRandomPositions(128, 0x544f504f)) {
  if (winner(state) !== null) continue;
  engine._walwuk_set_experiments(0);
  const baseline = comparableResult(analyze(state, 1));
  engine._walwuk_set_experiments(2097152);
  assert.deepEqual(
    comparableResult(analyze(state, 1)),
    baseline,
    "topology-v4 random parity differs",
  );
  ++topologyRandomCount;
}
assert.ok(topologyRandomCount >= 100, "too few topology-v4 random positions");
const zeroWallState = {
  pawns: [{ r: 6, c: 4 }, { r: 2, c: 4 }],
  walls: [],
  wallsLeft: [0, 0],
  turn: 0,
};
const proof = analyze(zeroWallState, 20, 25);
assert.equal(proof.proof?.solver, "zero-wall");
assert.deepEqual(proof.proof.certificate, proof.pv);
let replay = zeroWallState;
for (const move of proof.proof.certificate) replay = applyMove(replay, move);
assert.notEqual(winner(replay), null, "proof certificate must reach a goal");

for (const mask of [
  1, 2, 4, 8, 16, 32, 64, 128, 512, 1024, 2048, 4096, 8192,
  16384, 32768, 65536, 131072, 524288, 1048576, 2097152,
]) {
  engine._walwuk_set_experiments(mask);
  const fixed = analyze(fixtures[0].state, 1);
  assert.ok(fixed.bestMove, `experiment ${mask} returned no legal opening move`);
  const selective = analyzeSelective(fixtures[0].state, 8, 25);
  assert.ok(selective.bestMove, `selective experiment ${mask} returned no legal opening move`);
  assert.equal(selective.experimentMask, mask);
}
const asymmetric = fixtures.find((fixture) => fixture.name === "channelled routes").state;
const mirrorState = (state) => ({
  ...structuredClone(state),
  pawns: state.pawns.map((pawn) => ({ r: pawn.r, c: 8 - pawn.c })),
  walls: state.walls.map((wall) => ({ ...wall, c: 7 - wall.c })),
});
const mirrorMove = (move) => move.kind === "pawn"
  ? { kind: "pawn", to: { r: move.to.r, c: 8 - move.to.c } }
  : { kind: "wall", wall: { ...move.wall, c: 7 - move.wall.c } };
const mirrored = mirrorState(asymmetric);
engine._walwuk_set_experiments(65536);
engine._walwuk_clear_context();
const originalResult = analyze(asymmetric, 3);
const mirroredResult = analyze(mirrored, 3);
assert.equal(mirroredResult.score, originalResult.score);
assert.deepEqual(
  mirrorMove(mirroredResult.bestMove),
  originalResult.bestMove,
  "canonical TT must transform the cached move back to caller coordinates",
);
assert.ok(mirroredResult.reusedNodes > 0, "mirrored analysis should reuse canonical TT entries");
let checkedMirrors = 0;
let reusedMirrors = 0;
for (const state of iterateRandomPositions(96, 0x4d495252)) {
  if (winner(state) !== null) continue;
  if (state.wallsLeft[0] === 0 && state.wallsLeft[1] === 0) continue;
  const reflected = mirrorState(state);
  if (JSON.stringify(reflected) === JSON.stringify(state)) continue;
  engine._walwuk_clear_context();
  const left = analyze(state, 2);
  const right = analyze(reflected, 2);
  assert.equal(right.score, left.score, "random mirrored score differs");
  assert.deepEqual(
    mirrorMove(right.bestMove),
    left.bestMove,
    "random canonical TT move did not round-trip",
  );
  if (right.reusedNodes > 0) ++reusedMirrors;
  ++checkedMirrors;
}
assert.ok(checkedMirrors >= 32, "too few asymmetric mirror positions were checked");
assert.ok(
  reusedMirrors >= Math.floor(checkedMirrors * 0.75),
  `canonical TT reused only ${reusedMirrors}/${checkedMirrors} random mirrors`,
);
engine._walwuk_set_experiments(0);
console.log("experimental artifact parity and proof smoke tests passed");
