# Evidence ledger

The ledger maps manuscript claims to immutable snapshots. Generated assets are derived from the snapshots; authoritative historical reports remain in `docs/benchmarks/`.

| Claim | Snapshot field | Status | Original evidence |
| --- | --- | --- | --- |
| One-million random comparisons, zero mismatches | `validation.randomPositions`, `validation.mismatches` | validated | Phase One report |
| Opening 5 s and 15 s time-to-depth | `phaseOne.openingTimeToDepth` | validated benchmark | Phase One report |
| 1/4/12-worker aggregate NPS | `phaseOne.parallel` | preliminary performance | Phase One report |
| Expected-move TT reuse | `phaseTwo.persistence` | validated benchmark | Phase Two baseline |
| Dynamic root speedup and efficiency | `phaseTwo.dynamicRoot` | held prototype | Phase Two report |
| 2,400-game pilot outcomes | `pilot.aggregate`, `pilot.controls` | preliminary/inconclusive | Phase Two pilot |
| Experiment decisions | `experiments` | promoted/held/rejected/untrained | Promotion manifest |
| Zero-wall and low-wall solver states | `solvers` | validated/prototype | Phase Two report |

The snapshot manifest in `generated/snapshot-manifest.json` records the SHA-256 digest of every curated JSON file. If an old snapshot must be corrected, add a replacement snapshot and retain the superseded file for auditability.

| Phase Three exact hot-path and resume checks | `phaseThree.hotPath`, `phaseThree.resume` | preliminary/validated behavior | Phase Three tranche-one report |
| Phase Three pruning screens | `phaseThree.pruning` | preliminary/rejected | Fixed-node A/B JSON reports |

## Selective validation (paper v0.4)

- Source snapshot: data/selective-validation-preliminary.json
- Base engine commit: 2e700e6f41f85719a91481a7fc00d6c3e53c33d3
- Artifact SHA-256: 67273e5126777118008f025fd43c81da41edc235c36fcdde3d2a1701387302b1
- Claims: adaptive and guarded LMR paired scores, color splits, average plies,
  depth-five root regret, resource limits, and inconclusive SPRT status.
- Status: preliminary; neither candidate is promoted.
- Raw campaign-summary checksums are embedded in the snapshot.

## Guarded LMR one-second screen (paper v0.5)

- Source snapshot: data/guarded-lmr-one-second-preliminary.json
- Engine checkpoint: 29302ae
- Claims: score and color split, plies, nodes, NPS, resource policy, and rejection decision.
- Status: preliminary result; candidate rejected by the fixed-time non-regression gate.

## Topology and root scheduling (paper v0.6)

- Source snapshot: data/phase5-topology-root-preliminary.json
- Engine base checkpoint: 8619249
- Claims: topology-v4 depth/NPS regression, dynamic-root depth-six timing,
  stability fallback, efficiency, parity, and shared-artifact status.

## Exact TT and dynamic root v7 (paper v0.7)

- Source snapshot: `data/phase6-phase7-preliminary.json`
- Base engine checkpoint: `f4f951e`
- Artifact SHA-256: `4423e941f282aabf0c086c6cf9fd040d1b070f16fcb4e0cb2e593c9f2b1c58c6`
- Claims: exact TT cluster correction, preliminary 250 ms/one-second depth and
  NPS totals, seed-first root timings, worker efficiency, re-search counts, and
  move parity.
- Status: Phase 6 retained; Phase 7 held below the 60% efficiency gate.
- Status: topology v4 rejected; dynamic root v6 held; shared artifact prototype only.
## Shared TT and low-wall proofs (paper v0.8)

- Source snapshot: `data/phase8-phase9-preliminary.json`
- Claims: shared-table fixed-depth parity, median speedup and efficiency at two,
  four, and eight threads, held deployment status, proof states, replay status,
  certificate hashes, and explicit solver limitations.
- Status: Phase 8 held pending browser lifecycle validation; Phase 9 partially
  implemented with exact bounded outcomes but without general low-wall tables.
