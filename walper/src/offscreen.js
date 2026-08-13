let activeRequestId = "";
let engineWorker = null;

function stopWorker(requestId = "") {
  if (requestId && requestId !== activeRequestId) return;
  engineWorker?.postMessage({ type: "cancel", requestId: activeRequestId });
  activeRequestId = "";
}

function forward(message) {
  chrome.runtime.sendMessage({
    target: "walper-background",
    ...message,
  }).catch(() => undefined);
}

function startWorker(message) {
  activeRequestId = message.requestId;
  if (!engineWorker) {
    engineWorker = new Worker(chrome.runtime.getURL("engine-worker.js"), {
      type: "module",
    });
    engineWorker.onmessage = ({ data }) => {
      if (data?.requestId !== activeRequestId) return;
      forward(data);
    };
    engineWorker.onerror = (event) => {
      const requestId = activeRequestId;
      forward({
        type: "error",
        requestId,
        error: event.message || "engine worker failed",
      });
      engineWorker?.terminate();
      engineWorker = null;
      activeRequestId = "";
    };
  }
  engineWorker.postMessage(message);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "walper-offscreen") return false;
  if (message.type === "start") startWorker(message);
  if (message.type === "cancel") stopWorker(message.requestId);
  sendResponse({ ok: true });
  return false;
});
