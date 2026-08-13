import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";

const outputIndex = process.argv.indexOf("--output");
const output = resolve(
  outputIndex >= 0 ? process.argv[outputIndex + 1] : "public/engine/walwuk-engine.mjs",
);
mkdirSync(dirname(output), { recursive: true });

const localCompiler = resolve(
  ".emsdk",
  "upstream",
  "emscripten",
  process.platform === "win32" ? "em++.exe" : "em++",
);
const useLocalWindowsSdk = process.platform === "win32" && existsSync(localCompiler);
const profileBuild = process.argv.includes("--profile");
const sharedBuild = process.argv.includes("--shared");
const simdBuild = process.argv.includes("--simd");
const optionalArguments = [
  ...(profileBuild ? ["-DWALWUK_PROFILE=1"] : []),
  ...(sharedBuild ? ["-pthread"] : []),
  ...(simdBuild ? ["-msimd128"] : []),
];
const responseArguments = readFileSync(resolve("engine-native", "emscripten.rsp"), "utf8")
  .split(/\r?\n/)
  .filter(Boolean);
const responseOutputIndex = responseArguments.indexOf("-o");
if (responseOutputIndex < 0) throw new Error("engine response file is missing -o");
responseArguments[responseOutputIndex + 1] = output;
const compiler = useLocalWindowsSdk
  ? resolve(".emsdk", "python", "3.13.3_64bit", "python.exe")
  : existsSync(localCompiler) ? localCompiler : "em++";
const compilerArguments = useLocalWindowsSdk
  ? [resolve(".emsdk", "upstream", "emscripten", "em++.py"), ...optionalArguments, ...responseArguments]
  : [...optionalArguments, ...responseArguments];
const environment = { ...process.env };
if (useLocalWindowsSdk) {
  environment.EM_CONFIG = resolve(".emsdk", ".emscripten");
  environment.EMSDK_NODE = resolve(".emsdk", "node", "24.19.0_64bit", "node.exe");
}
const result = spawnSync(compiler, compilerArguments, {
  cwd: process.cwd(),
  env: environment,
  stdio: "inherit",
});

if (result.error) {
  console.error("Emscripten 6.0.6 is required. Activate emsdk before building walwuk.");
  throw result.error;
}
process.exitCode = result.status ?? 1;
