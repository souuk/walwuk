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