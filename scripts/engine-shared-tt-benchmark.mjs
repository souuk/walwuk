import assert from "node:assert/strict";
import {fileURLToPath} from "node:url";
import {mkdirSync, writeFileSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {performance} from "node:perf_hooks";

import {fixtures, packPosition} from "./engine-harness.mjs";

const moduleUrl = new URL(
  "../outputs/shared-engine/walwuk-engine.mjs",
  import.meta.url,
);
const createEngine = (await import(moduleUrl.href)).default;
const engine = await createEngine({
  locateFile: (name) => fileURLToPath(new URL(name, moduleUrl)),
});
const readResult = () => JSON.parse(
  engine.UTF8ToString(engine._walwuk_result()),
);
const analyze = (state, depth, threads) => {
  engine._walwuk_clear_context();
  const started = performance.now();
  if (threads === 1) {
    engine._walwuk_analyze(...packPosition(state), depth, -1);
  } else {
    engine._walwuk_analyze_threaded(
      ...packPosition(state), depth, threads,
    );
  }
  return {...readResult(), wallMs: performance.now() - started};
};

const cases = fixtures.slice(0, 6);
const threadCounts = [2, 4, 8];
const reports = [];
for (const fixture of cases) {
  const serial = analyze(fixture.state, 4, 1);
  for (const threads of threadCounts) {
    const threaded = analyze(fixture.state, 4, threads);
    assert.deepEqual(
      {bestMove: threaded.bestMove, score: threaded.score, depth: threaded.depth},
      {bestMove: serial.bestMove, score: serial.score, depth: serial.depth},
      `${fixture.name}: ${threads}-thread root search differs from serial`,
    );
    reports.push({
      fixture: fixture.name,
      threads,
      serialMs: Math.round(serial.wallMs * 100) / 100,
      threadedMs: Math.round(threaded.wallMs * 100) / 100,
      speedup: Math.round(serial.wallMs / threaded.wallMs * 100) / 100,
      serialNodes: serial.nodes,
      threadedNodes: threaded.nodes,
    });
  }
}
const median = (values) => [...values].sort((a, b) => a - b)[
  Math.floor(values.length / 2)
];
const summaries = Object.fromEntries(threadCounts.map((threads) => {
  const speedups = reports
    .filter((report) => report.threads === threads)
    .map(({speedup}) => speedup);
  return [threads, {medianSpeedup: median(speedups)}];
}));
const report = {
  schemaVersion: 1,
  status: Object.values(summaries).every(({medianSpeedup}, index) =>
    medianSpeedup / threadCounts[index] >= 0.6)
    ? "candidate"
    : "held",
  depth: 4,
  summaries: Object.fromEntries(Object.entries(summaries).map(([threads, summary]) => [
    threads,
    {...summary, parallelEfficiency: Math.round(
      summary.medianSpeedup / Number(threads) * 10_000,
    ) / 10_000},
  ])),
  reports,
};
const outputIndex = process.argv.indexOf("--output");
if (outputIndex >= 0) {
  const output = resolve(process.argv[outputIndex + 1]);
  mkdirSync(dirname(output), {recursive: true});
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify(report, null, 2));
