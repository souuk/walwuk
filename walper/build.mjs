import { copyFileSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const sourceDirectory = resolve("walper", "src");
const outputDirectory = resolve("walper", "dist");
const engineDirectory = resolve(outputDirectory, "engine");

rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(outputDirectory, { recursive: true });
cpSync(sourceDirectory, outputDirectory, { recursive: true });
mkdirSync(engineDirectory, { recursive: true });
copyFileSync(
  resolve("public", "engine", "walwuk-engine.mjs"),
  resolve(engineDirectory, "walwuk-engine.mjs"),
);
copyFileSync(
  resolve("public", "engine", "walwuk-engine.wasm"),
  resolve(engineDirectory, "walwuk-engine.wasm"),
);

console.log(`walper extension built at ${outputDirectory}`);
