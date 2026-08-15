import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

const directory = await mkdtemp(path.join(tmpdir(), "walwuk-campaign-"));
const modulePath = path.resolve(
  "outputs",
  "phase2-experimental",
  "walwuk-engine.mjs",
);

function run(script, argumentsList) {
  const result = spawnSync(process.execPath, [script, ...argumentsList], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `${script} failed`);
  }
  return result.stdout;
}

const campaignArguments = [
  "--duration-seconds", "300",
  "--max-games", "4",
  "--opening-offset", "37",
  "--workers", "2",
  "--match-mode", "ab",
  "--challenger-mask", "64",
  "--baseline-mask", "0",
  "--nodes", "10000",
  "--time-controls", "250",
  "--max-depth", "8",
  "--max-plies", "20",
  "--module", modulePath,
  "--output", directory,
];

try {
  const oddLimit = spawnSync(process.execPath, [
    "scripts/engine-campaign.mjs",
    "--max-games", "3",
    "--output", path.join(directory, "odd"),
  ], {cwd: process.cwd(), encoding: "utf8", windowsHide: true});
  assert.notEqual(oddLimit.status, 0, "odd paired-game limits must be rejected");

  run("scripts/engine-campaign.mjs", campaignArguments);
  const summaryPath = path.join(directory, "summary.json");
  let summary = JSON.parse(await readFile(summaryPath, "utf8"));
  assert.equal(summary.games, 4);
  assert.equal(summary.completedJobs, 2);
  assert.equal(summary.stoppedForGameLimit, true);
  assert.equal(summary.resourcePolicy.workerLimit <=
    summary.resourcePolicy.processorLimit, true);

  run("scripts/engine-campaign.mjs", campaignArguments);
  summary = JSON.parse(await readFile(summaryPath, "utf8"));
  assert.equal(summary.games, 4, "resuming must not exceed the game limit");
  assert.equal(summary.completedJobs, 2);

  const abReport = path.join(directory, "ab-score.json");
  await writeFile(abReport, JSON.stringify({
    score: {candidate: 60, baseline: 40, unresolved: 0},
  }));
  const sprt = JSON.parse(run("scripts/engine-sprt.mjs", [abReport]));
  assert.deepEqual(sprt.score, {wins: 60, losses: 40, unresolved: 0});
  console.log("campaign game-limit, resume, resource, and A/B SPRT checks passed");
} finally {
  await rm(directory, {recursive: true, force: true});
}
