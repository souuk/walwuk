# Maximum-strength program: phase one — 2026-08-11

This phase implements exact hot-path and search-foundation work from the
maximum-strength program. It does not claim that the full program, learned
evaluation, or full 9×9 solving is complete.

## Retained changes

- Generate structurally possible walls cheaply and defer path work until
  alpha-beta actually searches a candidate.
- Preserve exact legality by recomputing a path whenever a wall intersects the
  retained route certificate; illegal candidates never enter the tree.
- Keep exact pawn-path ordering while using cheap route-intersection ordering
  for walls.
- Reuse deeper transposition bounds during timed production searches while
  retaining strict-horizon behavior for parity tests.
- Collapse exact left-right root symmetries and search one representative.
- Solve positions that begin with zero wall reserves by retrograde analysis of
  the fixed-topology pawn state graph.
- Remove the arbitrary twelve-worker cap. CPU and known-memory budgets remain
  the limits, so a 16-thread machine still receives twelve workers.
- Add an optional profiling build and a repeatable 250 ms–15 second benchmark
  matrix.

## Correctness gates

- Native/TypeScript parity passed on all 10 curated fixtures through three
  plies and on 2,000 deterministic random legal positions.
- The release-scale rule, move, wall-legality, path, and evaluation gate passed
  on 1,000,000 additional deterministic random positions with zero mismatch.
  It used eight 125,000-position shards: the reported 16 processors permitted
  twelve workers, while the conservative 1.5 GiB known-memory budget limited
  the run to eight. Wall time was 408 seconds.
- The zero-reserve solver returns a legal fastest winning move in its targeted
  fixture and never supplies a root score without a playable move.
- Split-root and full-root fixed-depth scores remain equal.
- The depth-three all-root audit scored 1,260 legal moves. Nine fixtures had
  zero selective regret; channelled routes had 88 units of regret, below the
  configured one-path-equivalent 100-unit margin. The verifier overrides that
  disagreement in production.
- The exhaustive verifier still generates every legal wall. Symmetric root
  moves are omitted only when their scores are mathematically identical to a
  searched reflection.

## Opening time-to-depth

Same machine and opening fixture:

| search | previous 5 s | phase-one 5 s | previous 15 s | phase-one 15 s |
| --- | ---: | ---: | ---: | ---: |
| exhaustive depth | 5 | 6 | 6 | 6 |
| selective depth | 8 | 10 | 9 | 11 |
| selective NPS | 253,950 | 703,023 | 263,129 | 669,041 |

At five seconds the selective and exhaustive moves differed, so production
hybrid analysis uses the verifier move. At ten and fifteen seconds they agreed
on advancing the opening pawn.

## Parallel throughput

On the i5-12600KF:

| workers | aggregate NPS | minimum completed depth | wall time |
| ---: | ---: | ---: | ---: |
| 1 | 1,365,118 | 5 | 2,004 ms |
| 4 | 6,500,663 | 5 | 2,089 ms |
| 12 | 22,681,141 | 5 | 2,179 ms |

Split-root node counts are not identical to single-search node counts, so the
apparently superlinear NPS figure is not a claim of greater than 100% hardware
efficiency. Wall-clock completion and minimum completed depth remain the
authoritative parallel metrics.

## Match smoke test

Four color-swapped 250 ms games finished 2–2 between hybrid and exhaustive.
Hybrid won both games as periwinkle and lost both as blossom; the sample is far
too small for a strength conclusion. Games lasted 55, 67, 63, and 63 plies
(62 plies on average), and no search returned an unusable move.

## Profiling sample

A diagnostic 250 ms run showed why deferred wall work helps. In the opening
exhaustive search, 3,152,481 structurally available wall candidates were seen,
but only 393,228 child positions were prepared. In the channelled selective
position, 1,577,234 candidates produced only 102,860 prepared children.

## Rejected experiments

- Eagerly constructing full 81-square distance fields for every encountered
  wall topology reduced throughput by 20–90%. A future topology cache must be
  promoted only after repeated use is observed.
- More aggressive adaptive late-move reductions gained depth in some
  positions but lost up to two plies in low-reserve positions. The established
  reduction schedule remains in production.
- Invoking the zero-wall retrograde solver for every topology reached during a
  low-reserve search caused severe one-off construction costs. It is therefore
  enabled only when analysis begins with both reserves already empty.
- Canonicalizing every transposition-table probe through a mirrored wall mask
  gained cache hits in some positions but no completed depth. Median selective
  NPS fell about 5%, and exhaustive throughput also regressed. Exact symmetric
  root reduction remains, but per-node mirrored TT canonicalization was removed.

## Remaining program

Persistent cancellable worker pools, dynamic root work stealing, a cheaper
symmetry-cache design, tuned strategic evaluation, low-wall proof solvers,
policy training, NNUE-style evaluation, PGO, and the full statistical promotion
ladder remain separate phases. Each must pass fixed-depth parity and paired
self-play before production promotion.
