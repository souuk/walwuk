# Maximum-strength Phase Three: tranche one

Status: preliminary engineering evidence, 2026-08-15.

This tranche tested exact hot-path changes, persistent same-position search,
topology caching, dynamic root scheduling, and the first fixed-node pruning
matches. Production still uses experiment mask `0`; no selective candidate was
promoted from these results.

## Retained exact changes

- Search move buffers no longer clear unused fixed-capacity storage at every
  node.
- Pawn ordering requests a distance-only path query rather than reconstructing
  a witness path that is immediately recomputed during child preparation.
- Timed searches can resume the latest fully completed depth for an identical
  root. Strict fixed-depth and fixed-node searches deliberately bypass resume.
- Results report `resumedDepth`, and clearing the engine invalidates resume
  state.

The fixed-time microbenchmark is noisy. Against the prior artifact, the combined
exact hot-path changes improved the four-position one-second average from
approximately 1.29 million to 1.34 million NPS while preserving average depth
9.5. This is preliminary, not a release-scale performance claim.

## Rejected or held work

| Candidate | Evidence | Decision |
| --- | --- | --- |
| auxiliary topology distance cache v3 | delayed admission still reduced one-second median NPS by about 11%, changed two of four timed moves, and gained no aggregate depth | rejected |
| ProbCut | 100 games at 50,000 nodes per move: 49--51; candidate depth 7.66 vs baseline 7.86 | rejected |
| multi-cut | 100 games at 50,000 nodes per move: 50--50; candidate depth 7.96 vs baseline 8.59 | rejected |
| reverse futility | 100 games at 50,000 nodes per move: 50--50; candidate depth 8.74 vs baseline 8.35 | held |
| adaptive LMR | 500 games at 50,000 nodes per move: 267--233; candidate depth 8.66 vs baseline 8.23 | held pending larger fixed-node and fixed-time gates |
| dynamic root v2/v4 | opening depth five fell to roughly 0.17 s with four workers, but deterministic tie-breaking failed on a low-reserve position and scaling varied by position | held |

ProbCut and multi-cut each reported roughly four percent more NPS than the
baseline. Because both reached less depth under the same node allowance, the
increase measured cheaper or duplicated work rather than better foresight.

## Validation

- Ten curated fixtures through exhaustive depth three.
- 2,000 deterministic random parity positions.
- Resource-governor checks.
- Thirteen walper extension tests.
- TypeScript and lint checks.
- Same-root resume, strict-search bypass, and clear-state behavior.

The million-position gate and long fixed-time strength campaigns remain future
promotion requirements.
