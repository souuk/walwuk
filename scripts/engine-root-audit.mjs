import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

import {
  fixtures,
  nativeAnalyzeSelective,
  nativeBeginSearch,
  nativeRootMoves,
  nativeSearchRootMove,
  packPosition,
  iterateRandomPositions,
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
const modulePath = option("module", "");
const experimentMask = Math.max(0, Number.parseInt(option("experiment-mask", "0"), 10));
const randomPositions = Math.max(0, Number.parseInt(option("random", "0"), 10));
const seed = Number.parseInt(option("seed", "1831565813"), 10) >>> 0;
let beginSearch = nativeBeginSearch;
let rootMoves = nativeRootMoves;
let searchRootMove = nativeSearchRootMove;
let analyzeSelective = nativeAnalyzeSelective;
if (modulePath) {
  const moduleUrl = pathToFileURL(path.resolve(modulePath));
  const createEngine = (await import(moduleUrl.href)).default;
  const engine = await createEngine({
    locateFile: (name) => fileURLToPath(new URL(name, moduleUrl)),
  });
  engine._walwuk_set_experiments(experimentMask);
  const result = () => JSON.parse(engine.UTF8ToString(engine._walwuk_result()));
  beginSearch = () => engine._walwuk_begin_search();
  rootMoves = (state) => {
    engine._walwuk_root_moves(...packPosition(state));
    return result().moves;
  };
  searchRootMove = (state, code, searchDepth) => {
    engine._walwuk_search_root_move(
      ...packPosition(state), code, searchDepth, -1_000_000, 1_000_000,
    );
    return result();
  };
  analyzeSelective = (state, searchDepth) => {
    engine._walwuk_analyze_selective(...packPosition(state), searchDepth, -1);
    return result();
  };
}
const records = [];
const auditPositions = [
  ...fixtures,
  ...[...iterateRandomPositions(randomPositions, seed)].map((state, index) => ({
    name: `random-${index}`,
    state,
  })),
];

for (const fixture of auditPositions) {
  beginSearch();
  const rootScores = rootMoves(fixture.state).map((code) => {
    const result = searchRootMove(fixture.state, code, depth);
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
  const selective = analyzeSelective(fixture.state, depth);
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
if (output) {
  await mkdir(path.dirname(path.resolve(output)), { recursive: true });
  await writeFile(output, `${JSON.stringify({
    depth,
    experimentMask,
    randomPositions,
    seed,
    records,
  }, null, 2)}\n`);
  console.log(`wrote ${output}`);
}
if (failures.length > 0) {
  throw new Error(
    `root audit exceeded ${maxRegret} evaluation units: ` +
    failures.map((record) => `${record.position} (${record.regret})`).join(", "),
  );
}
