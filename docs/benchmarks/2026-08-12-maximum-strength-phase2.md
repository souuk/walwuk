# Maximum-strength program: phase two — 2026-08-12

Phase two separates deployable improvements from research components. The
production experiment mask remains `0`; a feature is not enabled merely because
it compiles or reaches a higher selective depth.

## Retained production work

- WebAssembly instances and search workers persist across bounded 1, 2, 4, and
  8 second epochs.
- The transposition table, base history, killers, and principal variation remain
  available after a played move. Full packed-position verification remains in
  every table entry.
- Cross-request cache use is reported as `reusedNodes` instead of being hidden
  inside ordinary TT hits.
- A cleared opening search reached 8 ply after the expected first move; keeping
  the prior calculation reached 9 ply and reused 6,343 nodes. Repeating the same
  opening reused 9,950 nodes.
- Root positions with no remaining walls return an exact retrograde outcome and
  a replayable optimal certificate.
- One-core devices enforce a measured 3:1 active/idle epoch duty cycle.
  The initial implementation double-counted the idle quarter and delivered
  only about 56% active time; the corrected scheduler searches a full epoch
  (20% verifier, 80% main) before the duty-cycle rest, preserving the 75% cap.
- Walper declares cross-origin isolation and detects shared-memory capability,
  while continuing to use the parity-tested isolated-worker fallback.

## Experiment screen

All experiments are versioned in
[`engine-native/promotion-manifest.json`](../../engine-native/promotion-manifest.json).
At 250 ms across opening, channelled, low-reserve, and transposition-rich
positions, the baseline averaged 8 completed selective plies. Incremental
topology caching briefly matched that depth and improved average NPS by 2.7%,
but at one second it reduced average NPS by 25% without adding depth; it was
rejected. Partial selection, eager internal zero-wall solving, quiescence,
correction history, and untuned continuation history were also slower. Adaptive
reductions gained one aggregate ply in the short screen but changed two of four
moves, so they remain held pending larger regret and match tests.

## Parallel research

A dynamic exact root queue preserves the full root score. On the opening at
depth 5 it reduced wall time from 7,201 ms with one worker to 1,557 ms with eight
workers: 4.63× speedup and 57.9% efficiency. The promotion target is 60%, so the
prototype is retained but the browser scheduler has not been switched. At depth
3, worker startup dominated and eight workers were slightly slower.

The shared-memory Emscripten artifact compiled and passed the same two-ply,
proof-replay, and experiment smoke tests. It does not yet contain a shared TT,
so it is not shipped.

## Offline research tooling

- A resumable campaign runner checkpoints every ten minutes, stops at 22.5 GiB,
  records score by color and game length, and limits jobs by both CPU and known
  memory. It supports both hybrid-versus-exhaustive and candidate-versus-
  baseline A/B campaigns, refuses to mix changed settings or engine artifacts
  into an existing checkpoint, and reports time- or node-budget groups with
  separate SPRT decisions. A failed job retries the same color-swapped opening
  up to three times rather than silently skipping it and biasing the sample.
- Competitive-clock matches implement 180 seconds plus a one-second increment,
  with a 15-second maximum allocation.
- Candidate-level JSONL generation streams data under the same storage cap.
- Optional policy and value trainers export deterministic Q10 integer models.
  Model bytes are counted once per worker before loading; a policy or value
  asset is refused when its replicated allocation would exceed the engine
  memory budget. Training shards are streamed per epoch; policy holds one
  candidate group and value uses a bounded configurable batch, so large local
  datasets are not loaded wholesale into RAM.
- Seven additional selective-search mechanisms now have independent flags and
  per-mechanism counters. Exhaustive parity passed with every flag enabled
  individually. At 250 ms, ProbCut gained three aggregate plies and reverse
  futility gained one across four positions. At one second, multi-cut gained
  two aggregate plies while ProbCut and reverse futility gained one each.
  All three remain held because each changed two of four preferred moves.
  Razoring, history pruning, the first singular-extension design, and the
  forced-defense extension failed their initial speed/depth screens and remain
  disabled.
- `scripts/engine-ab-match.mjs` provides paired, color-swapped A/B matches
  between any two experiment masks, recording wins by color, average game
  length, depth, nodes, and NPS. Native fixed-node entry points allow the same
  harness to compare search quality at equal node counts, not merely equal
  wall-clock time. It is queued for the held pruning candidates after the
  active campaign releases memory capacity.
