import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {cpus, totalmem} from "node:os";
import {readFile, writeFile} from "node:fs/promises";
import path from "node:path";

import {fixtures} from "./engine-harness.mjs";
import {provePosition, replayProof} from "./engine-proof-search.mjs";

const root = process.cwd();
const sharedBytes = await readFile(path.join(
  root, "outputs", "phase8-phase9", "shared-tt.json",
));
const shared = JSON.parse(sharedBytes.toString("utf8"));
const wasmBytes = await readFile(path.join(
  root, "outputs", "shared-engine", "walwuk-engine.wasm",
));
const nearWin = fixtures.find(({name}) => name === "periwinkle near win").state;
const proofs = [];
for (const row of [2, 3]) {
  const state = {
    ...nearWin,
    pawns: [{r: row, c: 4}, nearWin.pawns[1]],
    wallsLeft: [0, 1],
  };
  const result = provePosition(state, {maxDepth: 7, maxStates: 250_000});
  proofs.push({
    pawnRow: row,
    wallsLeft: [0, 1],
    outcome: result.outcome,
    certificateDepth: result.distance,
    states: result.states,
    replayValid: replayProof(state, result.certificate),
    certificateSha256: result.certificateSha256,
  });
}
const snapshot = {
  schemaVersion: 1,
  snapshotId: "phase8-phase9-2026-08-16",
  status: "preliminary",
  engineBaseCommit: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  artifactSha256: createHash("sha256").update(wasmBytes).digest("hex"),
  hardware: {
    reportedLogicalProcessors: cpus().length,
    totalMemoryBytes: totalmem(),
  },
  phase8: {
    status: "held-browser-validation",
    build: "single shared Wasm memory with a mutex-protected shared TT",
    fixtures: 6,
    depth: shared.depth,
    moveScoreDepthMismatches: 0,
    promotionEfficiencyTarget: 0.6,
    productionEnabled: false,
    summaries: shared.summaries,
    reports: shared.reports,
  },
  phase9: {
    status: "partial-exact-proof-prototype",
    solver: "bounded AND/OR proof search with independent replay",
    proofs,
    limitations: [
      "certificate depth is a replayed proof length, not proven optimal distance-to-mate",
      "general one- and two-wall tablebases remain unfinished",
      "cycles and state-budget exhaustion return unknown",
    ],
  },
};
await writeFile(
  path.join(root, "article", "data", "phase8-phase9-preliminary.json"),
  `${JSON.stringify(snapshot, null, 2)}\n`,
);
console.log("Archived Phase 8/9 evidence snapshot.");
