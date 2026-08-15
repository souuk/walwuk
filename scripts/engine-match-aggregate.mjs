import {readFile, writeFile} from "node:fs/promises";

const outputIndex = process.argv.indexOf("--output");
const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : "";
const files = process.argv.slice(2).filter((value, index, args) =>
  value !== "--output" && (index === 0 || args[index - 1] !== "--output"),
);
if (!files.length) throw new Error("Provide at least one match JSON file.");

const reports = await Promise.all(files.map(async (file) =>
  JSON.parse(await readFile(file, "utf8")),
));
const first = reports[0];
for (const report of reports.slice(1)) {
  if (report.candidateMask !== first.candidateMask ||
      report.baselineMask !== first.baselineMask ||
      report.settings.nodeLimit !== first.settings.nodeLimit ||
      report.settings.maxDepth !== first.settings.maxDepth ||
      report.settings.maxPlies !== first.settings.maxPlies) {
    throw new Error("Incompatible match reports cannot be aggregated.");
  }
}

const results = reports.flatMap((report) => report.results);
const totals = {};
for (const side of ["candidate", "baseline"]) {
  totals[side] = reports.reduce((sum, report) => ({
    moves: sum.moves + report.totals[side].moves,
    nodes: sum.nodes + report.totals[side].nodes,
    timeMs: sum.timeMs + report.totals[side].timeMs,
    depth: sum.depth + report.totals[side].depth,
  }), {moves: 0, nodes: 0, timeMs: 0, depth: 0});
  totals[side].averageDepth =
    totals[side].depth / Math.max(1, totals[side].moves);
  totals[side].nps = Math.round(
    totals[side].nodes * 1000 / Math.max(1, totals[side].timeMs),
  );
}

function count(winner, candidateSide = null) {
  return results.filter((game) => game.winner === winner &&
    (candidateSide === null || game.candidateSide === candidateSide)).length;
}

const aggregate = {
  generatedAt: new Date().toISOString(),
  sources: files,
  settings: {
    ...first.settings,
    games: results.length,
    openingOffsets: reports.map((report) => report.settings.openingOffset),
  },
  candidateMask: first.candidateMask,
  baselineMask: first.baselineMask,
  score: {
    candidate: count("candidate"),
    baseline: count("baseline"),
    unresolved: count("unresolved"),
  },
  winsByColor: {
    candidate: {
      periwinkle: count("candidate", "periwinkle"),
      blossom: count("candidate", "blossom"),
    },
    baseline: {
      periwinkle: count("baseline", "blossom"),
      blossom: count("baseline", "periwinkle"),
    },
  },
  averagePlies: results.reduce((sum, game) => sum + game.plies, 0) /
    Math.max(1, results.length),
  totals,
};

console.log(JSON.stringify(aggregate, null, 2));
if (output) await writeFile(output, `${JSON.stringify(aggregate, null, 2)}\n`);
