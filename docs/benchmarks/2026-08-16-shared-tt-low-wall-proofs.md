# Maximum-strength Phases 8 and 9

Date: 2026-08-16

Status: Phase 8 is a held shared-memory candidate. Phase 9 has a validated
bounded proof-search tranche; general one- and two-wall tablebases remain open.
Neither experimental component is enabled in the production Pages or walper
engine.

## Phase 8: native shared-memory search

The experiment now differs materially from the earlier shared build. One
Emscripten pthread module owns one shared 96 MiB linear memory and one
transposition table. Concurrent exhaustive root partitions probe and update the
shared table under a correctness-first mutex. Exact packed-position checks
remain in each entry. Search workers suppress progress callbacks and persistent
history mutation; the parent aggregates only after every partition joins.

Six fixtures were searched to exhaustive depth four. Serial and threaded runs
matched on best move, score, and completed depth. Median results were:

| Threads | Speedup | Parallel efficiency | Decision |
| ---: | ---: | ---: | --- |
| 2 | 1.60x | 80.0% | promising; browser validation still required |
| 4 | 2.03x | 50.8% | held below 60% gate |
| 8 | 2.41x | 30.1% | held below 60% gate |

The extra threads search substantially more nodes because the prototype shares
bounds but does not yet share a global root task queue or a sufficiently strong
incumbent. Consequently, raw speedup rises while efficiency falls. Production
continues to use isolated workers. The next trial should combine two shared
threads with Chrome extension lifecycle recovery tests before considering a
feature flag.

## Phase 9: bounded exact low-wall proofs

A dependency-free AND/OR proof tool now searches every required legal reply and
emits a certificate tree. A separate replay pass reconstructs every certified
move through the normal rule engine. Terminal wins and losses are exact; cycles,
depth cutoffs, and state-budget exhaustion return `unknown`.

With one wall remaining for the opponent and none for periwinkle:

| Pawn row | Outcome | Certificate depth | Visited states | Replay |
| ---: | --- | ---: | ---: | --- |
| 2 | win | 3 ply | 205 | valid |
| 3 | loss | 4 ply | 11,260 | valid |

Certificate depth is the length of the replayed proof, not a proven optimal
win/loss distance. The earlier complete-graph solver still returns unknown when
its one-million-state cap is reached. One-sided-zero-wall coverage, general
one-wall/two-wall retrograde tables, optimal distances, and compact shipped data
remain future phases.

## Reproduction

```text
npm run engine:benchmark:shared-tt
npm run engine:prove:low-wall
npm run article:generate
npm run article:check
```

The curated evidence is stored in
`article/data/phase8-phase9-preliminary.json`; generated LaTeX is committed for
Overleaf use.
