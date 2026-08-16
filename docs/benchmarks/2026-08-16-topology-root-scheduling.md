# Topology and dynamic-root phase

Status: preliminary research, 2026-08-16. Production remains unchanged.

## Pawn-triggered topology cache v4

The fourth topology design admits two complete reverse-distance fields only
when a pawn continuation can reuse an unchanged wall graph. One-off wall
children retain direct witness-path searches. Exact fixture parity passed.

| Budget | Baseline depth | Candidate depth | Baseline NPS | Candidate NPS |
| --- | ---: | ---: | ---: | ---: |
| 250 ms | 8.00 | 7.75 | 1,493,621 | 1,270,222 |
| 1 second | 10.00 | 9.25 | 1,477,567 | 1,239,369 |

The candidate lost one aggregate completed ply at 250 ms and three at one
second. Its full reverse fields cost more than the saved pawn-path searches.
The experiment is rejected; the direct witness path remains production.

## Persistent dynamic-root scheduler v6

The scheduler now waits for every Wasm worker to initialize, warms each worker
through the previous completed depth, searches the predicted principal move
first, distributes root tasks dynamically, and performs full-window re-searches
after failed bounds. A deterministic rank resolves equal scores only when the
previous move and score are stable. Unstable iterations fall back to exact
serial search.

At depth six with eight eligible workers:

| Position | Mode | Serial ms | Scheduled ms | Speedup | Move parity |
| --- | --- | ---: | ---: | ---: | --- |
| opening | dynamic | 1,803 | 977 | 1.85x | yes |
| channelled routes | serial fallback | 2,414 | 2,414 | 1.00x | yes |
| transposition rich | serial fallback | 2,125 | 2,125 | 1.00x | yes |

The dynamic opening achieved only 23.1% parallel efficiency, below the 60%
promotion target. An ungated run also exposed equal-score tie divergence and a
large regression on an unstable channelled position. The guarded scheduler is
therefore held as a research prototype rather than connected to Pages or the
extension.

## Shared-memory artifact

The Emscripten pthread/shared-memory artifact compiled and passed the same
parity and proof smoke tests. It is not production-enabled: independent
Emscripten instances cannot safely share a linear memory merely by passing the
same `WebAssembly.Memory`; a real shared transposition table requires a native
threaded runtime and coordinated memory ownership. The extension continues to
use isolated persistent workers and automatically avoids shared-memory claims.
