import createWalwukEngine from "./engine/walwuk-engine.mjs";

const DEFAULT_LIMITS = Object.freeze({ maxDepth: 8, timeMs: 1000 });

let enginePromise = null;
let latestRequest = 0;

function engineUrl(path) {
  return chrome.runtime.getURL(`engine/${path}`);
}

async function initializeEngine() {
  return createWalwukEngine({
    locateFile: (path) => engineUrl(path),
  });
}

async function loadEngine() {
  enginePromise ??= initializeEngine();
  try {
    return await enginePromise;
  } catch (error) {
    enginePromise = null;
    throw error;
  }
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

function normalizeLimits(limits) {
  return {
    maxDepth: Math.max(1, Math.min(15, Number(limits?.maxDepth) || DEFAULT_LIMITS.maxDepth)),
    timeMs: Math.max(100, Math.min(30_000, Number(limits?.timeMs) || DEFAULT_LIMITS.timeMs)),
  };
}

async function analyze(message, sender, requestId) {
  const engine = await loadEngine();
  const position = packPosition(message.state);
  const limits = normalizeLimits(message.limits);
  const tabId = sender.tab?.id;
  globalThis.__walwukProgress = (json) => {
    if (requestId !== latestRequest || tabId === undefined) return;
    chrome.tabs.sendMessage(tabId, {
      type: "walper-progress",
      signature: message.signature,
      result: JSON.parse(json),
    }).catch(() => undefined);
  };
  try {
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
      limits.maxDepth,
      limits.timeMs,
    );
    return {
      ok: true,
      signature: message.signature,
      result: JSON.parse(engine.UTF8ToString(engine._walwuk_result())),
    };
  } finally {
    delete globalThis.__walwukProgress;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "walper-analyze") return false;
  const requestId = ++latestRequest;
  analyze(message, sender, requestId)
    .then((response) => sendResponse(response))
    .catch((error) => sendResponse({
      ok: false,
      signature: message.signature,
      error: error instanceof Error ? error.message : "engine failed to start",
    }));
  return true;
});

chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) return;
  chrome.tabs.sendMessage(tab.id, { type: "walper-toggle" }).catch(() => undefined);
});
