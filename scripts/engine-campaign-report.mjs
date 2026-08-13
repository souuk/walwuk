import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const directory = path.resolve(option(
  "directory",
  "outputs/campaigns/phase2-pilot",
));
const output = option("output", "");
const files = (await readdir(path.join(directory, "games")))
  .filter((name) => name.endsWith(".json"));
const groups = new Map();

function sprt(score, h0 = -2, h1 = 5, alpha = 0.05, beta = 0.05) {
  const probability = (elo) => 1 / (1 + 10 ** (-elo / 400));
  const p0 = probability(h0);
  const p1 = probability(h1);
  const logLikelihood = score.first * Math.log(p1 / p0) +
    score.second * Math.log((1 - p1) / (1 - p0));
  const lower = Math.log(beta / (1 - alpha));
  const upper = Math.log((1 - beta) / alpha);
  return {
    hypotheses: { h0Elo: h0, h1Elo: h1, alpha, beta },
    logLikelihood,
    bounds: { lower, upper },
    status: logLikelihood >= upper
      ? "accept-h1"
      : logLikelihood <= lower ? "accept-h0" : "continue",
  };
}

function empty(budget, labels) {
  return {
    budget,
    labels,
    jobs: 0,
    games: 0,
    score: { first: 0, second: 0, unresolved: 0 },
    winsByColor: {
      first: { periwinkle: 0, blossom: 0 },
      second: { periwinkle: 0, blossom: 0 },
    },
    scoreByGameOrder: {
      firstGame: { first: 0, second: 0, unresolved: 0 },
      returnGame: { first: 0, second: 0, unresolved: 0 },
    },
    engineTotals: {
      first: { moves: 0, nodes: 0, timeMs: 0, depth: 0, maxDepth: 0 },
      second: { moves: 0, nodes: 0, timeMs: 0, depth: 0, maxDepth: 0 },
    },
    plies: 0,
    shortestGame: null,
    longestGame: 0,
  };
}

for (let start = 0; start < files.length; start += 32) {
  const batch = files.slice(start, start + 32);
  const reports = await Promise.all(batch.map(async (name) => JSON.parse(
    await readFile(path.join(directory, "games", name), "utf8"),
  )));
  for (const report of reports) {
    const isAb = Object.hasOwn(report.score, "candidate");
    const labels = isAb
      ? { first: "candidate", second: "baseline" }
      : { first: "challenger", second: "exhaustive" };
    const nodeLimit = report.settings?.nodeLimit ?? 0;
    const timeMs = report.requestedMoveTimeMs ?? report.settings?.moveMs ?? 0;
    const budget = nodeLimit > 0
      ? { kind: "nodes", value: nodeLimit }
      : { kind: "time", value: timeMs };
    const key = `${isAb ? "ab" : "exhaustive"}:${budget.kind}:${budget.value}`;
    const group = groups.get(key) ?? empty(budget, labels);
    groups.set(key, group);
    ++group.jobs;
    group.games += report.results.length;
    group.score.first += report.score[labels.first];
    group.score.second += report.score[labels.second];
    group.score.unresolved += report.score.unresolved;
    for (const side of ["first", "second"]) {
      const source = report.totals[labels[side]];
      const destination = group.engineTotals[side];
      destination.moves += source.moves;
      destination.nodes += source.nodes;
      destination.timeMs += source.timeMs;
      destination.depth += source.depth;
      destination.maxDepth = Math.max(
        destination.maxDepth,
        source.maxDepth ?? 0,
      );
    }
    for (const game of report.results) {
      group.plies += game.plies;
      group.shortestGame = group.shortestGame === null
        ? game.plies
        : Math.min(group.shortestGame, game.plies);
      group.longestGame = Math.max(group.longestGame, game.plies);
      const order = (game.game - 1) % 2 === 0 ? "firstGame" : "returnGame";
      if (game.winner === "unresolved") {
        ++group.scoreByGameOrder[order].unresolved;
        continue;
      }
      const firstSide = game.challengerSide ?? game.candidateSide;
      const winner = game.winner === labels.first ? "first" : "second";
      ++group.scoreByGameOrder[order][winner];
      const color = winner === "first"
        ? firstSide
        : firstSide === "periwinkle" ? "blossom" : "periwinkle";
      ++group.winsByColor[winner][color];
    }
  }
}

const controls = [...groups.values()]
  .sort((left, right) => left.budget.value - right.budget.value)
  .map((group) => ({
    ...group,
    averagePlies: group.plies / Math.max(1, group.games),
    engineTotals: Object.fromEntries(Object.entries(group.engineTotals).map(
      ([name, totals]) => [name, {
        ...totals,
        averageDepth: totals.depth / Math.max(1, totals.moves),
        nps: Math.round(totals.nodes * 1000 / Math.max(1, totals.timeMs)),
      }],
    )),
    sprt: sprt(group.score),
  }));
const report = {
  generatedAt: new Date().toISOString(),
  directory,
  files: files.length,
  controls,
};
console.table(controls.map((group) => ({
  budget: `${group.budget.value}${group.budget.kind === "time" ? "ms" : " nodes"}`,
  comparison: `${group.labels.first} vs ${group.labels.second}`,
  games: group.games,
  first: group.score.first,
  second: group.score.second,
  unresolved: group.score.unresolved,
  firstPeriwinkle: group.winsByColor.first.periwinkle,
  firstBlossom: group.winsByColor.first.blossom,
  secondPeriwinkle: group.winsByColor.second.periwinkle,
  secondBlossom: group.winsByColor.second.blossom,
  firstGame: `${group.scoreByGameOrder.firstGame.first}-` +
    `${group.scoreByGameOrder.firstGame.second}-` +
    `${group.scoreByGameOrder.firstGame.unresolved}`,
  returnGame: `${group.scoreByGameOrder.returnGame.first}-` +
    `${group.scoreByGameOrder.returnGame.second}-` +
    `${group.scoreByGameOrder.returnGame.unresolved}`,
  averagePlies: Number(group.averagePlies.toFixed(2)),
  sprt: group.sprt.status,
})));
if (output) await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
