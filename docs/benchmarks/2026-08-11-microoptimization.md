# Exact search micro-optimization — 2026-08-11

This pass optimized native search throughput without changing legal move
coverage, selective pruning policy, evaluation scores, or fixed-depth results.

## Retained changes

- enumerate structurally available walls from 64-bit masks instead of scanning
  all 128 placements;
- update blocked board edges with precomputed masks;
- cache exact shortest-path witnesses on established wall layouts, while using
  direct bitboard BFS for sparse and empty openings;
- precompute near-pawn selective wall masks;
- count mobility without constructing temporary move lists;
- sort compact move indices rather than copying full path-bearing moves;
- compute shallow static evaluation only where selective futility pruning uses
  it;
- pack transposition metadata once per clustered lookup.

Experiments using table-driven pawn neighbors, reconstructed structure-of-array
move buffers, a four-times-larger path cache, and a doubled transposition table
were rejected because they reduced measured WebAssembly throughput.

## Correctness

- native and TypeScript parity: 10 curated fixtures through 3 ply;
- deterministic rule parity: 2,000 random legal positions in the full gate;
- exhaustive root audit: all 1,260 legal root moves across the fixtures at
  depth 3;
- maximum selective root regret: 0 evaluation units;
- resource policy, lint, TypeScript, Pages build, and extension tests passed.

## One-second position benchmark

The comparison excludes the two immediate-win fixtures, which finish the
requested depth before consuming the time allowance.

| mode | before average NPS | after average NPS | change |
| --- | ---: | ---: | ---: |
| exhaustive | 1,547,835 | 1,705,436 | +10.2% |
| selective | 329,496 | 408,304 | +23.9% |

Every nontrivial selective fixture improved. The largest gain was the
low-reserve position: +33.5% exhaustive NPS and +49.5% selective NPS.

## Five-second position benchmark

| mode | NPS change | average depth before | average depth after |
| --- | ---: | ---: | ---: |
| exhaustive | +6.1% | 5.50 | 5.62 |
| selective | +28.2% | 8.62 | 8.88 |

The channelled-route fixture gained one selective ply. The low-reserve fixture
gained one exhaustive and one selective ply.

Timed browser and operating-system measurements vary with CPU load, thermal
state, and WebAssembly warm-up. Fixed-depth parity and all-root regret are the
correctness gates; repeated same-machine timed runs measure throughput.
