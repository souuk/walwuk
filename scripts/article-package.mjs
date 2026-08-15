import {spawnSync} from "node:child_process";
import {readFile, readdir, stat, writeFile} from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const article = path.join(root, "article");
const metadata = await readFile(path.join(article, "metadata.tex"), "utf8");
const version = metadata.match(/\\newcommand\{\\paperversion\}\{([^}]+)\}/)?.[1] ?? "draft";
const output = path.join(article, `walwuk-overleaf-${version}.zip`);

const check = spawnSync(process.execPath, [path.join(root, "scripts", "article-check.mjs")], {cwd: root, stdio: "inherit"});
if (check.status !== 0) process.exit(check.status ?? 1);

async function collect(directory, prefix = "") {
  const files = [];
  for (const name of (await readdir(directory)).sort()) {
    if (name === "build" || name.endsWith(".zip") || name === ".patch-test") continue;
    const full = path.join(directory, name);
    const relative = prefix ? `${prefix}/${name}` : name;
    const info = await stat(full);
    if (info.isDirectory()) files.push(...await collect(full, relative));
    else files.push({name: relative.replaceAll("\\", "/"), data: await readFile(full), mtime: info.mtime});
  }
  return files;
}

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}
function localHeader(name, data, crc, stamp) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(0, 8); header.writeUInt16LE(stamp.time, 10); header.writeUInt16LE(stamp.date, 12);
  header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(name.length, 26); header.writeUInt16LE(0, 28);
  return header;
}
function centralHeader(name, data, crc, stamp, offset) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8); header.writeUInt16LE(0, 10); header.writeUInt16LE(stamp.time, 12); header.writeUInt16LE(stamp.date, 14);
  header.writeUInt32LE(crc, 16); header.writeUInt32LE(data.length, 20); header.writeUInt32LE(data.length, 24);
  header.writeUInt16LE(name.length, 28); header.writeUInt16LE(0, 30); header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34); header.writeUInt16LE(0, 36); header.writeUInt32LE(0, 38); header.writeUInt32LE(offset, 42);
  return header;
}

const files = await collect(article);
const localParts = [];
const centralParts = [];
let offset = 0;
for (const file of files) {
  const name = Buffer.from(file.name, "utf8");
  const crc = crc32(file.data);
  const stamp = dosDateTime(file.mtime);
  const local = localHeader(name, file.data, crc, stamp);
  localParts.push(local, name, file.data);
  centralParts.push(centralHeader(name, file.data, crc, stamp, offset), name);
  offset += local.length + name.length + file.data.length;
}
const central = Buffer.concat(centralParts);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
await writeFile(output, Buffer.concat([...localParts, central, end]));
console.log(`Created ${path.relative(root, output)} with ${files.length} files.`);
