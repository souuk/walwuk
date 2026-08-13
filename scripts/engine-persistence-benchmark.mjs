import { writeFile } from "node:fs/promises";

import {
  applyMove,
  fixtures,
  nativeAnalyzeSelective,
  nativeEngine,
} from "./engine-harness.mjs";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const timeMs = Math.max(25, Number.parseInt(option("time-ms", "1000"), 10));
const maxDepth = Math.max(1, Number.parseInt(option("max-depth", "20"), 10));
const output = option("output", "");
const fixture = fixtures.find(({ name }) => name === option("position", "opening"));
if (!fixture) throw new Error("unknown benchmark position");

function search(state) {
  return nativeAnalyzeSelective(state, maxDepth, timeMs);
}

nativeEngine._walwuk_clear_context();
const first = search(fixture.state);
const continued = search(fixture.state);
if (!first.bestMove) throw new Error("baseline search returned no move");

const child = applyMove(fixture.state, first.bestMove);
const warmChild = search(child);
nativeEngine._walwuk_clear_context();
const coldChild = search(child);

const report = {
  generatedAt: new Date().toISOString(),
  position: fixture.name,
  timeMs,
  maxDepth,
  samePosition: {
    cold: first,
    warm: continued,
    depthGain: continued.depth - first.depth,
    reusedNodes: continued.reusedNodes ?? 0,
  },
  afterBestMove: {
    move: first.bestMove,
    cold: coldChild,
    warm: warmChild,
    depthGain: warmChild.depth - coldChild.depth,
    reusedNodes: warmChild.reusedNodes ?? 0,
  },
};

console.table([
  {
    case: "same position",
    coldDepth: first.depth,
    warmDepth: continued.depth,
    coldNps: first.nps,
    warmNps: continued.nps,
    reusedNodes: continued.reusedNodes ?? 0,
  },
  {
    case: "after best move",
    coldDepth: coldChild.depth,
    warmDepth: warmChild.depth,
    coldNps: coldChild.nps,
    warmNps: warmChild.nps,
    reusedNodes: warmChild.reusedNodes ?? 0,
  },
]);

if (output) {
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`wrote ${output}`);
}
