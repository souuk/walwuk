import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { availableParallelism, totalmem } from "node:os";
import path from "node:path";

const GIB = 1024 ** 3;
const STOP_BYTES = Math.floor(22.5 * GIB);
const CHECKPOINT_MS = 10 * 60 * 1000;
const STANDARD_JOB_BYTES = 192 * 1024 * 1024;
const AB_JOB_BYTES = 288 * 1024 * 1024;

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function finiteInteger(value, fallback, minimum = 1) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
}

async function directoryBytes(directory) {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) bytes += await directoryBytes(entryPath);
    else bytes += (await stat(entryPath)).size;
  }
  return bytes;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

const durationMinutes = finiteInteger(option("duration-minutes", "120"), 120);
const durationSeconds = finiteInteger(
  option("duration-seconds", `${durationMinutes * 60}`),
  durationMinutes * 60,
);
const maxDepth = finiteInteger(option("max-depth", "20"), 20);
const maxPlies = finiteInteger(option("max-plies", "120"), 120);
const challenger = option("challenger", "hybrid");
const challengerMask = Math.max(0, Number.parseInt(option("challenger-mask", "0"), 10));
const matchMode = option("match-mode", "exhaustive");
const baselineMask = Math.max(0, Number.parseInt(option("baseline-mask", "0"), 10));
const nodeLimit = Math.max(0, Number.parseInt(option("nodes", "0"), 10));
const challengerModule = option("module", "");
const timeControls = option("time-controls", "250,1000")
  .split(",")
  .map((value) => finiteInteger(value.trim(), 0))
  .filter((value) => value > 0 && value <= 15_000);
if (timeControls.length === 0) throw new Error("no valid time controls were provided");
if (!new Set(["hybrid", "selective"]).has(challenger)) {
  throw new Error("--challenger must be hybrid or selective");
}
if (!new Set(["exhaustive", "ab"]).has(matchMode)) {
  throw new Error("--match-mode must be exhaustive or ab");
}

const runId = option("run-id", new Date().toISOString().replaceAll(/[:.]/g, "-"));
const outputDirectory = path.resolve(
  option("output", path.join("outputs", "campaigns", runId)),
);
const gamesDirectory = path.join(outputDirectory, "games");
const checkpointPath = path.join(outputDirectory, "checkpoint.json");
const summaryPath = path.join(outputDirectory, "summary.json");
const stopFile = path.resolve(option("stop-file", path.join(outputDirectory, "stop.request")));
await mkdir(gamesDirectory, { recursive: true });
if (process.argv.includes("--clear-stop")) await rm(stopFile, { force: true });

const reportedProcessors = Math.max(1, availableParallelism());
const processorLimit = reportedProcessors === 1
  ? 1
  : Math.max(1, Math.floor(reportedProcessors * 0.75));
const engineMemoryBudget = Math.min(Math.floor(totalmem() * 0.5), 1536 * 1024 * 1024);
const estimatedJobBytes = matchMode === "ab" ? AB_JOB_BYTES : STANDARD_JOB_BYTES;
const memoryLimit = Math.max(1, Math.floor(engineMemoryBudget / estimatedJobBytes));
const requestedWorkers = finiteInteger(option("workers", `${processorLimit}`), processorLimit);
const workerLimit = Math.min(requestedWorkers, processorLimit, memoryLimit);
const engineModulePath = path.resolve(
  challengerModule || path.join("public", "engine", "walwuk-engine.mjs"),
);
const engineBinaryPath = engineModulePath.replace(/\.mjs$/u, ".wasm");
const engineSha256 = createHash("sha256")
  .update(await readFile(engineBinaryPath))
  .digest("hex");
const startedAt = Date.now();
const deadline = startedAt + durationSeconds * 1000;

