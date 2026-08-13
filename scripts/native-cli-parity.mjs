import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { comparableResult, fixtures, nativeAnalyze } from "./engine-harness.mjs";

const executable = resolve(
  "build-native",
  process.platform === "win32" ? "walwuk-cli.exe" : "walwuk-cli",
);
function masks(state) {
  let horizontal = 0n;
  let vertical = 0n;
  for (const wall of state.walls) {
    const bit = 1n << BigInt(wall.r * 8 + wall.c);
    if (wall.o === "h") horizontal |= bit;
    else vertical |= bit;
  }
  return [horizontal, vertical];
}

for (const fixture of fixtures) {
  const state = fixture.state;
  const [horizontal, vertical] = masks(state);
  const result = spawnSync(executable, [
    "analyze",
    `${state.pawns[0].r * 9 + state.pawns[0].c}`,
    `${state.pawns[1].r * 9 + state.pawns[1].c}`,
    `${state.wallsLeft[0]}`,
    `${state.wallsLeft[1]}`,
    `${state.turn}`,
    `0x${horizontal.toString(16)}`,
    `0x${vertical.toString(16)}`,
    "2",
    "-1",
    "exhaustive",
  ], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `native CLI exited ${result.status}`);
  assert.deepEqual(
    comparableResult(JSON.parse(result.stdout)),
    comparableResult(nativeAnalyze(state, 2)),
    `${fixture.name}: native CLI and WebAssembly differ`,
  );
}
console.log(`native CLI/WebAssembly parity passed on ${fixtures.length} fixtures`);
