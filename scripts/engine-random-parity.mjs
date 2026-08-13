import assert from "node:assert/strict";

import {
  iterateRandomPositions,
  nativeSnapshot,
  typescriptSnapshot,
} from "./engine-harness.mjs";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const count = Math.max(1, Number.parseInt(option("count", "1000"), 10));
const seed = Number.parseInt(option("seed", "1831565813"), 10) >>> 0;

let index = 0;
for (const position of iterateRandomPositions(count, seed)) {
  assert.deepEqual(
    nativeSnapshot(position),
    typescriptSnapshot(position),
    `seed ${seed}, random position ${index}: rules snapshot differs`,
  );
  ++index;
}

console.log(`random parity passed: ${count} positions, seed ${seed}`);
