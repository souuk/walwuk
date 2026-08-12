# Selective engine experiment

walwuk keeps its exhaustive engine as the correctness baseline and fallback. The comparisons below explain the plausible search that originally became the production backend. Production now runs that search as the **main lane** beside a shallower exhaustive **verifier lane**. The main lane provides depth; until same-depth root-score verification is available, any move disagreement is resolved in favor of the verifier.

Every legal root move is now retained in both lanes. Selective wall filtering applies only below the root. Worker count is capped at 75% of reported logical processors and by a conservative WebAssembly memory budget.

## Search differences

The selective engine still generates every legal pawn move. Its plausible wall candidates are limited to placements that touch either player's current shortest-path witness or lie near either pawn. Every retained wall receives the normal structural and path-existence validation. At non-root nodes up to five ply deep, a depth-dependent move-count threshold can discard late, low-priority walls after stronger candidates have been searched.

The recursive search adds several techniques modeled on Stockfish's search structure:

- late-move reductions search less-promising later moves at reduced depth and restore full depth if the reduced search raises alpha;
- shallow late-move pruning stops searching late wall moves after a depth-dependent count;
- shallow futility pruning skips late wall moves whose static evaluation is sufficiently below alpha;
- internal iterative reduction removes one ply at deeper non-root nodes that have no cached best move;
- principal variation search, aspiration windows, iterative deepening, clustered transposition caching, and move ordering remain enabled.

The experiment deliberately omits null-move pruning. Passing is not a legal Wallz move, and pawn races can make the assumption behind a synthetic pass unsafe.

Stockfish's implementation is substantially more sophisticated and continuously tuned through large statistical tests. Its search is deterministic rather than random or probability-sampled: statistical history values and other heuristics affect ordering, reductions, and pruning. Relevant primary references are its current [`search.cpp`](https://github.com/official-stockfish/Stockfish/blob/master/src/search.cpp) and official definitions of [late-move pruning and reductions](https://official-stockfish.github.io/docs/stockfish-wiki/Terminology.html#late-move-pruning).

## Match harness

Build and run color-swapped games with:

```bash
npm run engine:match -- --games 8 --move-ms 250 --max-plies 100
```

The short match is a fast regression screen. Competitive testing uses a
10-second normal allowance and a 15-second hard ceiling, reflecting a roughly
40-move game played with a three-minute clock and one-second increment:

```bash
npm run engine:match:competitive -- --games 8
npm run engine:match:long -- --games 8
npm run engine:tournament -- --pairs 6
```

Searches finish before the allowance when every requested depth is complete.
Promotion decisions compare decision quality, verified depth, and time-to-depth
in addition to NPS.
The tournament command runs the 10- and 15-second color-swapped suites in
parallel. It caps concurrent engine processes at 75% of reported logical
processors and at a conservative 50% memory budget, then preserves every raw
match and an aggregate summary under `outputs/engine-tournaments/`.
An interrupted or still-growing result directory can be summarized again with
`npm run engine:tournament -- --summary-only --output <result-directory>`.

The first completed hybrid baseline is recorded in
[`docs/benchmarks/2026-08-11-hybrid.md`](benchmarks/2026-08-11-hybrid.md).

`--move-ms` is clamped to at most 15,000 ms. Requests of five seconds or more reserve a 100 ms guard for call overhead, so a five-second wall-clock limit supplies 4,900 ms of native search. Games start in matched pairs: both games use the same deterministic opening, and the engines exchange colors. A game that has not ended by `--max-plies` is reported as unresolved rather than treated as a draw.

For a quick position comparison:

```bash
npm run engine:benchmark:selective -- 1000 15
```

## Initial results

Twenty-eight games were simulated during implementation. The first two were 50 ms smoke tests capped at 40 ply and both remained unresolved. The 26 scored games produced:

| Move budget | Games | Selective | Exhaustive | Unresolved |
| --- | ---: | ---: | ---: | ---: |
| 100 ms | 12 | 3 | 9 | 0 |
| 250 ms | 8 | 4 | 4 | 0 |
| 500 ms | 4 | 2 | 2 | 0 |
| 14,900 ms | 2 | 1 | 1 | 0 |
| **Total scored** | **26** | **10** | **16** | **0** |

In the full-budget color-swapped pair, selective won as periwinkle in 71 ply and exhaustive won as periwinkle in 67 ply. Selective averaged 13.51 completed ply and searched 176.3 million nodes; exhaustive averaged 10.91 ply and searched 632.6 million nodes. Both engines were allowed 14.9 seconds on every move, but later positions frequently completed the then-current 15-ply maximum early. Approximate measured averages were 7.1 seconds per selective move and 8.4 seconds per exhaustive move.

Across all scored games, selective search averaged approximately 11.45 completed ply per move, compared with 9.37 for exhaustive search. It searched about 234.7 million nodes while exhaustive search inspected about 817.0 million. On three one-second fixture searches, selective search gained two to three completed ply and chose the same move as exhaustive search in all three positions.

This is a small, deterministic engineering sample, not a statistically meaningful strength rating. Its main conclusion is that aggressive pruning achieves the requested depth increase, but the 10–16 historical match score also demonstrates that a larger depth number does not guarantee greater accuracy. The full-budget pair split 1–1 and was decided by the first-moving periwinkle side in both games. Production now uses the revised plausible policy, while exhaustive search remains available as the reference for continued tuning.

## Revised plausible-move policy

After the initial sample, late wall pruning was extended through depth five with a depth-dependent plausible-move threshold. A new color-swapped pair used a five-second wall-clock limit per move, implemented as 4,900 ms of native search plus a 100 ms guard.

| Game | Selective side | Winner | Length |
| --- | --- | --- | ---: |
| 1 | periwinkle | selective | 43 ply |
| 2 | blossom | exhaustive | 61 ply |

The revised selective engine averaged 12.42 completed ply and searched 60.1 million nodes. Exhaustive averaged 8.63 ply and searched 237.4 million nodes. Maximum measured move time was 4,934 ms. The match split 1–1, and the first-moving periwinkle side won both games, so this pair cannot distinguish engine strength from first-player advantage. Average game length was 52 ply.