- Training data is now schema version 3. Candidate sampling always retains the
  deeper verifier move, includes all pawn moves that fit, and spreads remaining
  samples across horizontal and vertical walls instead of taking the first move
  codes. The value model's duplicated mobility input was corrected to encode
  current-player and opponent mobility separately. Generation has durable
  ten-minute checkpoints and truncates an uncheckpointed tail before resuming.
- Exact left/right TT canonicalization and all-shortest-route candidate masks
  are implemented as disabled experiments. Canonical cache parity includes a
  mirrored-position reuse and move-coordinate round trip. The canonical table
  was rejected after an optimized screen lost two aggregate plies and reduced
  median NPS by 32% at 250 ms. Its constant-time wall-reflection primitive is
  retained for cheaper exact root-symmetry checks. All-shortest-route coverage
  remains held for strength testing. Demand-driven route unions avoid doing
  union work at leaves, recovering the original one-ply regression and reducing
  its 250 ms median-NPS cost from 43% to 23%. The baseline and experiment both
  averaged 7.75 completed plies; median NPS was 1,283,308 versus 982,478, and
  two of four preferred moves differed. On the ten fixtures plus 32 seeded
  random positions at depth 3, route unions reduced maximum exhaustive-root
  regret from 151 to the accepted 100-unit margin and eliminated the 151-unit
  miss entirely. A mode-tagged reuse of the existing path cache passed parity
  but produced no measurable recovery and was reverted.
- Continuous analysis now accumulates leaf, cutoff, reduction, pruning,
  extension, and symmetry counters across epochs, matching the already
  cumulative node, time, TT, and topology totals.
- The native CLI, PGO corpus, profile merge, and native/Wasm parity jobs are
  available for Linux CI and local native toolchains. A separate `--simd`
  WebAssembly build is available for autovectorization trials without changing
  the production artifact. It passed parity but was rejected: three-trial
  250 ms medians produced the same 399,582-byte artifact, reduced average
  depth from 8.00 to 7.75, and reduced average NPS from 1,457,446 to
  1,426,536.
  This Windows host has no Visual Studio C++ standard library, `clang++`, or
  `g++`, so the native CLI could not be rebuilt locally; the Linux Pages job
  remains the authoritative native/Wasm comparison gate.
- A capped low-wall graph builder returns exact results only after fully
  enumerating its reachable graph. A zero-wall near-win graph completed with
  11,520 states; a one-total-wall trial hit 50,000 states and correctly returned
  unknown.

## Autonomous baseline pilot

The eight-job resource-capped pilot completed 1,200 paired jobs: 2,400 games,
145,720 plies, and 95,742,764,168 searched nodes. It used eight of the twelve
CPU jobs allowed on the reported 16 logical processors because the 1.5 GiB
engine budget limited concurrency first. There were no job failures.

At 250 ms, hybrid scored 536 wins, exhaustive scored 659, and 5 games reached
the ply limit. Hybrid won 279 as periwinkle and 257 as blossom; exhaustive won
340 as periwinkle and 319 as blossom. Games averaged 59.76 plies. At one
second, hybrid scored 570, exhaustive scored 618, and 12 were unresolved.
Hybrid won 264 as periwinkle and 306 as blossom; exhaustive won 287 as
periwinkle and 331 as blossom. Games averaged 61.67 plies.

Both configured SPRT decisions remain `continue`: neither baseline result is a
promotion verdict. The color-swapped return game inherited caches in this
older pilot protocol, so first and return games are recorded separately in
[`phase2-pilot.json`](../../engine-native/baselines/phase2-pilot.json). New A/B
matches clear each engine at the game boundary while retaining TT and history
reuse between moves inside that game.

## Checkpoint validation

The production experiment mask remains `0`. The final rebuilt artifact passed
all ten curated fixtures through depth 3, 2,000 randomized rule/search
comparisons, the resource governor, all experiment/proof smoke tests, the 13
walper package tests, TypeScript, lint, the 64 MiB asset-budget check, the
promotion-manifest check, and both production builds. Pages and walper contain
byte-identical engine artifacts: Wasm SHA-256
`14c9155493d19efaed284537f259d3a43fe09c90d8b7bbe3a920a44127e82eb9` and
JavaScript wrapper SHA-256
`4e802072c0c953648acc0918e401ab5461a43093a602ac3515bce5340adc4639`.
