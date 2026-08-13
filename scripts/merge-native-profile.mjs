import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const bundled = resolve(
  ".emsdk",
  "upstream",
  "bin",
  process.platform === "win32" ? "llvm-profdata.exe" : "llvm-profdata",
);
const executable = existsSync(bundled) ? bundled : "llvm-profdata";
const inputs = process.argv.slice(2);
if (inputs.length === 0) inputs.push("build-native/walwuk.profraw");
const output = resolve("build-native", "walwuk.profdata");
const result = spawnSync(executable, ["merge", "-output", output, ...inputs], {
  cwd: process.cwd(),
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
