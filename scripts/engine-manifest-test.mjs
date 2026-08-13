import { readFile } from "node:fs/promises";

import { INITIAL_STATE, nativeAnalyze, nativeEngine } from "./engine-harness.mjs";

const manifest = JSON.parse(await readFile(
  new URL("../engine-native/promotion-manifest.json", import.meta.url),
  "utf8",
));
nativeEngine._walwuk_set_experiments(manifest.production.experimentMask);
nativeEngine._walwuk_clear_context();
const result = nativeAnalyze(INITIAL_STATE, 1);
for (const [field, expected] of [
  ["engineVersion", manifest.engineVersion],
  ["evaluatorVersion", manifest.production.evaluator],
  ["policyVersion", manifest.production.policy],
  ["experimentMask", manifest.production.experimentMask],
]) {
  if (result[field] !== expected) {
    throw new Error(`${field}: engine reported ${result[field]}, manifest expected ${expected}`);
  }
}
console.log("engine promotion manifest matches the production artifact");
