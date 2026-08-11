let activeRequestId = "";
let engineWorker = null;

function stopWorker(requestId = "") {
  if (requestId && requestId !== activeRequestId) return;
  engineWorker?.terminate();
  engineWorker = null;
  activeRequestId = "";
}

function forward(message) {
  chrome.runtime.sendMessage({
    target: "walper-background",
    ...message,
  }).catch(() => undefined);
}

function startWorker(message) {
  stopWorker();
  activeRequestId = message.requestId;
  engineWorker = new Worker(chrome.runtime.getURL("engine-worker.js"), {
    type: "module",
  });
  engineWorker.onmessage = ({ data }) => {
    if (data?.requestId !== activeRequestId) return;
    forward(data);
    if (data.type === "done" || data.type === "error") stopWorker(data.requestId);
  };
  engineWorker.onerror = (event) => {
    const requestId = activeRequestId;
    forward({
      type: "error",
      requestId,
      error: event.message || "engine worker failed",
    });
    stopWorker(requestId);
  };
  engineWorker.postMessage(message);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "walper-offscreen") return false;
  if (message.type === "start") startWorker(message);
  if (message.type === "cancel") stopWorker(message.requestId);
  sendResponse({ ok: true });
  return false;
});
