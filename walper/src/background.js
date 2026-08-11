const OFFSCREEN_PATH = "offscreen.html";
const activeRequests = new Map();
let offscreenCreation = null;
let nextRequestId = 0;

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl],
  });
  if (contexts.length > 0) return;
  offscreenCreation ??= chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["WORKERS"],
    justification: "Run and cancel walwuk analysis without blocking the extension service worker.",
  }).finally(() => {
    offscreenCreation = null;
  });
  await offscreenCreation;
}

async function startAnalysis(message, sender) {
  const tabId = sender.tab?.id;
  if (tabId === undefined) throw new Error("analysis requires a Wallz tab");
  await ensureOffscreenDocument();
  const previous = activeRequests.get(tabId);
  if (previous) {
    await chrome.runtime.sendMessage({
      target: "walper-offscreen",
      type: "cancel",
      requestId: previous.requestId,
    });
  }
  const requestId = `${tabId}:${++nextRequestId}`;
  activeRequests.set(tabId, { requestId, signature: message.signature });
  await chrome.runtime.sendMessage({
    target: "walper-offscreen",
    type: "start",
    requestId,
    signature: message.signature,
    state: message.state,
  });
  return { ok: true, signature: message.signature, started: true };
}

async function cancelAnalysis(message, sender) {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return;
  const active = activeRequests.get(tabId);
  if (!active || (message.signature && message.signature !== active.signature)) return;
  activeRequests.delete(tabId);
  await ensureOffscreenDocument();
  await chrome.runtime.sendMessage({
    target: "walper-offscreen",
    type: "cancel",
    requestId: active.requestId,
  });
}

function forwardEngineMessage(message) {
  const tabId = Number.parseInt(message.requestId?.split(":")[0] ?? "", 10);
  const active = activeRequests.get(tabId);
  if (!active || active.requestId !== message.requestId) return;
  if (message.type === "done" || message.type === "error") activeRequests.delete(tabId);
  chrome.tabs.sendMessage(tabId, {
    type: `walper-${message.type}`,
    signature: active.signature,
    result: message.result,
    error: message.error,
  }).catch(() => undefined);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === "walper-background") {
    forwardEngineMessage(message);
    return false;
  }
  if (message?.type === "walper-analyze") {
    startAnalysis(message, sender)
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        signature: message.signature,
        error: error instanceof Error ? error.message : "engine failed to start",
      }));
    return true;
  }
  if (message?.type === "walper-cancel") {
    cancelAnalysis(message, sender).catch(() => undefined);
  }
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const active = activeRequests.get(tabId);
  if (!active) return;
  activeRequests.delete(tabId);
  chrome.runtime.sendMessage({
    target: "walper-offscreen",
    type: "cancel",
    requestId: active.requestId,
  }).catch(() => undefined);
});

chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) return;
  chrome.tabs.sendMessage(tab.id, { type: "walper-toggle" }).catch(() => undefined);
});
