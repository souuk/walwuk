import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const background = await readFile(new URL("../src/background.js", import.meta.url), "utf8");
const content = await readFile(new URL("../src/content.js", import.meta.url), "utf8");
const engineWorker = await readFile(new URL("../src/engine-worker.js", import.meta.url), "utf8");
const searchWorker = await readFile(new URL("../src/search-worker.js", import.meta.url), "utf8");
const offscreen = await readFile(new URL("../src/offscreen.js", import.meta.url), "utf8");
const manifest = JSON.parse(
  await readFile(new URL("../src/manifest.json", import.meta.url), "utf8"),
);

test("the service worker delegates capped hybrid analysis to native workers", () => {
  assert.match(background, /chrome\.offscreen\.createDocument/);
  assert.doesNotMatch(background, /\bimport\s*\(/);
  assert.doesNotMatch(engineWorker, /MAX_ENGINE_WORKERS/);
  assert.match(engineWorker, /new Worker\(new URL\("\.\/search-worker\.js"/);
  assert.match(
    searchWorker,
    /^import createWalwukEngine from "\.\/engine\/walwuk-engine\.mjs";/,
  );
  assert.match(searchWorker, /_walwuk_analyze_selective_split/);
  assert.match(searchWorker, /_walwuk_analyze_split/);
  assert.match(searchWorker, /_walwuk_clear_context/);
  assert.match(engineWorker, /const EPOCH_TIMES = \[1000, 2000, 4000, 8000\]/);
  assert.match(engineWorker, /message\.epochId !== session\.epochId/);
  assert.match(engineWorker, /singleCoreDutyCycle/);
  assert.doesNotMatch(searchWorker, /epochMs \* 0\.6/);
  assert.match(searchWorker, /epochMs - verifierMs/);
  assert.match(offscreen, /function stopWorker[\s\S]*engineWorker\?\.postMessage\(\{ type: "cancel"/);
  assert.match(offscreen, /engineWorker\.onerror[\s\S]*engineWorker\?\.terminate\(\)/);
  assert.match(engineWorker, /Math\.floor\(logicalProcessors \* 0\.75\)/);
  assert.match(engineWorker, /verifierCount = Math\.max\(1, Math\.floor\(workerCount \* 0\.25\)\)/);
  assert.match(engineWorker, /depth: main\?\.depth \|\| 0/);
  assert.match(engineWorker, /budget\.searchWorkers === 1/);
  assert.match(
    engineWorker,
    /budget\.wasmMemoryBytes \+ allocatedBytes > budget\.memoryBudgetBytes/,
  );
  assert.match(engineWorker, /budget\.assetMemoryBytes = allocatedBytes/);
});

test("the extension declares a module service worker", () => {
  assert.deepEqual(manifest.background, {
    service_worker: "background.js",
    type: "module",
  });
  assert.ok(manifest.permissions.includes("offscreen"));
  assert.equal(manifest.icons[128], "icons/walper-128.png");
});

test("the extension opts into cross-origin isolation with a safe fallback", () => {
  assert.equal(manifest.cross_origin_embedder_policy.value, "require-corp");
  assert.equal(manifest.cross_origin_opener_policy.value, "same-origin");
  assert.match(engineWorker, /crossOriginIsolated/);
  assert.match(engineWorker, /isolated-workers/);
});

test("deep analysis has no visible time or depth controls", () => {
  assert.doesNotMatch(content, /data-setting="timeMs"/);
  assert.doesNotMatch(content, /data-setting="maxDepth"/);
  assert.match(content, /data-field="winning"/);
  assert.match(content, /data-field="nodes"/);
});

test("the compact analysis panel shows only the requested metrics", () => {
  assert.doesNotMatch(content, /data-field="side"/);
  assert.doesNotMatch(content, /data-field="turn"/);
  assert.match(content, /data-field="walls"/);
  assert.match(content, /data-field="winning"/);
  assert.match(content, /data-field="nodes"/);
  assert.match(content, /data-field="sel-depth"/);
  assert.match(content, /data-field="real-depth"/);
  assert.match(content, /data-field="speed"/);
  assert.match(content, /result\.selDepth/);
  assert.match(content, /result\.verifiedDepth/);
});

test("the board scanner excludes its own recommendation marker", () => {
  assert.match(
    content,
    /rect\.matches\("\[data-walper-suggestion\], \.walper-board-suggestion"\)/,
  );
  assert.match(content, /mutations\.every\(walperOwnedMutation\)/);
});

test("temporary board decorations do not restart analysis", () => {
  assert.match(content, /width === 132 && height === 12/);
  assert.match(content, /target\.matches\('circle\[r="20"\], image/);
  assert.doesNotMatch(content, /node\.matches\('g, circle/);
});

test("an invalidated extension context asks for a page reload", () => {
  assert.match(content, /function sendRuntimeMessage\(message\)/);
  assert.match(content, /setField\("status", "extension updated"\)/);
  assert.match(content, /setField\("best", "reload this page"\)/);
  assert.equal(content.match(/chrome\.runtime\.sendMessage\(/g)?.length, 1);
});
