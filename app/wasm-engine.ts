import type { AnalysisLimits, AnalysisResult, GameState } from "./engine";

interface WalwukModule {
  _walwuk_clear_context(): void;
  _walwuk_load_policy(pointer: number, size: number): number;
  _walwuk_load_value(pointer: number, size: number): number;
  _malloc(size: number): number;
  _free(pointer: number): void;
  HEAPU8: Uint8Array;
  _walwuk_analyze(
    pawnZero: number,
    pawnOne: number,
    wallsZero: number,
    wallsOne: number,
    turn: number,
    horizontalLow: number,
    horizontalHigh: number,
    verticalLow: number,
    verticalHigh: number,
    maxDepth: number,
    timeMs: number,
  ): void;
  _walwuk_analyze_split(
    pawnZero: number,
    pawnOne: number,
    wallsZero: number,
    wallsOne: number,
    turn: number,
    horizontalLow: number,
    horizontalHigh: number,
    verticalLow: number,
    verticalHigh: number,
    maxDepth: number,
    timeMs: number,
    rootIndex: number,
    rootCount: number,
  ): void;
  _walwuk_analyze_selective_split(
    pawnZero: number,
    pawnOne: number,
    wallsZero: number,
    wallsOne: number,
    turn: number,
    horizontalLow: number,
    horizontalHigh: number,
    verticalLow: number,
    verticalHigh: number,
    maxDepth: number,
    timeMs: number,
    rootIndex: number,
    rootCount: number,
  ): void;
  _walwuk_result(): number;
  UTF8ToString(pointer: number): string;
}

interface WalwukModuleFactory {
  default(options: { locateFile(path: string): string }): Promise<WalwukModule>;
}

type ProgressGlobal = typeof globalThis & {
  __walwukProgress?: (json: string) => void;
};

function nativeResult(json: string): AnalysisResult {
  const result = JSON.parse(json) as AnalysisResult;
  return {
    ...result,
    selectiveDepth: result.selectiveDepth ?? (result.selective ? result.depth : 0),
    verifiedDepth: result.verifiedDepth ?? (result.selective ? 0 : result.depth),
    selDepth: result.selDepth ?? result.depth,
    verifierNodes: result.verifierNodes ?? (result.selective ? 0 : result.nodes),
    leafNodes: result.leafNodes ?? 0,
    cutoffs: result.cutoffs ?? 0,
    reducedSearches: result.reducedSearches ?? 0,
    researches: result.researches ?? 0,
    prunedMoves: result.prunedMoves ?? 0,
    reverseFutilityCuts: result.reverseFutilityCuts ?? 0,
    razoringCuts: result.razoringCuts ?? 0,
    probCutCuts: result.probCutCuts ?? 0,
    historyPrunes: result.historyPrunes ?? 0,
    multiCutCuts: result.multiCutCuts ?? 0,
    singularExtensions: result.singularExtensions ?? 0,
    forcedDefenseExtensions: result.forcedDefenseExtensions ?? 0,
    canonicalTtHits: result.canonicalTtHits ?? 0,
    confidence: result.confidence ?? (result.selective ? "provisional" : "verified"),
    resourceUsage: result.resourceUsage ?? {
      searchWorkers: 1,
      wasmMemoryBytes: 96 * 1024 * 1024,
      assetMemoryBytes: 0,
    },
  };
}

export interface PackedPosition {
  pawnZero: number;
  pawnOne: number;
  wallsZero: number;
  wallsOne: number;
  turn: number;
  horizontalLow: number;
  horizontalHigh: number;
  verticalLow: number;
  verticalHigh: number;
}

export function packPosition(state: GameState): PackedPosition {
  let horizontalLow = 0;
  let horizontalHigh = 0;
  let verticalLow = 0;
  let verticalHigh = 0;
  for (const wall of state.walls) {
    const id = wall.r * 8 + wall.c;
    const bit = 1 << (id & 31);
    if (wall.o === "h") {
      if (id < 32) horizontalLow = (horizontalLow | bit) >>> 0;
      else horizontalHigh = (horizontalHigh | bit) >>> 0;
    } else if (id < 32) {
      verticalLow = (verticalLow | bit) >>> 0;
    } else {
      verticalHigh = (verticalHigh | bit) >>> 0;
    }
  }
  return {
    pawnZero: state.pawns[0].r * 9 + state.pawns[0].c,
    pawnOne: state.pawns[1].r * 9 + state.pawns[1].c,
    wallsZero: state.wallsLeft[0],
    wallsOne: state.wallsLeft[1],
    turn: state.turn,
    horizontalLow,
    horizontalHigh,
    verticalLow,
    verticalHigh,
  };
}

function engineModuleUrl(attempt: number): URL {
  const baseUrl = new URL(import.meta.env.BASE_URL, self.location.origin);
  const moduleUrl = new URL("engine/walwuk-engine.mjs", baseUrl);
  if (attempt > 0) moduleUrl.searchParams.set("retry", String(attempt));
  return moduleUrl;
}

