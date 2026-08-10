import { existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

mkdirSync(resolve("public", "engine"), { recursive: true });

const localCompiler = resolve(
  ".emsdk",
  "upstream",
  "emscripten",
  process.platform === "win32" ? "em++.exe" : "em++",
);
const useLocalWindowsSdk = process.platform === "win32" && existsSync(localCompiler);
const compiler = useLocalWindowsSdk
  ? resolve(".emsdk", "python", "3.13.3_64bit", "python.exe")
  : existsSync(localCompiler) ? localCompiler : "em++";
const compilerArguments = useLocalWindowsSdk
  ? [resolve(".emsdk", "upstream", "emscripten", "em++.py"), "@engine-native/emscripten.rsp"]
  : ["@engine-native/emscripten.rsp"];
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
