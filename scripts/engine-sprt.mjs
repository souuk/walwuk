import { readFile } from "node:fs/promises";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const files = process.argv.slice(2).filter((value, index, values) =>
  !value.startsWith("--") && (index === 0 || !values[index - 1].startsWith("--")));
if (files.length === 0) throw new Error("pass one or more match or campaign JSON files");
const h0 = Number(option("h0", "-2"));
const h1 = Number(option("h1", "5"));
const alpha = Number(option("alpha", "0.05"));
const beta = Number(option("beta", "0.05"));
const probability = (elo) => 1 / (1 + 10 ** (-elo / 400));
const p0 = probability(h0);
const p1 = probability(h1);

let wins = 0;
let losses = 0;
let draws = 0;
for (const file of files) {
  const value = JSON.parse(await readFile(file, "utf8"));
  const score = value.score ?? value;
  wins += score.challenger ?? 0;
  losses += score.exhaustive ?? 0;
  draws += score.unresolved ?? 0;
}
const decisive = wins + losses;
const logLikelihood = wins * Math.log(p1 / p0) +
  losses * Math.log((1 - p1) / (1 - p0));
const upper = Math.log((1 - beta) / alpha);
const lower = Math.log(beta / (1 - alpha));
const status = logLikelihood >= upper
  ? "accept-h1"
  : logLikelihood <= lower ? "accept-h0" : "continue";
const report = {
  hypotheses: { h0Elo: h0, h1Elo: h1, alpha, beta },
  games: wins + losses + draws,
  score: { wins, losses, unresolved: draws },
  decisiveScore: decisive > 0 ? wins / decisive : 0.5,
  logLikelihood,
  bounds: { lower, upper },
  status,
  note: "Unresolved games are reported but excluded from this conservative decisive-game likelihood.",
};
console.log(JSON.stringify(report, null, 2));