const checkpoint = await readJson(checkpointPath, {
  version: 1,
  runId,
  createdAt: new Date(startedAt).toISOString(),
  nextJob: 0,
  completedJobs: 0,
  failedJobs: 0,
  consecutiveFailures: 0,
  games: 0,
  positions: 0,
  nodes: 0,
  searchTimeMs: 0,
  score: { challenger: 0, exhaustive: 0, unresolved: 0 },
  winsByColor: {
    challenger: { periwinkle: 0, blossom: 0 },
    exhaustive: { periwinkle: 0, blossom: 0 },
  },
  totalPlies: 0,
  shortestGame: null,
  longestGame: 0,
  generatedBytes: 0,
  throttling: { available: false, observed: false },
});
const normalizedPreviousSettings = checkpoint.settings ? {
  timeControls: checkpoint.settings.timeControls,
  maxDepth: checkpoint.settings.maxDepth,
  maxPlies: checkpoint.settings.maxPlies,
  challenger: checkpoint.settings.challenger,
  challengerMask: checkpoint.settings.challengerMask ?? 0,
  matchMode: checkpoint.settings.matchMode ?? "exhaustive",
  baselineMask: checkpoint.settings.baselineMask ?? 0,
  nodeLimit: checkpoint.settings.nodeLimit ?? 0,
  challengerModule: checkpoint.settings.challengerModule ?? null,
} : null;
const requestedSettings = {
  timeControls,
  maxDepth,
  maxPlies,
  challenger,
  challengerMask,
  matchMode,
  baselineMask,
  nodeLimit,
  challengerModule: challengerModule || null,
};
if (checkpoint.completedJobs > 0 && normalizedPreviousSettings &&
    JSON.stringify(normalizedPreviousSettings) !== JSON.stringify(requestedSettings)) {
  throw new Error(
    "campaign settings differ from the existing checkpoint; choose a new output directory",
  );
}
if (checkpoint.completedJobs > 0 && checkpoint.engineSha256 &&
    checkpoint.engineSha256 !== engineSha256) {
  throw new Error(
    "engine artifact differs from the existing checkpoint; choose a new output directory",
  );
}
checkpoint.positions ??= 0;
checkpoint.nodes ??= 0;
checkpoint.searchTimeMs ??= 0;
checkpoint.consecutiveFailures ??= 0;
checkpoint.engineSha256 = engineSha256;
checkpoint.resourcePolicy = {
  reportedProcessors,
  processorLimit,
  workerLimit,
  engineMemoryBudget,
  estimatedBytesPerJob: estimatedJobBytes,
  storageStopBytes: STOP_BYTES,
};
checkpoint.settings = {
  durationMinutes,
  durationSeconds,
  ...requestedSettings,
};

let stopRequested = false;
let nextJob = checkpoint.nextJob;
const startingGames = checkpoint.games;
const startingPositions = checkpoint.positions;
const startingCompletedJobs = checkpoint.completedJobs;
const startingFailedJobs = checkpoint.failedJobs;
let nextCheckpointAt = Date.now() + CHECKPOINT_MS;
let checkpointWrite = Promise.resolve(0);
async function stopFileExists() {
  try {
    await access(stopFile);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    stopRequested = true;
    checkpoint.stopSignal = signal;
  });
}

async function saveCheckpoint() {
  checkpoint.nextJob = nextJob;
  checkpoint.generatedBytes = await directoryBytes(outputDirectory);
  checkpoint.updatedAt = new Date().toISOString();
  await writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
  return checkpoint.generatedBytes;
}

function scheduleCheckpoint() {
  checkpointWrite = checkpointWrite.then(saveCheckpoint);
  return checkpointWrite;
}

const checkpointTimer = setInterval(() => {
  void scheduleCheckpoint().catch((error) => {
    checkpoint.lastError = error instanceof Error ? error.message : `${error}`;
    checkpoint.infrastructureFailure = true;
    stopRequested = true;
  });
}, CHECKPOINT_MS);
const stopFileTimer = setInterval(() => {
  void stopFileExists().then((requested) => {
    if (!requested || stopRequested) return;
    stopRequested = true;
    checkpoint.stopSignal = "stop-file";
    void scheduleCheckpoint();
  }).catch((error) => {
    checkpoint.lastError = error instanceof Error ? error.message : `${error}`;
    checkpoint.infrastructureFailure = true;
    stopRequested = true;
  });
}, 2000);

function record(result) {
  ++checkpoint.completedJobs;
  checkpoint.games += result.results.length;
  for (const totals of Object.values(result.totals)) {
    checkpoint.positions += totals.moves;
    checkpoint.nodes += totals.nodes;
    checkpoint.searchTimeMs += totals.timeMs;
  }
  checkpoint.score.challenger += result.score.challenger ?? result.score.candidate ?? 0;
  checkpoint.score.exhaustive += result.score.exhaustive ?? result.score.baseline ?? 0;
  checkpoint.score.unresolved += result.score.unresolved ?? 0;
  for (const game of result.results) {
    checkpoint.totalPlies += game.plies;
    checkpoint.shortestGame = checkpoint.shortestGame === null
      ? game.plies
      : Math.min(checkpoint.shortestGame, game.plies);
    checkpoint.longestGame = Math.max(checkpoint.longestGame, game.plies);
    if (game.winner === "unresolved") continue;
    const winner = game.winner === "candidate" ? "challenger"
      : game.winner === "baseline" ? "exhaustive" : game.winner;
    const challengerSide = game.challengerSide ?? game.candidateSide;
    const color = winner === "challenger"
      ? challengerSide
      : challengerSide === "periwinkle" ? "blossom" : "periwinkle";
    ++checkpoint.winsByColor[winner][color];
  }
}

