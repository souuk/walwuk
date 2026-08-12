import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  fixtures,
  nativeAnalyzeSelective,
  nativeBeginSearch,
  nativeRootMoves,
  nativeSearchRootMove,
} from "./engine-harness.mjs";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function moveCode(move) {
  if (!move) return -1;
  if (move.kind === "pawn") return move.to.r * 9 + move.to.c;
  return 0x8000 |
    (move.wall.o === "v" ? 0x4000 : 0) |
    (move.wall.r * 8 + move.wall.c);
}

const depth = Math.max(1, Number.parseInt(option("depth", "3"), 10));
const maxRegret = Math.max(
  0,
  Number.parseInt(option("max-regret", "100"), 10),
);
const output = option("output", "");
const records = [];

for (const fixture of fixtures) {
  nativeBeginSearch();
  const rootScores = nativeRootMoves(fixture.state).map((code) => {
    const result = nativeSearchRootMove(fixture.state, code, depth);
    return {
      moveCode: code,
      move: result.bestMove,
      score: result.score,
      nodes: result.nodes,
      selDepth: result.selDepth,
    };
  }).sort((left, right) =>
    right.score - left.score || left.moveCode - right.moveCode,
  );
  const selective = nativeAnalyzeSelective(fixture.state, depth);
  const selectedCode = moveCode(selective.bestMove);
  const selected = rootScores.find(({ moveCode: code }) =>
    code === selectedCode,
  );
  const best = rootScores[0];
  records.push({
    position: fixture.name,
    depth,
    legalRootMoves: rootScores.length,
    exhaustiveBest: best?.move ?? null,
    exhaustiveScore: best?.score ?? 0,
    selectiveBest: selective.bestMove,
    selectiveScore: selected?.score ?? null,
    regret: selected && best ? best.score - selected.score : null,
    rootScoreSpread: best && rootScores.at(-1)
      ? best.score - rootScores.at(-1).score
      : 0,
    rootScores,
  });
}

console.table(records.map((record) => ({
  position: record.position,
  legalMoves: record.legalRootMoves,
  exhaustiveScore: record.exhaustiveScore,
  selectiveScore: record.selectiveScore,
  regret: record.regret,
  scoreSpread: record.rootScoreSpread,
})));

const failures = records.filter((record) =>
  record.regret === null || record.regret > maxRegret,
);
if (failures.length > 0) {
  throw new Error(
    `root audit exceeded ${maxRegret} evaluation units: ` +
    failures.map((record) => `${record.position} (${record.regret})`).join(", "),
  );
}

if (output) {
  await mkdir(path.dirname(path.resolve(output)), { recursive: true });
  await writeFile(output, `${JSON.stringify({ depth, records }, null, 2)}\n`);
  console.log(`wrote ${output}`);
}
