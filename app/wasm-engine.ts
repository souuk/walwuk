import type { AnalysisLimits, AnalysisResult, GameState } from "./engine";

interface WalwukModule {
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

export async function analyzeWasm(
  state: GameState,
  limits: AnalysisLimits,
  onProgress?: (result: AnalysisResult) => void,
): Promise<AnalysisResult> {
  const engineModule = await loadModule();
  const packed = packPosition(state);
  const progressGlobal = globalThis as ProgressGlobal;
  progressGlobal.__walwukProgress = (json) => {
    onProgress?.(JSON.parse(json) as AnalysisResult);
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
      Number.isFinite(limits.timeMs) ? limits.timeMs : -1,
    );
    return JSON.parse(engineModule.UTF8ToString(engineModule._walwuk_result())) as AnalysisResult;
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
    onProgress?.(JSON.parse(json) as AnalysisResult);
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
      Number.isFinite(limits.timeMs) ? limits.timeMs : -1,
      rootIndex,
      rootCount,
    );
    return JSON.parse(engineModule.UTF8ToString(engineModule._walwuk_result())) as AnalysisResult;
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
    onProgress?.(JSON.parse(json) as AnalysisResult);
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
      Number.isFinite(limits.timeMs) ? limits.timeMs : -1,
      rootIndex,
      rootCount,
    );
    return JSON.parse(engineModule.UTF8ToString(engineModule._walwuk_result())) as AnalysisResult;
  } finally {
    delete progressGlobal.__walwukProgress;
  }
}
