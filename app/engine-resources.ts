import type { EngineResourceUsage } from "./engine";

const WASM_MEMORY_PER_WORKER = 96 * 1024 * 1024;
const FALLBACK_MEMORY_BUDGET = 256 * 1024 * 1024;
const MAX_MEMORY_BUDGET = 1536 * 1024 * 1024;

interface MemoryAwareNavigator extends Navigator {
  deviceMemory?: number;
}

interface HeapAwarePerformance extends Performance {
  memory?: { jsHeapSizeLimit?: number };
}

export interface EngineResourceBudget extends EngineResourceUsage {
  logicalProcessors: number;
  memoryBudgetBytes: number;
  singleCoreDutyCycle: number;
}

export interface EngineCapabilities {
  logicalProcessors: number;
  deviceMemoryGiB?: number;
  heapLimitBytes?: number;
}

export function calculateEngineResourceBudget(
  capabilities: EngineCapabilities,
): EngineResourceBudget {
  const logicalProcessors = Math.max(1, Math.floor(capabilities.logicalProcessors || 1));
  const cpuWorkers = logicalProcessors === 1
    ? 1
    : Math.max(1, Math.floor(logicalProcessors * 0.75));

  const { deviceMemoryGiB } = capabilities;
  const heapLimit = capabilities.heapLimitBytes;
  const memoryCandidates = [MAX_MEMORY_BUDGET];
  if (deviceMemoryGiB && Number.isFinite(deviceMemoryGiB)) {
    memoryCandidates.push(deviceMemoryGiB * 0.5 * 1024 * 1024 * 1024);
  } else {
    memoryCandidates.push(FALLBACK_MEMORY_BUDGET);
  }
  if (heapLimit && Number.isFinite(heapLimit)) memoryCandidates.push(heapLimit * 0.65);
  const memoryBudgetBytes = Math.max(
    WASM_MEMORY_PER_WORKER,
    Math.floor(Math.min(...memoryCandidates)),
  );
  const memoryWorkers = Math.max(1, Math.floor(memoryBudgetBytes / WASM_MEMORY_PER_WORKER));
  const searchWorkers = Math.max(
    1,
    Math.min(cpuWorkers, memoryWorkers),
  );

  return {
    searchWorkers,
    logicalProcessors,
    memoryBudgetBytes,
    wasmMemoryBytes: searchWorkers * WASM_MEMORY_PER_WORKER,
    assetMemoryBytes: 0,
    singleCoreDutyCycle: logicalProcessors === 1 ? 0.75 : 1,
  };
}

export function engineResourceBudget(): EngineResourceBudget {
  return calculateEngineResourceBudget({
    logicalProcessors: navigator.hardwareConcurrency || 1,
    deviceMemoryGiB: (navigator as MemoryAwareNavigator).deviceMemory,
    heapLimitBytes: (performance as HeapAwarePerformance).memory?.jsHeapSizeLimit,
  });
}
