import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

import { fixtures, packPosition } from "./engine-harness.mjs";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const moduleUrl = pathToFileURL(path.resolve(option(
  "module",
  "outputs/phase2-experimental/walwuk-engine.mjs",
)));
const createEngine = (await import(moduleUrl.href)).default;
const wasmBytes = (await readFile(new URL("walwuk-engine.wasm", moduleUrl))).byteLength;
const engine = await createEngine({
  locateFile: (name) => fileURLToPath(new URL(name, moduleUrl)),
});
const timeMs = Math.max(25, Number.parseInt(option("time-ms", "250"), 10));
const maxDepth = Math.max(1, Number.parseInt(option("max-depth", "20"), 10));
const trials = Math.max(1, Number.parseInt(option("trials", "3"), 10));
const masks = option(
  "masks",
  "0,1,2,4,8,16,32,64,128,512,1024,2048,4096,8192,16384,32768,65536,131072,262144",
)
  .split(",")
  .map((value) => Number.parseInt(value, 10));
const selectedFixtures = option(
  "positions",
  "opening,channelled routes,low reserves,transposition rich",
).split(",").map((name) => fixtures.find((fixture) => fixture.name === name)).filter(Boolean);
const records = [];
for (const mask of masks) {
  engine._walwuk_set_experiments(mask);
  for (const fixture of selectedFixtures) {
    for (let trial = 0; trial < trials; ++trial) {
      engine._walwuk_clear_context();
      engine._walwuk_analyze_selective(
        ...packPosition(fixture.state),
        maxDepth,
        timeMs,
      );
      const result = JSON.parse(engine.UTF8ToString(engine._walwuk_result()));
      records.push({
        mask,
        position: fixture.name,
        trial,
        depth: result.depth,
        selDepth: result.selDepth,
        nodes: result.nodes,
        nps: result.nps,
        score: result.score,
        bestMove: result.bestMove,
        reusedNodes: result.reusedNodes,
        topologyCacheHits: result.topologyCacheHits,
        topologyRepairs: result.topologyRepairs,
        reverseFutilityCuts: result.reverseFutilityCuts,
        razoringCuts: result.razoringCuts,
        probCutCuts: result.probCutCuts,
        historyPrunes: result.historyPrunes,
        multiCutCuts: result.multiCutCuts,
        singularExtensions: result.singularExtensions,
        forcedDefenseExtensions: result.forcedDefenseExtensions,
        canonicalTtHits: result.canonicalTtHits,
      });
    }
  }
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

function majorityMove(values) {
  const counts = new Map();
  for (const value of values) {
    const key = JSON.stringify(value.bestMove);
    const item = counts.get(key) ?? { count: 0, move: value.bestMove };
    ++item.count;
    counts.set(key, item);
  }
  return [...counts.values()].sort((left, right) => right.count - left.count)[0];
}

const positions = [];
for (const mask of masks) {
  for (const fixture of selectedFixtures) {
    const values = records.filter((record) =>
      record.mask === mask && record.position === fixture.name);
    const move = majorityMove(values);
    positions.push({
      mask,
      position: fixture.name,
      trials: values.length,
      medianDepth: median(values.map((value) => value.depth)),
      medianSelDepth: median(values.map((value) => value.selDepth)),
      medianNodes: median(values.map((value) => value.nodes)),
      medianNps: Math.round(median(values.map((value) => value.nps))),
      bestMove: move.move,
      moveAgreement: move.count / values.length,
    });
  }
}
const baseline = new Map(
  positions.filter((record) => record.mask === 0)
    .map((record) => [record.position, record]),
);
const summary = masks.map((mask) => {
  const values = positions.filter((record) => record.mask === mask);
  return {
    mask,
    averageMedianDepth: values.reduce(
      (sum, value) => sum + value.medianDepth, 0,
    ) / values.length,
    averageMedianNps: Math.round(values.reduce(
      (sum, value) => sum + value.medianNps, 0,
    ) / values.length),
    depthDelta: values.reduce(
      (sum, value) => sum + value.medianDepth -
        baseline.get(value.position).medianDepth,
      0,
    ),
    moveDisagreements: values.filter((value) =>
      JSON.stringify(value.bestMove) !== JSON.stringify(baseline.get(value.position).bestMove)).length,
  };
});
console.table(summary);
const output = option("output", "");
if (output) {
  const outputPath = path.resolve(output);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify({
    timeMs,
    maxDepth,
    trials,
    wasmBytes,
    summary,
    positions,
    records,
  }, null, 2)}\n`);
}
