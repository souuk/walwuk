# Walwuk living research paper

This folder is a self-contained IEEE-style LaTeX project. The manuscript is intentionally a working paper: validated results are included now, while unfinished research is marked and updated as the engine develops.

## Edit in Overleaf

Run `npm run article:package` from the repository root, then upload `article/walwuk-overleaf-v0.2.zip` as a new Overleaf project. Select `main.tex`, pdfLaTeX, and BibTeX. The ZIP root already contains every required source, table, plot, and bibliography file.

Edit the author, affiliation, email, version, and draft flag in `metadata.tex`. For a release draft, change `\workingdrafttrue` to `\workingdraftfalse`; validation then rejects unresolved future-result markers.

## Evidence workflow

1. Copy an approved, immutable experiment summary into `data/` and include complete provenance.
2. Add or update the snapshot in `data/index.json`.
3. Run `npm run article:generate` to regenerate macros, tables, plot CSVs, and the snapshot manifest.
4. Update the relevant prose, limitations, and future-work sections.
5. Increment the version in `metadata.tex` and document the update in `CHANGELOG.md`.
6. Run `npm run article:check`, `npm run article:build`, and `npm run article:package`.

Never copy a measured value into prose when a generated macro is suitable. Every claim should map to a snapshot in `notes/evidence-ledger.md`.

## Commands

- `npm run article:generate`: validate snapshots and regenerate committed LaTeX/CSV assets.
- `npm run article:check`: verify self-containment, references, evidence, placeholders, and generated freshness.
- `npm run article:build`: compile with `latexmk` or `pdflatex`/BibTeX when installed.
- `npm run article:package`: validate and create an untracked, directly uploadable Overleaf ZIP.

Build products remain under `article/build/` or match `article/*.zip` and are ignored by Git.

## Final length target

The finished paper targets 30–40 IEEE two-column pages including appendices. The draft grows through evidence, experiment history, and reproducibility material rather than duplicated prose.
