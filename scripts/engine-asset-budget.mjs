import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const LIMIT_BYTES = 64 * 1024 * 1024;
const assetDirectory = path.resolve("public", "engine", "assets");

async function collect(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collect(entryPath));
    else files.push({ path: entryPath, bytes: (await stat(entryPath)).size });
  }
  return files;
}

const files = await collect(assetDirectory);
const totalBytes = files.reduce((total, file) => total + file.bytes, 0);
if (totalBytes > LIMIT_BYTES) {
  throw new Error(
    `optional engine assets use ${totalBytes} bytes, exceeding ${LIMIT_BYTES}`,
  );
}
console.log(
  `engine asset budget passed: ${files.length} files, ` +
  `${(totalBytes / 1024 / 1024).toFixed(2)} / 64.00 MiB`,
);
