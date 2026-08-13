# Walwuk maximum-strength phase two: status and complete roadmap

Last updated: 2026-08-12

This document is the pause-and-resume handoff for the full Phase Two program.
It records what is implemented, what the evidence currently proves, what is
still experimental, and every known task required before Phase Two can be
called complete.

No search experiment is promoted by this document. The production experiment
mask remains `0`.

## 1. Pause state

- All local match, campaign, training, and benchmark processes are stopped.
- Current branch: `codex/maximum-strength-phase2`.
- Pushed checkpoint commit: `cf2b805` (`Implement maximum-strength phase two research`).
- Draft pull request: [#5](https://github.com/souuk/walwuk/pull/5), targeting `main`.
- The worktree was clean immediately after the checkpoint commit. This handoff
  document is the only intended post-checkpoint source change.
- GitHub Pages has not been changed by this branch because the branch has not
  been merged to `main`.
- The local Windows machine has no compatible native C++ standard-library
  toolchain. Native CLI compilation and native/Wasm parity must therefore be
  confirmed by Linux CI or after installing a supported local toolchain.

## 2. Production safety contract

These rules remain mandatory for all future work:

1. The exhaustive implementation is the correctness reference.
2. Every legal root move is searched by the verifier before a depth is called
   verified.
3. Selective depth and `seldepth` are never presented as an exhaustive proof.
4. A move is never called globally perfect unless an exact solver has proven it.
5. Failed reduced or narrow-window searches are repeated at full depth/window
   whenever they may improve alpha.
6. A native transposition-table hit verifies the full packed position, so a
   collision cannot return another position's score.
7. Search workers never exceed `floor(0.75 * reported logical processors)` and
   are reduced further when the conservative known-memory budget is tighter.
8. Local training data stays below 25 GiB, generation stops at 22.5 GiB, and
   compressed shipped engine assets stay at or below 64 MiB.
9. Pages and walper use the same C++ source and must produce byte-identical
   single-worker engine artifacts.
10. No experiment becomes a production default merely because it raises NPS or
    displayed depth. It must pass exactness, fixed-node, fixed-time, and strength
    gates.

## 3. Implemented and retained work

### 3.1 Persistent engine and transposition reuse

Implemented:

- Persistent Web Workers and WebAssembly instances survive bounded analysis
  epochs instead of being recreated each second.
- Coordinator commands support `start`, `continue`, `rebase`, `cancel`, and
  `clear` behavior.
- The native transposition table, base move history, killer moves, and prior
  principal variation survive compatible requests.
- Deeper timed-search TT entries can provide valid production bounds; strict
  fixed-depth comparison mode retains exact horizon matching.
- Cross-request reuse is reported separately as `reusedNodes`.
- The visible recommendation is cleared immediately after a board change even
  though compatible internal search knowledge is retained.
- Each match now clears both engines at a game boundary while preserving reuse
  between moves within one game.

Measured evidence:

- A cleared expected-move position reached 8 ply at 1 second.
- Reusing the preceding search reached 9 ply and reused 6,343 nodes.
- Repeating the same opening reused 9,950 nodes.

### 3.2 Hybrid search and result metadata

Implemented:

- A deeper selective main lane and a separate exhaustive verifier lane.
- Additive result fields for main/selective depth, verified depth, `selDepth`,
  verifier nodes, reuse, topology counters, proof metadata, backend/version,
  confidence, stop reason, and resource use.
- Stop reasons distinguish `depth`, `time`, `nodes`, `cancelled`, and `error`
  where applicable.
- Continuous extension analysis accumulates nodes and diagnostic counters
  across epochs rather than resetting the displayed session totals.
- The extension's compact panel exposes only walls, winning, nodes, selective
  depth, verified/real depth, and speed.

### 3.3 Exact search and hot-path improvements

Implemented and retained:

- Iterative deepening, fail-soft negamax, alpha-beta, PVS, mate-distance bounds,
  aspiration windows, move ordering, and clustered transposition storage.
- Full packed-position TT verification and generation-based aging.
- Production reuse of deeper TT bounds with a strict parity mode.
- In-place make/unmake, packed moves, fixed arrays, bitboard-style 81-square
  path expansion, and precomputed wall conflict/blocking data.
- Lazy child path preparation so many cut-off moves never pay full path costs.
- Constant-time wall-mask mirroring retained from the rejected canonical-TT
  experiment.
- Exact left/right root symmetry reduction where the position is truly
  symmetric.
- Fixed-node native entry points for equal-work comparisons.
- Profile counters that compile out of production builds.

Implemented but disabled experiments:

- Two-tier topology cache with bounded incremental distance repair.
- Continuation, countermove, tactical-wall, and correction histories.
- Strategic wall-economy evaluation.
- Bounded quiescence.
- Adaptive reductions, reverse futility, razoring, ProbCut, history pruning,
  multi-cut, singular extensions, and forced-defense extensions.
- Left/right canonical TT storage.
- All-shortest-route wall candidate masks.

### 3.4 Exact solvers

Implemented:

- Exact zero-wall retrograde solving for root positions.
- Replayable zero-wall proof lines and proof distance.
- Cached solutions by fixed wall topology.
- A capped offline low-wall graph-builder prototype.

Evidence:

- A zero-wall near-win graph completed with 11,520 states and replayed its
  proof.
- A one-total-wall trial reached the configured 50,000-state ceiling and
  correctly returned unknown rather than fabricating a result.

### 3.5 Resource governor

Implemented:

- CPU scheduling capped at 75% of reported logical processors.
- Conservative engine-memory budgeting based on reported device memory, heap
  information when exposed, and a 256 MiB fallback.
- Worker count reduced by memory before permitting an oversized allocation.
- One-core devices use a corrected 3:1 active/idle duty cycle.
- Optional policy/value model bytes are counted once per worker and rejected
  when replicated allocations exceed the budget.
- Campaign concurrency is capped independently by CPU and known memory.

On the current 16-logical-processor machine, the two-hour pilot used eight jobs:
the 1.5 GiB engine-memory budget constrained it before the 12-job CPU ceiling.

### 3.6 Pages and walper integration

Implemented:

- Both applications consume the same native C++ core compiled to WebAssembly.
- Both use persistent coordinator/search-worker pools and the same result
  semantics.
- Walper declares cross-origin isolation and detects shared-memory capability,
  while retaining the tested isolated-worker fallback.
- The generated Pages and walper production artifacts are byte-identical.

Checkpoint artifact hashes:

- Wasm SHA-256: `14c9155493d19efaed284537f259d3a43fe09c90d8b7bbe3a920a44127e82eb9`
- JavaScript wrapper SHA-256: `4e802072c0c953648acc0918e401ab5461a43093a602ac3515bce5340adc4639`

### 3.7 Offline testing and campaign infrastructure

Implemented:

- Deterministic fixtures plus randomized rule/search parity.
- Root-score/regret audits over curated and seeded random positions.
- Paired, color-swapped A/B matches under fixed-time or fixed-node budgets.
- Resumable multi-job campaigns with ten-minute checkpoints, artifact/settings
  compatibility guards, three retries of the same failed opening, and explicit
  infrastructure-failure status.
- Campaign reports by budget, engine, color, game order, nodes, NPS, depth,
  game length, and SPRT decision.
- Competitive 180-second + 1-second clock support with a 15-second per-move cap.
- A dynamic-root scheduling benchmark.
- Native CLI, native/Wasm parity, PGO corpus, profile merge, and SIMD build
  tooling.
- Manifest and optional-asset budget validators.

### 3.8 Training and learned-model scaffolding

Implemented but not promoted:

- Schema-3 streaming JSONL data generation.
- Durable ten-minute checkpoints and truncation of uncheckpointed tails.
- Candidate labels that always include the deeper verifier move, include pawn
  moves where possible, and sample horizontal/vertical walls across the legal
  set.
- Deterministic train/validation splitting.
- Streaming policy and value trainers so a large dataset is not loaded wholly
  into RAM.
- Q10 integer policy and value model formats.
- Dependency-free deterministic C++ loading and inference.
- Per-worker model memory accounting and compatibility fallback.

Not yet done:

- No production-quality dataset has been generated.
- PyTorch is not installed on this machine.
- No learned policy or value model has passed held-out or match testing.
- Production still uses `handcrafted-v2` evaluation and `history-v1` ordering.

## 4. Completed validation evidence

The checkpoint passed:

- 10 curated fixtures through exhaustive depth 3.
- 2,000 deterministic randomized positions.
- Exhaustive fixed-depth score/move parity checks.
- Every experiment/proof smoke test.
- Resource-governor tests.
- 13 walper package tests.
- TypeScript type checking.
- ESLint.
- The 64 MiB optional-asset budget check (currently 0 shipped model files).
- Promotion-manifest consistency.
- GitHub Pages production build.
- Walper production build.
- Byte-for-byte Pages/walper artifact identity.
- `git diff --check` before the checkpoint commit.

Still required for a release-grade proof:

- The 100,000-position stress suite after all final changes.
- The 1,000,000-position release parity gate after all final changes.
- Linux native CLI compilation and native/Wasm parity in CI.
- Browser smoke tests on Chrome/Edge Pages, Firefox Pages, Safari-compatible
  fallback, and the unpacked Chrome extension.
- Worker crash, allocation failure, shared-memory fallback, reload, and stale
  cancellation tests in real browsers.

## 5. Baseline and match evidence collected

### 5.1 Autonomous hybrid-versus-exhaustive pilot

The pilot completed 1,200 paired jobs, 2,400 games, 145,720 plies, and
95,742,764,168 nodes with no job failures.

| Budget | Hybrid | Exhaustive | Unresolved | Hybrid P/B | Exhaustive P/B | Average plies |
| --- | ---: | ---: | ---: | --- | --- | ---: |
| 250 ms/move | 536 | 659 | 5 | 279 / 257 | 340 / 319 | 59.76 |
| 1 s/move | 570 | 618 | 12 | 264 / 306 | 287 / 331 | 61.67 |

Both SPRT results remain `continue`; neither is a promotion verdict. The older
pilot allowed cache inheritance into the color-swapped return game, so future
A/B results must use the corrected game-boundary clear protocol.

### 5.2 All-shortest-route accuracy and speed audit

At depth 3 over 10 fixtures plus 32 seeded random positions:

- Baseline maximum exhaustive-root regret: 151 evaluation units.
- Route-union maximum regret: 100 units.
- The known 151-unit missed wall was eliminated.

After making route-union construction demand-driven:

- Baseline and candidate both averaged 7.75 completed ply at 250 ms.
- Baseline median NPS: 1,283,308.
- Candidate median NPS: 982,478 (about 23% lower).
- Two of four preferred moves differed.

Equal-node match evidence:

- Initial 4 games at 50,000 nodes/move: candidate 0, baseline 4.
- Next 20 games at 50,000 nodes/move: candidate 7, baseline 13.
- Combined preliminary score: candidate 7, baseline 17.

Conclusion: route unions fix a real selective-coverage error, but the current
implementation fails the fixed-node non-regression screen. It must not be
promoted in its current form.

### 5.3 Preliminary 20-game fixed-node candidate screens

These screens finished just before the requested stop. They are useful triage,
not statistical promotion evidence.

| Candidate | Mask | W-L-U | Candidate P/B wins | Baseline P/B wins | Avg plies | Candidate depth | Baseline depth | Candidate NPS | Baseline NPS |
| --- | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: |
| Adaptive LMR | 64 | 10-10-0 | 4 / 6 | 4 / 6 | 54.60 | 8.167 | 7.302 | 1,208,155 | 1,225,299 |
| Reverse futility | 512 | 9-11-0 | 7 / 2 | 8 / 3 | 53.25 | 8.878 | 8.304 | 1,371,308 | 1,239,458 |
| ProbCut | 2048 | 12-8-0 | 7 / 5 | 5 / 3 | 59.00 | 7.501 | 7.637 | 1,308,704 | 1,234,508 |
| Multi-cut | 8192 | 14-6-0 | 6 / 8 | 2 / 4 | 53.90 | 8.684 | 9.650 | 1,362,589 | 1,280,954 |
| All-shortest routes | 131072 | 7-13-0 | 2 / 5 | 5 / 8 | 54.55 | 8.074 | 8.241 | 1,233,782 | 1,696,011 |

Interpretation:

- Multi-cut is the strongest game-score lead in this tiny screen, but its
  candidate average depth was lower. It needs pruning-audit and root-regret
  evidence before more games.
- ProbCut has a small positive score and NPS signal, but no depth advantage in
  this sample. It remains a reasonable second candidate.
- Adaptive LMR is score-neutral and achieved substantially greater average
  depth at nearly equal NPS. It deserves a selective-regret audit.
- Reverse futility is slightly negative despite higher depth and NPS.
- All-shortest routes is negative and slower; redesign it before retesting.

Twenty games cannot establish strength. None of these results changes the
production mask or satisfies the planned SPRT gate.

## 6. Current experiment decisions

The authoritative machine-readable source is
[`engine-native/promotion-manifest.json`](../../engine-native/promotion-manifest.json).

### Retained production behavior

- Experiment mask `0`.
- Handcrafted evaluator v2.
- History ordering v1.
- Persistent exact-verified TT.
- Exact zero-wall root solver.
- Isolated WebAssembly workers.

### Held for additional evidence

- Strategic wall-economy evaluator (`4`).
- Bounded quiescence (`32`).
- Adaptive late-move reductions (`64`).
- Reverse futility (`512`).
- ProbCut (`2048`).
- Multi-cut (`8192`).
- All-shortest-route selective walls (`131072`), although current fixed-node
  evidence says redesign before promotion testing.

### Rejected in their current forms

- Two-tier delayed topology cache v2 (`1`).
- Continuation/tactical-wall history v2 (`2`).
- Internal zero-wall solver (`8`).
- Partial selection (`16`).
- Correction history (`128`).
- Razoring (`1024`).
- History pruning (`4096`).
- Singular extension v1 (`16384`).
- Forced-defense extension v1 (`32768`).
- Canonical left/right TT (`65536`).
- Current SIMD build variant.

Rejected implementations can be redesigned, but their old measurements must
not be discarded or relabeled as successful.

### Untrained/prototype components

- Learned policy ordering.
- Learned value evaluation (`256`).
- Low-wall tablebases.
- Proof-number search.
- Dynamic root queue (57.9% measured efficiency; gate is 60%).
- Shared-memory extension artifact (parity passed, no shared TT yet).

## 7. Complete future-work roadmap

### Stage 0: Resume safely

On the next work session:

1. Confirm there are no running `node`, compiler, campaign, or training jobs.
2. Confirm branch and worktree state.
3. Read this handoff, the benchmark report, pilot baseline, and promotion
   manifest before changing code.
4. Check draft PR #5 and its Linux CI results.
5. If CI fails, fix CI/parity before starting more engine experiments.
6. Preserve the production mask at `0` until a candidate passes every gate.

### Stage 1: Close checkpoint validation gaps

1. Run the GitHub Actions job on PR #5 or a temporary validation branch.
2. Confirm native CLI compilation with the pinned Emscripten/Clang setup.
3. Confirm native/Wasm rule, fixed-depth, score, best-move, and PV parity.
4. Run the 100,000-position stress suite.
5. Run the 1,000,000-position release parity suite under the 75% limit.
6. Add automated verification that Pages and walper artifacts are byte-identical.
7. Run browser smoke tests for Pages base-path loading and extension reload.
8. Test cancellation, rebase, stale results, worker crash, memory-allocation
   failure, and fallback behavior in actual browsers.
9. Verify the one-core 3:1 duty cycle through measured elapsed active time.
10. Verify no result after a win contains a playable best move.

### Stage 2: Audit the promising selective candidates

Test one flag at a time, in this priority order:

1. Multi-cut (`8192`) because its initial fixed-node score is strongest.
2. ProbCut (`2048`) because it has positive initial score and NPS.
3. Adaptive LMR (`64`) because it gained depth without an initial score loss.
4. Reverse futility (`512`) only after the first three.
5. Strategic evaluator (`4`) and quiescence (`32`) as accuracy projects, not
   raw speed projects.
6. All-shortest routes (`131072`) only after redesigning its route-union cost.

For each candidate:

1. Run deterministic pruning-audit instrumentation.
2. Record every skipped/reduced move and whether it later failed high.
3. Compare sampled internal nodes against exhaustive replay.
4. Expand root-regret audits beyond 32 random positions and include all known
   wall-starvation, backward-pawn, near-goal, route-fork, and forced-defense
   failures.
5. Test fixed depth where the feature actually activates; a depth-3 audit does
   not exercise pruning that starts at depth 5 or 6.
6. Reject immediately on a false forced win, missed mandatory defense, illegal
   move, or exhaustive score inconsistency.
7. Tune constants only on training fixtures; use separate held-out fixtures for
   promotion.

### Stage 3: Run the statistical promotion ladder

Only candidates passing Stage 2 enter this ladder:

1. 20,000 paired fixed-node games at a low node budget.
2. 4,000 color-swapped pairs at 250 ms/move.
3. 2,000 pairs at 1 second/move.
4. 500 pairs at 5 seconds/move.
5. 200 pairs at 10 seconds/move.
6. 100 pairs at 15 seconds/move.
7. Full competitive 3+1 clock matches.

Every campaign must:

- Use the corrected game-boundary cache-clear protocol.
- Use deterministic, color-swapped openings.
- Record candidate/baseline wins by periwinkle and blossom.
- Record unresolved games and average/median/min/max plies.
- Record nodes, time, NPS, main depth, verified depth, and `seldepth`.
- Record walls used by phase, walls left at loss, and backward pawn moves.
- Record PV stability and root regret against a longer verifier.
- Record engine hash, evaluator/model version, seed, resource settings, and
  campaign checkpoint.
- Apply an SPRT-style gate with 5% false-positive and false-negative targets,
  testing `H0 <= -2 Elo` against `H1 >= +5 Elo`.
- Stop early on a statistically supported loss or correctness regression.

Promotion requires perfect exactness, fixed-node non-regression, positive
fixed-time evidence, no tactical-suite regression, and consistent behavior in
both single-worker Pages and walper configurations.

### Stage 4: Redesign route coverage without the speed loss

The all-shortest-route experiment solves a real omission but is currently too
expensive. Future designs should test:

1. Cache all-shortest-route masks by wall topology and pawn square separately
   from ordinary witness paths.
2. Admit a union entry only after repeated topology use.
3. Compute route unions only at nodes where selective wall generation will run.
4. Retain two or more independent route certificates and construct a full union
   only when those certificates disagree or are invalidated.
5. Derive candidate walls from forward/reverse distance equality without storing
   the complete predecessor DAG.
6. Store compact per-edge route criticality masks in the topology tier.
7. Reuse union data across pawn moves on the same wall layout.
8. Profile route-union time separately from path distance and legality work.
9. Re-run the known 151-unit failure after every optimization.
10. Require fixed-node non-regression before any timed match campaign.

### Stage 5: Revisit exact topology and move-generation optimization

The topology-cache and partial-selection prototypes regressed. A new exact
design must proceed in isolated steps:

1. Profile full path searches, route checks, move generation, TT access, and
   ordering on opening, dense-wall, low-reserve, and near-goal corpora.
2. Cache reverse goal-distance fields by wall topology, not pawn position.
3. Reuse those fields for both pawn locations via lookup.
4. Validate bounded incremental wall repair against full recomputation on at
   least one million randomized position/wall pairs.
5. Fall back to full flood fill when the affected region exceeds a measured
   threshold.
6. Keep reachability certificates exact; a certificate may skip a BFS only when
   it proves a route remains.
7. Implement a staged `MovePicker` that delays legality/path work until a move
   is actually selected for search.
8. Use partial selection only if it beats the current ordering in time-to-depth;
   the rejected implementation must not be reused unchanged.
9. Add a cache-size and admission sweep under realistic worker memory budgets.
10. Promote only exact optimizations with identical root scores and lower
    time-to-depth across the corpus.

### Stage 6: Improve exact ordering and TT quality

1. Re-test persistent pawn, wall, continuation, countermove, tactical-wall,
   cutoff, and negative histories individually.
2. Decay histories between generations rather than clearing them.
3. Ensure history only orders moves until strength evidence supports pruning.
4. Tune aspiration windows from measured score volatility.
5. Revisit internal iterative reduction when no reliable TT move exists.
6. Measure exact/bound entry usefulness, collisions, replacements, and aging.
7. Sweep TT cluster sizes, alignment, and per-worker table sizes.
8. Keep strict fixed-depth parity mode independent from timed production reuse.
9. Revisit symmetry canonicalization only if hashing/reflection costs can be
   removed from the hot path; the rejected version lost 32% median NPS.
10. Add persistent-cache version keys for engine, evaluator, policy, and model.

### Stage 7: Complete dynamic parallel search

1. Move root work from fixed partitions to a persistent dynamic queue.
2. Search the predicted best root move first and publish its score.
3. Let workers pull remaining root moves dynamically.
4. Search alternatives with safe narrow windows and re-search fail-highs fully.
5. Accept a completed depth only after all required root tasks finish.
6. Reuse persistent workers so startup does not dominate shallow depths.
7. Measure efficiency at 1, 2, 4, 8, 12, and 16 reported processors.
8. Reach at least 60% parallel efficiency at the automatically selected limit.
9. Reduce workers when UI latency, thermal throttling, memory pressure, or
   efficiency below 55% is observed.
10. Preserve deterministic tie-breaking and reproducible fixed-depth results.

### Stage 8: Complete shared-memory walper search

1. Keep the current isolated-worker implementation as fallback.
2. Use shared Wasm memory only when the offscreen document is genuinely
   cross-origin isolated.
3. Implement one shared TT rather than merely compiling a shared artifact.
4. Share topology cache, root incumbent, task queue, stop flag, and generation
   metadata safely.
5. Audit atomics and table replacement for race safety.
6. Compare shared-table Lazy SMP/root work stealing with isolated workers.
7. Verify extension reload, service-worker suspension, and offscreen recovery.
8. Require exact single-thread parity and statistically positive multi-thread
   strength before promotion.
9. Keep GitHub Pages on isolated workers because Pages cannot conveniently
   supply the required isolation headers.

### Stage 9: Expand exact solvers

Proceed in increasing state-space order:

1. One-sided zero-wall positions.
2. One total wall.
3. Two total walls where measured storage permits.
4. Near-goal proof-number search.
5. Compact tablebase generation and lookup.

For every solver:

- Enumerate the complete reachable graph before declaring an exact result.
- Treat cycles or unfinished regions as unknown.
- Store a replayable certificate.
- Independently replay every certificate through the normal rules engine.
- Version data by rule and coordinate format.
- Count decompressed memory against the engine budget.
- Keep all compressed table/model assets together below 64 MiB.
- Measure whether lookup saves more time than it costs.

### Stage 10: Tune the strategic handcrafted evaluator

The strategic evaluator is implemented but untuned. Future evaluation work:

1. Build a labeled corpus from deeper exhaustive/verifier searches, self-play,
   real exported positions, and adversarial failures.
2. Keep opening, middlegame, low-wall, near-goal, and wall-starvation held-out
   sets.
3. Tune transparent integer features before training a neural value model.
4. Include route race, second/third routes, route multiplicity, bottlenecks,
   corridor width, goal entries, jumps, opposition, last-three-wall scarcity,
   useful wall delay, own-route damage, future anchors, postponement value, and
   ability to answer the opponent's best wall.
5. Ensure no feature forces a move or encodes opening theory as a hard rule.
6. Compare coordinate descent, SPSA, and CMA-ES under the 75% resource cap.
7. Test wall-starvation and backward-pawn regret explicitly.
8. Version tuned weights and include evaluator version in TT identity.
9. Promote only on held-out accuracy and paired strength evidence.

### Stage 11: Train and evaluate learned policy ordering

1. Install an optional local PyTorch environment or use a separate training
   machine; runtime remains Python-free.
2. Run a short data-generation pilot and measure records/hour, bytes/hour, and
   label quality.
3. Confirm projected storage remains below 25 GiB.
4. Generate versioned, compressed shards with engine hash, seed, evaluator,
   time/node budget, and resource settings.
5. Include self-play and only explicitly exported user positions.
6. Train the existing two-hidden-layer quantized candidate scorer.
7. Use symmetry augmentation and stratified held-out sets.
8. Verify deterministic Q10 C++ inference against Python outputs.
9. Initially allow the model to order moves only; it cannot remove a legal move.
10. Measure cutoff rate, time-to-depth, fixed-node strength, and fixed-time
    strength.
11. Keep the handcrafted ordering fallback for missing/incompatible assets.
12. Promote only after the full statistical ladder.

### Stage 12: Train and evaluate learned value

Begin only after policy ordering is stable:

1. Generate deeper verifier scores and game outcomes for value labels.
2. Implement/train the planned compact incrementally updatable NNUE-style
   feature representation, or document why the current compact MLP is superior.
3. Use deterministic clipped integer inference.
4. Blend exact tactical/path terms outside the learned score.
5. Verify native/Wasm/Python inference parity.
6. Measure inference cost and time-to-depth, not just prediction loss.
7. Test out-of-distribution wall-starvation, sparse-wall, dense-wall, and
   near-goal positions.
8. Reject any model whose strength gain does not compensate for search slowdown.
9. Keep the model plus every optional table below the 64 MiB compressed limit.
10. Version model identity in TT/cache entries and the promotion manifest.

### Stage 13: Native and WebAssembly optimization

After search architecture stabilizes:

1. Build and run the native CLI on Linux and a supported local C++ toolchain.
2. Generate representative PGO profiles from openings, dense walls, races,
   low reserves, and self-play.
3. Compare `-O3`, LTO, PGO, Binaryen, and SIMD independently.
4. Inspect generated Wasm for path expansion, make/unmake, evaluation, ordering,
   and TT probes.
5. Separate hot and cold position/search data.
6. Align TT clusters and benchmark layouts.
7. Remove remaining allocation, string, stream, and JSON work from active search.
8. Use compact binary progress/result transport if profiling shows material gain.
9. Tune time-check intervals from observed NPS while preserving time-control
   safety.
10. Record rejected compiler/layout variants to prevent repeated work.
11. Judge success by time-to-depth and playing strength, not NPS alone.

### Stage 14: Full competitive-clock validation

1. Simulate the real 180-second initial clock with a one-second increment.
2. Cap every move at 15 seconds.
3. Allocate more time when the leading moves are close, the PV is unstable, or
   verifier/main disagree.
4. Allocate less time in exact/proven or low-wall endgames.
5. Maintain an explicit clock reserve and never exceed remaining time.
6. Test approximately 40-move games as well as long 120-ply edge cases.
7. Record time forfeits and scheduling overruns as failures.
8. Compare single-worker and resource-capped multi-worker modes.

### Stage 15: Production promotion and deployment

For a candidate that passes every prior stage:

1. Update the promotion manifest with exact evidence and artifact hashes.
2. Enable only that candidate's reviewed flag/settings in production.
3. Rebuild Pages and walper from the same source.
4. Re-run one-million parity, tactical suites, resource checks, browser tests,
   lint, TypeScript, native/Wasm parity, asset budget, and artifact identity.
5. Update README and benchmark documentation.
6. Commit the candidate separately from research tooling.
7. Push a review branch and open/update a PR.
8. Merge to `main` only after CI and promotion evidence pass.
9. Verify GitHub Pages deployment and Wasm loading under `/walwuk/`.
10. Load the unpacked extension and run a real Wallz scanning/analysis smoke test.
11. Keep the prior stable engine as an explicit fallback.

## 8. Acceptance checklist for declaring Phase Two complete

Phase Two is not complete until all applicable boxes are proven:

- [ ] One-million rule/path/search parity passes on final production code.
- [ ] Native and Wasm fixed-depth results are identical.
- [ ] Pages and walper single-worker results are identical.
- [ ] No illegal move, false forced win, post-win best move, or proof replay
      failure exists in the final suites.
- [ ] Persistent rebase demonstrably reuses work after expected moves.
- [ ] Current verified depth is at least 35% faster to reach than the original
      Phase Two baseline.
- [ ] Opening selective depth improves by at least two plies at 10-15 seconds.
- [ ] Opening verified depth improves by at least one ply.
- [ ] Extension parallel efficiency is at least 60% at the chosen worker limit.
- [ ] Wall-starvation and backward-pawn regret decrease without tactical loss.
- [ ] Every promoted pruning/evaluation change passes fixed-node and fixed-time
      statistical gates.
- [ ] Any learned component wins statistically under equal resources.
- [ ] All runtime, simulation, training, and benchmark jobs obey the 75% CPU and
      conservative memory policies.
- [ ] Training data and shipped assets remain within 25 GiB and 64 MiB limits.
- [ ] Competitive 3+1 clock simulations pass without time overruns.
- [ ] Browser and extension fallback/reload/cancellation tests pass.
- [ ] Production never labels an unproven result globally perfect or solved.
- [ ] Documentation, promotion manifest, artifact hashes, and deployment state
      agree with the final build.

## 9. Recommended next-session sequence

The safest and highest-information order is:

1. Inspect PR #5 CI and fix any Linux/native issue.
2. Commit this handoff document separately if desired.
3. Run selective/pruning audits for multi-cut, ProbCut, and adaptive LMR.
4. Reject any candidate with a correctness or tactical-regret failure.
5. Run a larger fixed-node screen for the surviving candidate only.
6. Start one resource-capped resumable campaign; do not run several promotion
   campaigns that compete for the same CPU/memory budget.
7. Analyze color, game length, depth, NPS, regret, and SPRT evidence.
8. Promote, retune, reject, or keep held based on that evidence.
9. Redesign route-union caching separately from pruning work.
10. Begin learned-policy data generation only after the promoted search/evaluator
    baseline is stable, so labels are not invalidated by immediate engine changes.

## 10. Things that must not be done on resume

- Do not enable all held flags together and infer which one helped.
- Do not promote multi-cut from a 14-6 result or ProbCut from a 12-8 result.
- Do not call selective depth verified depth.
- Do not treat a higher NPS as stronger play.
- Do not treat a deeper reduced line as a uniformly completed depth.
- Do not hide failed or rejected experiment results.
- Do not reuse the old pilot's cross-game cache protocol for promotion matches.
- Do not train on user positions without explicit export.
- Do not exceed the 75% resource policy for campaigns or training.
- Do not merge the draft research PR to `main` merely because the checkpoint
  tests pass; production promotion requires the strength gates above.

