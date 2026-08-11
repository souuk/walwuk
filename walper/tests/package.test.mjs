import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const background = await readFile(new URL("../src/background.js", import.meta.url), "utf8");
const content = await readFile(new URL("../src/content.js", import.meta.url), "utf8");
const engineWorker = await readFile(new URL("../src/engine-worker.js", import.meta.url), "utf8");
const searchWorker = await readFile(new URL("../src/search-worker.js", import.meta.url), "utf8");
const manifest = JSON.parse(
  await readFile(new URL("../src/manifest.json", import.meta.url), "utf8"),
);

test("the service worker delegates native analysis to a disposable worker", () => {
  assert.match(background, /chrome\.offscreen\.createDocument/);
  assert.doesNotMatch(background, /\bimport\s*\(/);
  assert.match(engineWorker, /MAX_ENGINE_WORKERS = 12/);
  assert.match(engineWorker, /new Worker\(new URL\("\.\/search-worker\.js"/);
  assert.match(
    searchWorker,
    /^import createWalwukEngine from "\.\/engine\/walwuk-engine\.mjs";/,
  );
  assert.match(searchWorker, /_walwuk_analyze_selective_split/);
  assert.match(searchWorker, /\n\s+20,\n\s+-1,/);
});

test("the extension declares a module service worker", () => {
  assert.deepEqual(manifest.background, {
    service_worker: "background.js",
    type: "module",
  });
  assert.ok(manifest.permissions.includes("offscreen"));
  assert.equal(manifest.icons[128], "icons/walper-128.png");
});

test("deep analysis has no visible time or depth controls", () => {
  assert.doesNotMatch(content, /data-setting="timeMs"/);
  assert.doesNotMatch(content, /data-setting="maxDepth"/);
  assert.match(content, /data-field="winning"/);
  assert.match(content, /data-field="nodes"/);
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