let modulePromise: Promise<WalwukModule> | null = null;

async function initializeModule(): Promise<WalwukModule> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; ++attempt) {
    const moduleUrl = engineModuleUrl(attempt);
    try {
      const imported = await import(/* @vite-ignore */ moduleUrl.href) as WalwukModuleFactory;
      return await imported.default({
        locateFile: (path) => new URL(path, moduleUrl).href,
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Unable to load the WebAssembly engine.");
}

async function loadModule(): Promise<WalwukModule> {
  modulePromise ??= initializeModule();
  try {
    return await modulePromise;
  } catch (error) {
    modulePromise = null;
    throw error;
  }
}

export async function clearWasmContext(): Promise<void> {
  const engineModule = await loadModule();
  engineModule._walwuk_clear_context();
}

export async function loadWasmPolicy(bytes: Uint8Array): Promise<boolean> {
  const engineModule = await loadModule();
  const pointer = engineModule._malloc(bytes.byteLength);
  if (!pointer) return false;
  try {
    engineModule.HEAPU8.set(bytes, pointer);
    return engineModule._walwuk_load_policy(pointer, bytes.byteLength) === 1;
  } finally {
    engineModule._free(pointer);
  }
}

export async function loadWasmValue(bytes: Uint8Array): Promise<boolean> {
  const engineModule = await loadModule();
  const pointer = engineModule._malloc(bytes.byteLength);
  if (!pointer) return false;
  try {
    engineModule.HEAPU8.set(bytes, pointer);
    return engineModule._walwuk_load_value(pointer, bytes.byteLength) === 1;
  } finally {
    engineModule._free(pointer);
  }
}

export async function analyzeWasm(
  state: GameState,
  limits: AnalysisLimits,
  onProgress?: (result: AnalysisResult) => void,
): Promise<AnalysisResult> {
  const engineModule = await loadModule();
  const packed = packPosition(state);
  const progressGlobal = globalThis as ProgressGlobal;
  progressGlobal.__walwukProgress = (json) => {
    onProgress?.(nativeResult(json));
  };
  try {
    engineModule._walwuk_analyze(
      packed.pawnZero,
      packed.pawnOne,
      packed.wallsZero,
      packed.wallsOne,
      packed.turn,
      packed.horizontalLow,
      packed.horizontalHigh,
      packed.verticalLow,
      packed.verticalHigh,
      limits.maxDepth,
      Number.isFinite(limits.timeMs) ? limits.timeMs : -2,
    );
    return nativeResult(engineModule.UTF8ToString(engineModule._walwuk_result()));
  } finally {
    delete progressGlobal.__walwukProgress;
  }
}

export async function analyzeWasmSplit(
  state: GameState,
  limits: AnalysisLimits,
  rootIndex: number,
  rootCount: number,
  onProgress?: (result: AnalysisResult) => void,
): Promise<AnalysisResult> {
  const engineModule = await loadModule();
  const packed = packPosition(state);
  const progressGlobal = globalThis as ProgressGlobal;
  progressGlobal.__walwukProgress = (json) => {
    onProgress?.(nativeResult(json));
  };
  try {
    engineModule._walwuk_analyze_split(
      packed.pawnZero,
      packed.pawnOne,
      packed.wallsZero,
      packed.wallsOne,
      packed.turn,
      packed.horizontalLow,
      packed.horizontalHigh,
      packed.verticalLow,
      packed.verticalHigh,
      limits.maxDepth,
      Number.isFinite(limits.timeMs) ? limits.timeMs : -2,
      rootIndex,
      rootCount,
    );
    return nativeResult(engineModule.UTF8ToString(engineModule._walwuk_result()));
  } finally {
    delete progressGlobal.__walwukProgress;
  }
}

export async function analyzeWasmSelectiveSplit(
  state: GameState,
  limits: AnalysisLimits,
  rootIndex: number,
  rootCount: number,
  onProgress?: (result: AnalysisResult) => void,
): Promise<AnalysisResult> {
  const engineModule = await loadModule();
  const packed = packPosition(state);
  const progressGlobal = globalThis as ProgressGlobal;
  progressGlobal.__walwukProgress = (json) => {
    onProgress?.(nativeResult(json));
  };
  try {
    engineModule._walwuk_analyze_selective_split(
      packed.pawnZero,
      packed.pawnOne,
      packed.wallsZero,
      packed.wallsOne,
      packed.turn,
      packed.horizontalLow,
      packed.horizontalHigh,
      packed.verticalLow,
      packed.verticalHigh,
      limits.maxDepth,
      Number.isFinite(limits.timeMs) ? limits.timeMs : -2,
      rootIndex,
      rootCount,
    );
    return nativeResult(engineModule.UTF8ToString(engineModule._walwuk_result()));
  } finally {
    delete progressGlobal.__walwukProgress;
  }
}
