import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { availableParallelism, totalmem } from "node:os";
import path from "node:path";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const pairsPerControl = Math.max(
  1,
  Number.parseInt(option("pairs", "6"), 10),
);
const maxPlies = Math.max(
  1,
  Number.parseInt(option("max-plies", "120"), 10),
);
const maxDepth = Math.max(
  1,
  Number.parseInt(option("max-depth", "20"), 10),
);
const challenger = option("challenger", "hybrid");
const challengerMask = Math.max(0, Number.parseInt(option("challenger-mask", "0"), 10));
const challengerModule = option("module", "");
const summaryOnly = process.argv.includes("--summary-only");
const timeControls = option("time-controls", "10000,15000")
  .split(",")
  .map((value) => Number.parseInt(value.trim(), 10))
  .filter((value) => Number.isFinite(value) && value > 0 && value <= 15_000);

if (timeControls.length === 0) {
  throw new Error("Provide at least one time control between 1 and 15000 ms");
}

const reportedProcessors = Math.max(1, availableParallelism());
const processorLimit = reportedProcessors === 1
  ? 1
  : Math.max(1, Math.floor(reportedProcessors * 0.75));
const engineMemoryBudget = Math.min(
  Math.floor(totalmem() * 0.5),
  1536 * 1024 * 1024,
);
const estimatedBytesPerJob = 192 * 1024 * 1024;
const memoryLimit = Math.max(
  1,
  Math.floor(engineMemoryBudget / estimatedBytesPerJob),
);
const requestedWorkers = Math.max(
  1,
  Number.parseInt(option("workers", `${processorLimit}`), 10),
);
const workerLimit = Math.min(
  requestedWorkers,
  processorLimit,
  memoryLimit,
);
const runId = new Date().toISOString().replaceAll(/[:.]/g, "-");
const outputDirectory = path.resolve(
  option("output", path.join("outputs", "engine-tournaments", runId)),
);

await mkdir(outputDirectory, { recursive: true });
const currentEngineSha256 = createHash("sha256")
  .update(await readFile(path.resolve("public", "engine", "walwuk-engine.wasm")))
  .digest("hex");

const jobs = [];
for (const timeMs of timeControls) {
  for (let pair = 0; pair < pairsPerControl; ++pair) {
    jobs.push({
      id: `${timeMs}ms-opening-${pair}`,
      openingOffset: pair,
      timeMs,
    });
  }
}
const activeWorkerCount = Math.min(workerLimit, Math.max(1, jobs.length));

async function runJob(job) {
  const outputPath = path.join(outputDirectory, `${job.id}.json`);
  const argumentsList = [
    "scripts/engine-match.mjs",
    "--games", "2",
    "--move-ms", `${job.timeMs}`,
    "--max-depth", `${maxDepth}`,
    "--max-plies", `${maxPlies}`,
    "--challenger", challenger,
    "--challenger-mask", `${challengerMask}`,
    "--opening-offset", `${job.openingOffset}`,
    "--json-output", outputPath,
  ];
  if (challengerModule) argumentsList.push("--module", challengerModule);

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argumentsList, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let errorOutput = "";
    child.stderr.on("data", (chunk) => {
      errorOutput += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(
          `${job.id} exited with ${code}: ${errorOutput.trim()}`,
        ));
      }
    });
  });

  const result = JSON.parse(await readFile(outputPath, "utf8"));
  console.log(
    `${job.id}: ${result.challenger} ${result.score.challenger}, ` +
    `exhaustive ${result.score.exhaustive}, ` +
    `unresolved ${result.score.unresolved}`,
  );
  return result;
}

let nextJobIndex = 0;
const completed = [];
async function runWorker() {
  while (nextJobIndex < jobs.length) {
    const job = jobs[nextJobIndex++];
    completed.push(await runJob(job));
  }
}

if (summaryOnly) {
  const resultFiles = (await readdir(outputDirectory))
    .filter((name) => name.endsWith(".json") && name !== "summary.json");
  for (const name of resultFiles) {
    completed.push(JSON.parse(
      await readFile(path.join(outputDirectory, name), "utf8"),
    ));
  }
  if (completed.length === 0) {
    throw new Error(`no match results found in ${outputDirectory}`);
  }
} else {
  console.log(
    `running ${jobs.length} color-swapped pairs with ${activeWorkerCount} workers ` +
    `(reported processors ${reportedProcessors}, CPU limit ${processorLimit}, ` +
    `memory limit ${memoryLimit})`,
  );
  await Promise.all(
    Array.from({ length: activeWorkerCount }, () => runWorker()),
  );
}

const aggregate = {
  challenger,
  challengerMask,
  challengerModule: challengerModule || null,
  currentEngineSha256,
  engineSha256: [...new Set(
    completed.map((result) => result.engineSha256).filter(Boolean),
  )],
  resourcePolicy: {
    reportedProcessors,
    processorLimit,
    workerLimit: activeWorkerCount,
    engineMemoryBudget,
    estimatedBytesPerJob,
  },
  settings: {
    pairsPerControl,
    timeControls,
    maxDepth,
    maxPlies,
  },
  controls: {},
};

for (const timeMs of timeControls) {
  const matches = completed.filter(
    (result) => result.requestedMoveTimeMs === timeMs,
  );
  if (matches.length === 0) continue;
  const games = matches.flatMap((result) => result.results);
  const score = matches.reduce(
    (sum, result) => ({
      challenger: sum.challenger + result.score.challenger,
      exhaustive: sum.exhaustive + result.score.exhaustive,
      unresolved: sum.unresolved + result.score.unresolved,
    }),
    { challenger: 0, exhaustive: 0, unresolved: 0 },
  );
  const engineMetrics = Object.fromEntries(
    ["challenger", "exhaustive"].map((engine) => {
      const total = matches.reduce(
        (sum, result) => ({
          moves: sum.moves + result.totals[engine].moves,
          nodes: sum.nodes + result.totals[engine].nodes,
          timeMs: sum.timeMs + result.totals[engine].timeMs,
          depth: sum.depth + result.totals[engine].depth,
          maxDepth: Math.max(sum.maxDepth, result.totals[engine].maxDepth),
        }),
        { moves: 0, nodes: 0, timeMs: 0, depth: 0, maxDepth: 0 },
      );
      return [engine, {
        ...total,
        averageDepth: total.depth / Math.max(1, total.moves),
        nps: Math.round(total.nodes * 1000 / Math.max(1, total.timeMs)),
      }];
    }),
  );
  aggregate.controls[timeMs] = {
    games: games.length,
    score,
    averagePlies: games.reduce((sum, game) => sum + game.plies, 0) /
      Math.max(1, games.length),
    shortestGame: Math.min(...games.map((game) => game.plies)),
    longestGame: Math.max(...games.map((game) => game.plies)),
    maximumMoveMs: Math.max(...games.map((game) => game.maxMoveMs)),
    engines: engineMetrics,
  };
}

const summaryPath = path.join(outputDirectory, "summary.json");
await writeFile(summaryPath, `${JSON.stringify(aggregate, null, 2)}\n`);
console.log(`complete: ${summaryPath}`);
