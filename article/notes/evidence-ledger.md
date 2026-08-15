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
