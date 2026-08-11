import createWalwukEngine from "./engine/walwuk-engine.mjs";

let enginePromise = null;

function loadEngine() {
  enginePromise ??= createWalwukEngine({
    locateFile: (path) => new URL(`./engine/${path}`, import.meta.url).href,
  });
  return enginePromise;
}

function splitMask(walls, orientation) {
  let low = 0;
  let high = 0;
  for (const wall of walls) {
    if (wall.o !== orientation) continue;
    const id = wall.r * 8 + wall.c;
    const bit = 1 << (id & 31);
    if (id < 32) low = (low | bit) >>> 0;
    else high = (high | bit) >>> 0;
  }
  return { low, high };
}

function packPosition(state) {
  const horizontal = splitMask(state.walls, "h");
  const vertical = splitMask(state.walls, "v");
  return {
    pawnZero: state.pawns[0].r * 9 + state.pawns[0].c,
    pawnOne: state.pawns[1].r * 9 + state.pawns[1].c,
    wallsZero: state.wallsLeft[0],
    wallsOne: state.wallsLeft[1],
    turn: state.turn,
    horizontalLow: horizontal.low,
    horizontalHigh: horizontal.high,
    verticalLow: vertical.low,
    verticalHigh: vertical.high,
  };
}

self.onmessage = async ({ data }) => {
  if (data?.type !== "start") return;
  const { requestId, signature, state } = data;
  try {
    const engine = await loadEngine();
    const position = packPosition(state);
    globalThis.__walwukProgress = (json) => {
      self.postMessage({
        type: "progress",
        requestId,
        signature,
        result: JSON.parse(json),
      });
    };
    engine._walwuk_analyze(
      position.pawnZero,
      position.pawnOne,
      position.wallsZero,
      position.wallsOne,
      position.turn,
      position.horizontalLow,
      position.horizontalHigh,
      position.verticalLow,
      position.verticalHigh,
      15,
      -1,
    );
    self.postMessage({
      type: "done",
      requestId,
      signature,
      result: JSON.parse(engine.UTF8ToString(engine._walwuk_result())),
    });
  } catch (error) {
    self.postMessage({
      type: "error",
      requestId,
      signature,
      error: error instanceof Error ? error.message : "engine failed",
    });
  } finally {
    delete globalThis.__walwukProgress;
  }
};
