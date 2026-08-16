import {spawnSync} from "node:child_process";
import {readFile, readdir, stat} from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const article = path.join(root, "article");
const errors = [];

async function filesUnder(directory) {
  const result = [];
  for (const name of await readdir(directory)) {
    const full = path.join(directory, name);
    const info = await stat(full);
    if (info.isDirectory()) result.push(...await filesUnder(full));
    else result.push(full);
  }
  return result;
}

const required = [
  "main.tex", "metadata.tex", "macros.tex", "references.bib", "README.md", "CHANGELOG.md",
  "generated/metrics.tex", "generated/snapshot-manifest.json", "notes/evidence-ledger.md"
];
for (const relative of required) {
  try { await stat(path.join(article, relative)); } catch { errors.push(`Missing required file: ${relative}`); }
}

const generator = spawnSync(process.execPath, [path.join(root, "scripts", "article-generate.mjs"), "--check"], {
  cwd: root,
  encoding: "utf8"
});
if (generator.status !== 0) errors.push(generator.stderr.trim() || generator.stdout.trim() || "Generated files are stale.");

const phaseThreeGenerator = spawnSync(process.execPath, [
  path.join(root, "scripts", "article-generate-phase3.mjs"), "--check"
], {cwd: root, encoding: "utf8"});
if (phaseThreeGenerator.status !== 0) {
  errors.push(phaseThreeGenerator.stderr.trim() ||
    phaseThreeGenerator.stdout.trim() || "Phase Three generated files are stale.");
}

const selectiveGenerator = spawnSync(process.execPath, [
  path.join(root, "scripts", "article-generate-selective-validation.mjs"), "--check"
], {cwd: root, encoding: "utf8"});
if (selectiveGenerator.status !== 0) {
  errors.push(selectiveGenerator.stderr.trim() ||
    selectiveGenerator.stdout.trim() ||
    "Selective-validation generated files are stale.");
}
const phaseSixSevenGenerator = spawnSync(process.execPath, [
  path.join(root, "scripts", "article-generate-phase67.mjs"), "--check"
], {cwd: root, encoding: "utf8"});
if (phaseSixSevenGenerator.status !== 0) {
  errors.push(phaseSixSevenGenerator.stderr.trim() ||
    phaseSixSevenGenerator.stdout.trim() ||
    "Phase 6/7 generated files are stale.");
}
const phaseFiveGenerator = spawnSync(process.execPath, [
  path.join(root, "scripts", "article-generate-phase5.mjs"), "--check"
], {cwd: root, encoding: "utf8"});
if (phaseFiveGenerator.status !== 0) {
  errors.push(phaseFiveGenerator.stderr.trim() ||
    phaseFiveGenerator.stdout.trim() || "Phase Five generated files are stale.");
}
const files = (await filesUnder(article)).filter((file) => !file.includes(`${path.sep}build${path.sep}`) && !file.endsWith(".zip"));
const textFiles = files.filter((file) => /\.(tex|bib|md|json|csv)$/.test(file));
let corpus = "";
for (const file of textFiles) {
  const source = await readFile(file, "utf8");
  corpus += `\n${source}`;
  if (/\\(?:input|includegraphics|addbibresource)\s*\{\s*(?:\.\.|\/|[A-Za-z]:)/.test(source)) {
    errors.push(`Path escapes article project: ${path.relative(article, file)}`);
  }
}

const inputPattern = /\\input\{([^}]+)\}/g;
for (const file of textFiles.filter((x) => x.endsWith(".tex"))) {
  const source = await readFile(file, "utf8");
  for (const match of source.matchAll(inputPattern)) {
    const candidate = path.join(article, match[1].endsWith(".tex") ? match[1] : `${match[1]}.tex`);
    try { await stat(candidate); } catch { errors.push(`Unresolved input ${match[1]} in ${path.relative(article, file)}`); }
  }
}

const bib = await readFile(path.join(article, "references.bib"), "utf8");
const bibKeys = new Set([...bib.matchAll(/@[A-Za-z]+\s*\{\s*([^,\s]+)/g)].map((m) => m[1]));
const cited = new Set();
for (const match of corpus.matchAll(/\\cite\{([^}]+)\}/g)) {
  for (const key of match[1].split(",").map((x) => x.trim())) cited.add(key);
}
for (const key of cited) if (!bibKeys.has(key)) errors.push(`Missing bibliography key: ${key}`);

const metadata = await readFile(path.join(article, "metadata.tex"), "utf8");
if (metadata.includes("\\workingdraftfalse") && corpus.includes("\\todoresult{")) {
  errors.push("Release mode cannot contain \\todoresult markers.");
}
if (/full 9\$?\\times\$?9 Quoridor is solved/i.test(corpus)) {
  errors.push("The manuscript appears to claim full 9x9 Quoridor is solved.");
}

if (errors.length) {
  console.error(errors.map((x) => `- ${x}`).join("\n"));
  process.exit(1);
}
console.log(`Article checks passed: ${files.length} project files, ${cited.size} citation keys, generated evidence current.`);
