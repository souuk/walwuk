import { existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const outputDirectory = resolve("build-native");
mkdirSync(outputDirectory, { recursive: true });
const output = resolve(
  outputDirectory,
  process.platform === "win32" ? "walwuk-cli.exe" : "walwuk-cli",
);
const bundledClang = resolve(".emsdk", "upstream", "bin", "clang++.exe");
const candidates = process.platform === "win32" && existsSync(bundledClang)
  ? [bundledClang, "clang++", "g++"]
  : ["clang++", "g++"];
const argumentsList = [
  "-std=c++20",
  "-O3",
  "-DNDEBUG",
  "-fno-exceptions",
  "-fno-rtti",
  "engine-native/walwuk_engine.cpp",
  "engine-native/walwuk_cli.cpp",
  "-o",
  output,
];
const generateIndex = process.argv.indexOf("--pgo-generate");
const useIndex = process.argv.indexOf("--pgo-use");
if (generateIndex >= 0) {
  const profile = resolve(process.argv[generateIndex + 1] ?? "build-native/walwuk.profraw");
  argumentsList.splice(-4, 0, `-fprofile-instr-generate=${profile}`);
}
if (useIndex >= 0) {
  const profile = resolve(process.argv[useIndex + 1] ?? "build-native/walwuk.profdata");
  argumentsList.splice(-4, 0, `-fprofile-instr-use=${profile}`);
}

const failures = [];
for (const compiler of candidates) {
  const result = spawnSync(compiler, argumentsList, {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (result.status === 0) {
    console.log(`native engine built at ${output}`);
    process.exit(0);
  }
  failures.push(`${compiler}: ${result.stderr || result.error || "compiler unavailable"}`);
}

console.error("A native C++20 compiler and standard library are required.");
console.error(failures.join("\n").trim());
process.exit(1);
