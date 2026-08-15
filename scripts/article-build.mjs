import {spawnSync} from "node:child_process";
import {mkdirSync} from "node:fs";
import path from "node:path";

const article = path.join(process.cwd(), "article");
const build = path.join(article, "build");
mkdirSync(build, {recursive: true});

function available(command) {
  const probe = spawnSync(command, ["--version"], {stdio: "ignore", shell: process.platform === "win32"});
  return !probe.error && probe.status === 0;
}

function run(command, args) {
  const result = spawnSync(command, args, {cwd: article, stdio: "inherit", shell: process.platform === "win32"});
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (available("latexmk")) {
  run("latexmk", ["-pdf", "-interaction=nonstopmode", "-halt-on-error", "-outdir=build", "main.tex"]);
} else if (available("pdflatex") && available("bibtex")) {
  run("pdflatex", ["-interaction=nonstopmode", "-halt-on-error", "-output-directory=build", "main.tex"]);
  run("bibtex", [path.join("build", "main")]);
  run("pdflatex", ["-interaction=nonstopmode", "-halt-on-error", "-output-directory=build", "main.tex"]);
  run("pdflatex", ["-interaction=nonstopmode", "-halt-on-error", "-output-directory=build", "main.tex"]);
} else {
  console.error("No LaTeX toolchain found. Install MiKTeX or TeX Live, or upload the article ZIP to Overleaf. Required: IEEEtran, pdfLaTeX, and BibTeX.");
  process.exit(2);
}
