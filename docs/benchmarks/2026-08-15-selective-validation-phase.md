# Selective validation phase

Status: active research, 2026-08-15.

Production remains at experiment mask `0`. This phase evaluates adaptive
late-move reductions (LMR) without allowing a higher reported depth or NPS to
stand in for accuracy.

## Campaign infrastructure

- Added resumable `--max-games` campaigns with exact two-game paired jobs.
- Added `--opening-offset` so successive campaigns do not repeat openings.
- Preserved the 75% logical-processor ceiling.
- The conservative memory calculation limited this machine to five concurrent
  A/B jobs despite twelve CPU-eligible logical processors.
- Added campaign-limit, resume, resource, and A/B-SPRT tests.
- Added A/B candidate/baseline support to the standalone SPRT reader.

The 2,000-game campaign used approximately 637 MiB across the coordinator and
five active jobs during a sampled progress check, below the 1,536 MiB engine
budget.

## Aggressive adaptive LMR

| Test | Candidate | Baseline | Unresolved | Result |
| --- | ---: | ---: | ---: | --- |
| 10,000 nodes/move | 1,018 | 981 | 1 | SPRT continue |
| 250 ms/move | 64 | 35 | 1 | preliminary; SPRT continue |

The fixed-node campaign covered 2,000 games, averaged 54.98 plies, and split
candidate wins into 530 as periwinkle and 488 as blossom.

At fixed exhaustive depth five across 50 deterministic random positions,
aggressive LMR increased total root regret from 1,079 to 1,300 evaluation
units. It was better on two positions and worse on five. This accuracy
regression prevents promotion despite promising self-play.

## Safer variants

The conservative variant capped reductions at two and did not add reductions
to route-changing walls. It exactly matched baseline regret across the
50-position audit, but reduced the representative 250 ms average completed
depth from 8.0 to 7.5. It was rejected.

The guarded variant caps reductions at two and subtracts one reduction for
route-changing walls. Its depth-five audit reduced total regret slightly, from
1,079 to 1,059, with two improved positions and one worse position. Its first
fixed-node screen scored 264--236 over 500 games. A separate 250 ms screen
scored 62--38 over 100 games: 34 guarded wins as periwinkle and 28 as blossom,
versus 22 and 16 for baseline. Games averaged 53.36 plies. Both sequential
tests remain inside their continuation bounds, so these are preliminary
screens rather than promotion evidence.

## Promotion status

No LMR variant is enabled in production. Aggressive LMR remains held because
its deeper search coincides with higher fixed-depth regret. Guarded LMR remains
experimental: its early fixed-node and fixed-time scores are positive, but the
sample is below the planned promotion volume and its representative benchmark
did not improve completed depth at either 250 ms or one second.
