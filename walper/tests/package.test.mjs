import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const background = await readFile(new URL("../src/background.js", import.meta.url), "utf8");
const manifest = JSON.parse(
  await readFile(new URL("../src/manifest.json", import.meta.url), "utf8"),
);

test("the module service worker uses a static engine import", () => {
  assert.match(
    background,
    /^import createWalwukEngine from "\.\/engine\/walwuk-engine\.mjs";/,
  );
  assert.doesNotMatch(background, /\bimport\s*\(/);
});

test("the extension declares a module service worker", () => {
  assert.deepEqual(manifest.background, {
    service_worker: "background.js",
    type: "module",
  });
});