async function runJob(jobIndex) {
  const timeMs = timeControls[jobIndex % timeControls.length];
  const budgetLabel = nodeLimit > 0 ? `${nodeLimit}nodes` : `${timeMs}ms`;
  const outputPath = path.join(gamesDirectory, `job-${jobIndex}-${budgetLabel}.json`);
  const argumentsList = matchMode === "ab"
    ? [
      "scripts/engine-ab-match.mjs",
      "--games", "2",
      "--move-ms", `${timeMs}`,
      "--nodes", `${nodeLimit}`,
      "--max-depth", `${maxDepth}`,
      "--max-plies", `${maxPlies}`,
      "--candidate-mask", `${challengerMask}`,
      "--baseline-mask", `${baselineMask}`,
      "--opening-offset", `${jobIndex}`,
      "--json-output", outputPath,
    ]
    : [
      "scripts/engine-match.mjs",
      "--games", "2",
      "--move-ms", `${timeMs}`,
      "--max-depth", `${maxDepth}`,
      "--max-plies", `${maxPlies}`,
      "--challenger", challenger,
      "--challenger-mask", `${challengerMask}`,
      "--opening-offset", `${jobIndex}`,
      "--json-output", outputPath,
    ];
  if (challengerModule) argumentsList.push("--module", challengerModule);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argumentsList, {
      cwd: process.cwd(),
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let errors = "";
    child.stderr.on("data", (chunk) => { errors += chunk.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => code === 0
      ? resolve()
      : reject(new Error(`job ${jobIndex} exited ${code}: ${errors.trim()}`)));
  });
  record(JSON.parse(await readFile(outputPath, "utf8")));
}

async function worker() {
  while (!stopRequested) {
    const jobIndex = nextJob++;
    let completed = false;
    for (let attempt = 0; attempt < 3 && !completed && !stopRequested; ++attempt) {
      try {
        await runJob(jobIndex);
        checkpoint.consecutiveFailures = 0;
        completed = true;
      } catch (error) {
        ++checkpoint.failedJobs;
        ++checkpoint.consecutiveFailures;
        checkpoint.lastError = error instanceof Error ? error.message : `${error}`;
        if (checkpoint.consecutiveFailures >= 3) {
          checkpoint.infrastructureFailure = true;
          stopRequested = true;
        } else {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    }
    const now = Date.now();
    if (now >= nextCheckpointAt || now >= deadline) {
      const bytes = await scheduleCheckpoint();
      nextCheckpointAt = now + CHECKPOINT_MS;
      if (bytes >= STOP_BYTES || now >= deadline) stopRequested = true;
    }
  }
}

if (await stopFileExists()) {
  stopRequested = true;
  checkpoint.stopSignal = "stop-file";
}

console.log(
  `campaign ${runId}: ${workerLimit} jobs, ${durationSeconds} seconds, ` +
  `${timeControls.join("/")} ms, CPU cap ${processorLimit}/${reportedProcessors}, ` +
  `memory cap ${Math.round(engineMemoryBudget / 1024 / 1024)} MiB`,
);
await Promise.all(Array.from({ length: workerLimit }, () => worker()));
clearInterval(checkpointTimer);
clearInterval(stopFileTimer);
if (checkpoint.completedJobs === startingCompletedJobs &&
    checkpoint.failedJobs > startingFailedJobs) {
  checkpoint.infrastructureFailure = true;
}
await scheduleCheckpoint();

const summary = {
  ...checkpoint,
  finishedAt: new Date().toISOString(),
  elapsedMs: Date.now() - startedAt,
  averagePlies: checkpoint.totalPlies / Math.max(1, checkpoint.games),
  gamesPerHour: (checkpoint.games - startingGames) * 3_600_000 /
    Math.max(1, Date.now() - startedAt),
  positionsPerHour: (checkpoint.positions - startingPositions) * 3_600_000 /
    Math.max(1, Date.now() - startedAt),
  aggregateNps: Math.round(checkpoint.nodes * 1000 /
    Math.max(1, checkpoint.searchTimeMs)),
  coordinatorPeakRssBytes: process.resourceUsage().maxRSS * 1024,
  stoppedForStorage: checkpoint.generatedBytes >= STOP_BYTES,
  stoppedForInfrastructure: checkpoint.infrastructureFailure === true,
};
await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(`campaign complete: ${summaryPath}`);
if (checkpoint.infrastructureFailure) process.exitCode = 1;
