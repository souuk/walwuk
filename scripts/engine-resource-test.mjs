import assert from "node:assert/strict";

import { calculateEngineResourceBudget } from "../.engine-test/engine-resources.js";

for (const logicalProcessors of [1, 2, 3, 4, 8, 12, 16]) {
  const budget = calculateEngineResourceBudget({
    logicalProcessors,
    deviceMemoryGiB: 32,
    heapLimitBytes: 4 * 1024 * 1024 * 1024,
  });
  const processorLimit = logicalProcessors === 1
    ? 1
    : Math.floor(logicalProcessors * 0.75);
  assert.ok(budget.searchWorkers <= processorLimit);
  assert.ok(budget.wasmMemoryBytes <= budget.memoryBudgetBytes);
}

assert.equal(calculateEngineResourceBudget({
  logicalProcessors: 1,
  deviceMemoryGiB: 8,
}).singleCoreDutyCycle, 0.75);
assert.equal(calculateEngineResourceBudget({
  logicalProcessors: 2,
  deviceMemoryGiB: 8,
}).searchWorkers, 1);
assert.equal(calculateEngineResourceBudget({
  logicalProcessors: 3,
  deviceMemoryGiB: 8,
}).searchWorkers, 2);

const unknownMemory = calculateEngineResourceBudget({ logicalProcessors: 16 });
assert.equal(unknownMemory.memoryBudgetBytes, 256 * 1024 * 1024);
assert.equal(unknownMemory.searchWorkers, 2);
assert.equal(unknownMemory.wasmMemoryBytes, 192 * 1024 * 1024);

const memoryLimited = calculateEngineResourceBudget({
  logicalProcessors: 16,
  deviceMemoryGiB: 1,
});
assert.equal(memoryLimited.searchWorkers, 5);
assert.ok(memoryLimited.wasmMemoryBytes <= memoryLimited.memoryBudgetBytes);

console.log("engine resource policy passed");
