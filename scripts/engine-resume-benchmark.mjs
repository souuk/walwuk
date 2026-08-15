import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

import { fixtures, packPosition } from "./engine-harness.mjs";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const moduleUrl = pathToFileURL(path.resolve(option(
  "module",
  "public/engine/walwuk-engine.mjs",
)));
const createEngine = (await import(moduleUrl.href)).default;
const engine = await createEngine({
  locateFile: (name) => fileURLToPath(new URL(name, moduleUrl)),
});
const state = fixtures.find(({ name }) =>
  name === option("position", "opening")).state;
const timeMs = Math.max(25, Number.parseInt(option("time-ms", "250"), 10));
const maxDepth = Math.max(2, Number.parseInt(option("max-depth", "20"), 10));

function result() {
  return JSON.parse(engine.UTF8ToString(engine._walwuk_result()));
}

function timedSearch() {
  engine._walwuk_analyze_selective(...packPosition(state), maxDepth, timeMs);
  return result();
}

engine._walwuk_set_experiments(0);
engine._walwuk_clear_context();
const cold = timedSearch();
const continued = timedSearch();
assert.equal(
  continued.resumedDepth,
  cold.depth,
  "continued search did not resume from the last completed depth",
);
assert.ok(
  continued.depth >= cold.depth,
  "continued search lost a previously completed depth",
);

engine._walwuk_analyze_selective(...packPosition(state), 2, -1);
const strict = result();
assert.equal(strict.resumedDepth, 0, "strict fixed-depth search inherited resume state");

engine._walwuk_clear_context();
const cleared = timedSearch();
assert.equal(cleared.resumedDepth, 0, "clear did not remove resume state");

console.table([{
  coldDepth: cold.depth,
  continuedFrom: continued.resumedDepth,
  continuedDepth: continued.depth,
  coldNodes: cold.nodes,
  continuedNodes: continued.nodes,
  strictDepth: strict.depth,
  clearedDepth: cleared.depth,
}]);
