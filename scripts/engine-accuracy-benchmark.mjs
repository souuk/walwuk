import { writeFile } from "node:fs/promises";

import {
  fixtures,
  nativeAnalyze,
  nativeAnalyzeSelective,
} from "./engine-harness.mjs";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const timeMs = Math.min(15_000, Math.max(25, Number.parseInt(option("time-ms", "1000"), 10)));
const maxDepth = Math.max(1, Number.parseInt(option("max-depth", "15"), 10));
const outputPath = option("output", "");

function summarize(result) {
  return {
    move: result.bestMove,
    score: result.score,
    depth: result.depth,
    selDepth: result.selDepth ?? result.depth,
    nodes: result.nodes,
    leafNodes: result.leafNodes ?? 0,
    nps: result.nps,
    ttHits: result.ttHits,
    cutoffs: result.cutoffs ?? 0,
    reducedSearches: result.reducedSearches ?? 0,
    researches: result.researches ?? 0,
    prunedMoves: result.prunedMoves ?? 0,
    effectiveBranchingFactor: result.depth > 0
      ? Number(Math.pow(Math.max(1, result.nodes), 1 / result.depth).toFixed(3))
      : 0,
  };
}

const records = [];
for (const fixture of fixtures) {
  const exhaustive = nativeAnalyze(fixture.state, maxDepth, timeMs);
  const selective = nativeAnalyzeSelective(fixture.state, maxDepth, timeMs);
  const record = {
    position: fixture.name,
    timeMs,
    exhaustive: summarize(exhaustive),
    selective: summarize(selective),
    sameMove: JSON.stringify(exhaustive.bestMove) === JSON.stringify(selective.bestMove),
    scoreDifference: selective.score - exhaustive.score,
    depthGain: selective.depth - exhaustive.depth,
  };
  records.push(record);
}

console.table(records.map((record) => ({
  position: record.position,
  exhaustiveDepth: record.exhaustive.depth,
  selectiveDepth: record.selective.depth,
  depthGain: record.depthGain,
  exhaustiveNps: record.exhaustive.nps,
  selectiveNps: record.selective.nps,
  sameMove: record.sameMove,
  prunedMoves: record.selective.prunedMoves,
})));

if (outputPath) {
  await writeFile(outputPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), records }, null, 2)}\n`);
  console.log(`wrote ${outputPath}`);
}

