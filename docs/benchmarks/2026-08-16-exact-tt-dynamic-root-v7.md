# Exact TT quality and dynamic-root v7

Status: Phase 6 retained as an exact engineering correction with preliminary
performance evidence; Phase 7 remains a held prototype. Production selective
experiments remain disabled.

## Phase 6: exact ordering and TT quality

The clustered TT replacement loop previously stopped as soon as it encountered
an empty slot. A matching position later in the same cluster could therefore be
duplicated. The revised loop first scans the entire cluster for an exact packed
position match, then chooses an empty or low-value replacement only if no match
exists. Replacement quality now gives a small preference to exact bounds.

Timed production search may also use a shallower matching entry's best move for
ordering while refusing its score as a bound. Strict fixed-depth mode retains
its previous horizon rule and does not use a shallow entry for ordering, keeping
deterministic parity isolated from cross-search cache state.

The standard suite passed ten fixtures through depth two plus 250 deterministic
random positions with zero mismatches. The first single-run timing screen was
mixed and is deliberately not a promotion-scale performance claim:

| Budget | Metric | Baseline | Phase 6 |
| --- | --- | ---: | ---: |
| 250 ms | exhaustive depth total | 81 | 80 |
| 250 ms | selective depth total | 101 | 102 |
| 250 ms | exhaustive mean NPS | 4,217,474 | 4,413,268 |
| 250 ms | selective mean NPS | 1,664,778 | 1,705,815 |
| 1 s | exhaustive depth total | 83 | 83 |
| 1 s | selective depth total | 111 | 112 |
| 1 s | exhaustive mean NPS | 2,406,010 | 2,376,130 |
| 1 s | selective mean NPS | 1,529,717 | 1,504,251 |

The exact capacity correction is retained. The timing evidence is preliminary
because wall-clock variation is comparable to the measured NPS differences.

## Phase 7: seed-first dynamic root scheduling

Dynamic-root v6 speculatively screened alternatives while its predicted root
move was still being searched. In the recorded opening run this caused 56 root
moves to be searched again after a trustworthy incumbent became available.

Version 7 first completes the predicted move with a full window. Workers then
pull alternative root moves dynamically and search them against that exact
incumbent. Every tie or fail-high is repeated at full depth and full window.
The final result is accepted only after all root tasks finish. A 75 ms
prior-iteration gate avoids parallel coordination on cheap positions.

Depth-six opening results with batch size one:

| Workers | Serial ms | Scheduled ms | Speedup | Efficiency | Re-searches | Move parity |
| ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 2 | 1,695 | 1,824 | 0.93x | 46.5% | 2 | yes |
| 4 | 1,663 | 1,171 | 1.42x | 35.5% | 3 | yes |
| 8 | 1,724 | 838 | 2.06x | 25.7% | 4 | yes |

The guarded eight-worker matrix kept channelled-routes and
transposition-rich positions on exact serial fallback because their prior
principal moves were unstable. The low-reserve fixture also fell back because
its prior iteration was cheaper than the coordination threshold. All four
fixtures preserved the serial move and score.

The redesign removes most speculative duplication and provides useful opening
wall-clock speedup. It is not production-enabled: 25.7% eight-worker efficiency
is well below the 60% gate, and two workers were slower than serial search.

## Decision

- Retain the exact TT cluster correction and timed shallow-move ordering.
- Keep strict fixed-depth behavior unchanged.
- Keep dynamic-root v7 as an offline prototype.
- Do not change the production experiment mask from zero.
- Pursue shared TT ownership or interior-node parallelism before another root
  scheduler promotion attempt.
