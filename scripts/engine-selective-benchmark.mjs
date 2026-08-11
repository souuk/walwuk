import {
  fixtures,
  nativeAnalyze,
  nativeAnalyzeSelective,
} from "./engine-harness.mjs";

const timeMs = Math.min(15_000, Math.max(1, Number.parseInt(process.argv[2] ?? "1000", 10)));
const maxDepth = Math.max(1, Number.parseInt(process.argv[3] ?? "15", 10));
const selected = fixtures.filter(({ name }) =>
  ["opening", "channelled routes", "transposition rich"].includes(name));

const rows = [];
for (const fixture of selected) {
  const exhaustive = nativeAnalyze(fixture.state, maxDepth, timeMs);
  const selective = nativeAnalyzeSelective(fixture.state, maxDepth, timeMs);
  rows.push({
    position: fixture.name,
    exhaustiveDepth: exhaustive.depth,
    selectiveDepth: selective.depth,
    depthGain: selective.depth - exhaustive.depth,
    exhaustiveNodes: exhaustive.nodes,
    selectiveNodes: selective.nodes,
    exhaustiveMove: JSON.stringify(exhaustive.bestMove),
    selectiveMove: JSON.stringify(selective.bestMove),
    sameMove: JSON.stringify(exhaustive.bestMove) === JSON.stringify(selective.bestMove),
  });
}

console.table(rows);
