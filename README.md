# walwuk

walwuk is a browser-based position analyzer for the Wallz board game. It combines an interactive 9×9 board with a C++/WebAssembly, Stockfish-inspired search engine that evaluates routes, walls, mobility, and forced wins.

**[play walwuk](https://souuk.github.io/walwuk/)**

![walwuk board and analysis panel](docs/assets/walwuk-board.png)

## Contents

- [What walwuk does](#what-walwuk-does)
- [The game model](#the-game-model)
- [Using the application](#using-the-application)
- [How the algorithm works](#how-the-algorithm-works)
- [Reading the analysis](#reading-the-analysis)
- [Local development](#local-development)
- [Validation](#validation)
- [Deployment](#deployment)
- [Contributing](#contributing)
- [Known limitations](#known-limitations)
- [License](#license)

## What walwuk does

walwuk lets you construct and analyze positions rather than forcing you to play a complete game from the starting position. You can move either pawn, place legal walls, rotate the board, and use undo/redo to inspect alternatives.

The engine can be toggled on or off. When it is enabled, it searches from the current position and reports the strongest move it found within the selected time and depth limits. The C++ engine runs as WebAssembly inside a Web Worker, so searching does not freeze the board controls. A TypeScript implementation remains as a temporary compatibility fallback and correctness reference.

### Features

- Editable 9×9 board with legal pawn movement and wall placement.
- Periwinkle and blossom player colors.
- New game, undo, redo, left/right arrow-key history controls, and board rotation.
- Engine toggle with exponential-style thinking-time presets from 250 ms to 30 s.
- Search-depth control from 2 to 12 ply.
- Evaluation bar, best move, shortest paths, node count, search speed, and transposition-table statistics.
- Board interaction locks after a win and finishes with a winner-colored animation.

## The game model

The board has 81 pawn squares arranged as a 9×9 grid. Walls occupy the spaces between squares and can be horizontal or vertical. Each player starts with one pawn and ten walls.

Periwinkle starts at the bottom and tries to reach the top row. Blossom starts at the top and tries to reach the bottom row. A player wins immediately when their pawn reaches their target row.

The engine stores a complete position in a `GameState` object from [`app/engine.ts`](app/engine.ts):

```ts
export interface GameState {
  pawns: [Square, Square];
  walls: Wall[];
  wallsLeft: [number, number];
  turn: Player;
}
```

`pawns[0]` is periwinkle, `pawns[1]` is blossom, and `turn` identifies the player whose move is next. A move is either a pawn move or a wall move:

```ts
export type PawnMove = { kind: "pawn"; to: Square };
export type WallMove = { kind: "wall"; wall: Wall };
export type Move = PawnMove | WallMove;
```

## Using the application

1. Click a softly marked destination square to move the current pawn.
2. Click an empty wall slot to place a legal horizontal or vertical wall.
3. Select **new game** to reset the position.
4. Select **undo** or **redo**, or press the left and right arrow keys, to navigate move history.
5. Select **rotate** to view the board from the opposite orientation.
6. Toggle **engine** to start or pause analysis.
7. Adjust **thinking time** to change the time budget and **depth** to change the maximum search depth.
8. Select **play** on the best-move card to apply the engine’s current recommendation.

The board cannot be edited after a player wins. The engine also stops searching at that point, and no best move is offered for a finished position.

### Paths

The status line shows `paths x / y`:

- `x` is periwinkle’s shortest currently available route to the top goal;
- `y` is blossom’s shortest currently available route to the bottom goal.

These are distances in pawn moves, not a prediction of the final score. A wall can increase one path, decrease another, or make a different route become shortest.

### Depth and ply

A **ply** is one move by one player. A periwinkle move is one ply; blossom’s reply is a second ply. Therefore, a search of 12 ply can examine up to six complete periwinkle/blossom turns along a line.

Greater depth usually gives the engine more tactical foresight, but it also increases the number of positions it must inspect. The time limit still takes precedence: if the timer expires during a depth, walwuk returns the last depth that completed fully.

## How the algorithm works

The production search is implemented in [`engine-native/walwuk_engine.cpp`](engine-native/walwuk_engine.cpp), compiled to WebAssembly with Emscripten, and executed through [`app/engine-worker.ts`](app/engine-worker.ts). [`app/engine.ts`](app/engine.ts) contains the readable TypeScript rules, UI helpers, move explanations, and temporary reference search.

```text
react interface
    ↓ position + limits
web worker
    ↓ one packed position
c++ webassembly engine
    ↓ progress about once per second
web worker
    ↓ progress / final result
react interface
```

JavaScript crosses into WebAssembly only when a search starts, when progress is reported, and when the final result is returned. Move generation, pathfinding, evaluation, recursion, pruning, and caching stay inside native code during a search.

At a high level, every analysis follows this pipeline:

```text
current position
    ↓
generate legal pawn moves and selective wall candidates
    ↓
order promising moves first
    ↓
search each candidate recursively
    ↓
evaluate leaf positions and terminal wins
    ↓
prune branches that cannot improve the result
    ↓
cache reusable positions
    ↓
repeat at greater depths until the limit or timer is reached
    ↓
return the best move from the deepest completed search
```

### 1. Detecting walls between squares

Before a pawn can move, the engine checks whether a wall blocks the edge between its current square and its destination. Horizontal walls block vertical movement; vertical walls block horizontal movement.

```ts
export function blocked(a: Square, b: Square, walls: Wall[]): boolean {
  if (a.r !== b.r) {
    const row = Math.min(a.r, b.r);
    return walls.some(
      (w) => w.o === "h" && w.r === row &&
        (w.c === a.c || w.c + 1 === a.c),
    );
  }

  const col = Math.min(a.c, b.c);
  return walls.some(
    (w) => w.o === "v" && w.c === col &&
      (w.r === a.r || w.r + 1 === a.r),
  );
}
```

This function is the basic collision rule used by pawn movement, pathfinding, and wall legality.

### 2. Generating pawn moves

The engine checks the four neighboring squares. A normal destination is accepted when it is inside the board and not blocked:

```ts
if (!inside(adjacent) || blocked(own, adjacent, state.walls)) continue;
if (!sameSquare(adjacent, other)) {
  destinations.push(adjacent);
  continue;
}
```

When the opponent’s pawn is directly adjacent, walwuk first tries to jump over it:

```ts
const beyond = { r: other.r + dr, c: other.c + dc };
if (inside(beyond) && !blocked(other, beyond, state.walls)) {
  destinations.push(beyond);
  continue;
}
```

If a wall prevents the jump, the engine adds side-step squares beside the opposing pawn. Destinations are deduplicated before they become `PawnMove` objects.

### 3. Validating wall moves

Walls are rejected if they are outside the wall grid, if the current player has none remaining, or if they overlap or cross an existing wall. The engine then tests the important rule that both players must retain at least one route to their goal:

```ts
const trial = { ...state, walls: [...state.walls, wall] };
return shortestPath(trial, 0).distance < 99 &&
       shortestPath(trial, 1).distance < 99;
```

The trial position is only used for validation. The wall is added to the real position later by `applyMove` if the move is selected.

### 4. Finding shortest paths

`shortestPath` uses breadth-first search. Breadth-first search is appropriate here because every pawn step has the same cost: one move.

```ts
const queue: Square[] = [start];
const seen = new Set([`${start.r},${start.c}`]);
```

The search explores reachable squares until it finds the player’s target row. It records each square’s parent so it can reconstruct one shortest route, not just the distance.

```ts
if (current.r === targetRow) {
  const path = [current];
  // follow parent links back to the starting square
  path.reverse();
  return { distance: path.length - 1, path };
}
```

The same pathfinder is used in three places:

1. to display the current path lengths;
2. to evaluate a position;
3. to reject walls that close every route.

### 5. Generating wall candidates selectively

The theoretical number of wall placements is large, especially as the board fills. Searching every legal wall at every node would make a browser search slow. walwuk therefore creates a tactical candidate set around strategically relevant areas:

```ts
const us = shortestPath(state, state.turn);
const them = shortestPath(state, (1 - state.turn) as Player);
candidatesFromPath(them.path, candidates);
candidatesFromPath(us.path.slice(0, 5), candidates);
```

It also includes nearby horizontal and vertical walls around both pawns. Candidates are deduplicated, checked with `isLegalWall`, and converted to `WallMove` objects:

```ts
return [...candidates.values()]
  .filter((wall) => isLegalWall(state, wall))
  .map((wall) => ({ kind: "wall", wall }));
```

This is one of the main differences from a fully exhaustive solver: wall search is deliberately selective.

### 6. Evaluating a position

If the search reaches its depth limit without a win, it uses a static evaluation. The absolute score combines three practical signals:

```ts
const pathScore = (amber - blue) * 100;
const wallScore = (state.wallsLeft[0] - state.wallsLeft[1]) * 13;
const mobility = (mobilityBlue - mobilityAmber) * 4;
return pathScore + wallScore + mobility;
```

The path term is intentionally strongest. Being one move closer to goal is worth substantially more than having one extra wall or one extra legal move. The wall and mobility terms help break ties and recognize positions where a player has more flexibility.

Scores are always converted to the perspective of the side whose turn it is:

```ts
return state.turn === 0 ? absolute : -absolute;
```

That convention lets one recursive function evaluate both players consistently.

### 7. Detecting wins

The win test is simple:

```ts
export function winner(state: GameState): Player | null {
  if (state.pawns[0].r === 0) return 0;
  if (state.pawns[1].r === 8) return 1;
  return null;
}
```

Wins receive a score far larger than normal positional differences:

```ts
const WIN = 100_000;
```

During recursive search, the score is adjusted by the distance in plies to prefer a quicker win and resist a loss for as long as possible:

```ts
if (won !== null) return won === state.turn
  ? WIN - ply
  : -WIN + ply;
```

### 8. Searching with negamax

walwuk uses negamax, a compact form of minimax. Instead of writing separate “max” and “min” functions, it always searches from the current player’s perspective and negates the child result:

```ts
const score = -negamax(
  applyMove(state, move),
  depth - 1,
  -beta,
  -alpha,
  ply + 1,
);
```

If a child position is good for the opponent, negating its score makes it bad for the current player. This allows the same code to handle both sides.

The engine keeps the highest-scoring move at each node:

```ts
if (score > bestScore) {
  bestScore = score;
  best = move;
}
```

### 9. Pruning with alpha-beta bounds

Alpha-beta pruning avoids searching moves that cannot change the decision. `alpha` is the best score already guaranteed to the current player. `beta` is the threshold at which the opponent has found a better alternative elsewhere.

```ts
alpha = Math.max(alpha, score);
if (alpha >= beta) break;
```

When `alpha` reaches or exceeds `beta`, the remaining moves at that node cannot produce a better usable result, so the branch is cut off.

This does not mean the engine has proven every skipped move is objectively losing. It means those moves cannot improve the decision relative to a line already found within the current search window.

### 10. Caching repeated positions

Different move orders can lead to the same position. The C++ engine stores analyzed positions in a fixed-size, contiguous transposition table. Each entry contains both wall masks, packed pawn/reserve/turn metadata, the searched depth, score bound, and best move.

The readable TypeScript reference represents the same identity with a map:

```ts
const tt = new Map<string, TTEntry>();
```

The key includes the side to move, both pawn locations, remaining walls, and a sorted representation of placed walls:

```ts
return `${state.turn}|${state.pawns[0].r}${state.pawns[0].c}|` +
  `${state.pawns[1].r}${state.pawns[1].c}|` +
  `${state.wallsLeft.join(",")}|${walls}`;
```

The native table hashes that identity to a slot but verifies the complete packed identity before using an entry. A collision can therefore replace or miss a cached result, but cannot return another position's score. A result is reused only when it was searched deeply enough:

```ts
if (cached && cached.depth >= depth) {
  ttHits++;
  // use the cached exact or bounded result
}
```

### 11. Ordering moves before searching

Alpha-beta pruning is most effective when strong moves are searched first. walwuk assigns priorities to moves before recursion:

```ts
let priority = ttMove && moveKey(ttMove) === moveKey(move)
  ? 1_000_000
  : 0;
```

Immediate wins receive a large bonus:

```ts
if (winner(next) === state.turn) priority += 500_000;
```

Pawn moves toward the goal and walls that lengthen the opponent’s shortest path are also preferred. This is a performance optimization: it changes the order of exploration, not the rules of the game.

### 12. Iterative deepening

The engine searches one depth at a time:

```ts
for (let depth = 1; depth <= limits.maxDepth; depth++) {
```

At the end of every completed depth, it saves the current best move and principal variation. If the timer expires during the next depth, the previous completed result remains safe to return.

For deeper searches, it first uses a narrow aspiration window around the previous score:

```ts
alpha = completed.score - 175;
beta = completed.score + 175;
```

If the score falls outside that window, it retries the depth with the full score range:

```ts
if (score <= alpha || score >= beta) {
  score = negamax(initial, depth, -INF, INF, 0);
}
```

### 13. Time management

The engine creates a deadline from the configured thinking time:

```ts
const started = performance.now();
const deadline = started + limits.timeMs;
```

Both engines check the clock every 256 searched nodes. The TypeScript reference expresses the check as:

```ts
if ((nodes & 255) === 0 && timedOut()) {
  throw new Error("timeout");
}
```

The native search uses a timeout flag instead of throwing through C++ search frames. Both engines stop cleanly and return the last fully completed depth. Results carry an internal stop reason (`depth`, `time`, `cancelled`, or `error`) so a time-limited result is distinguishable from completing the requested depth.

### 14. Principal variation and worker communication

The principal variation (PV) is the engine’s current predicted sequence of best moves. walwuk reconstructs it by following the best cached move from the original state:

```ts
const move = tt.get(stateKey(state))?.best;
if (!move) break;
pv.push(move);
state = applyMove(state, move);
```

The TypeScript reference shows the same progress contract in its simplest form:

```ts
self.onmessage = (event) => {
  const result = analyze(event.data.state, event.data.limits, (progress) => {
    self.postMessage({ type: "progress", result: progress });
  });
  self.postMessage({ type: "done", result });
};
```

The production worker loads the WebAssembly module and forwards the same messages. The UI starts a fresh analysis whenever the position, engine toggle, time limit, or depth changes. It terminates the worker when the engine is turned off or the game ends. If WebAssembly cannot initialize after one retry, the worker reports the fallback and runs the TypeScript engine instead.

## Reading the analysis

- **eval**: the engine’s current score from periwinkle’s perspective. Positive values favor periwinkle; negative values favor blossom.
- **even**: the current evaluation is approximately balanced.
- **`periwinkle +3.00 moves`**: the handcrafted evaluation favors periwinkle by roughly three path-equivalent moves. This is not a literal score or guaranteed result.
- **forced win**: the search found a terminal winning line within the completed search horizon.
- **best**: the first move in the current principal variation.
- **depth**: the deepest fully completed search depth, measured in plies.
- **nodes**: positions searched.
- **nps**: nodes per second.
- **tt hits**: positions answered from the transposition table instead of being searched again.

## Local development

Requires Node.js 22.13.0 or newer and Emscripten 6.0.6. Install and activate the pinned SDK through [emsdk](https://github.com/emscripten-core/emsdk):

```bash
git clone https://github.com/emscripten-core/emsdk.git .emsdk
./.emsdk/emsdk install 6.0.6
./.emsdk/emsdk activate 6.0.6
```

On Windows, use `emsdk.bat` for the last two commands. The build helper automatically detects an SDK installed in the repository's ignored `.emsdk` directory. If Emscripten is installed elsewhere, activate its environment before running npm commands.

```bash
npm install
npm run dev
```

`npm run dev` compiles the C++ engine and then starts Vite. Generated `.mjs` and `.wasm` files are placed under `public/engine/`, copied into the static build, and intentionally excluded from Git.

## Validation

Run all checks before opening a pull request:

```bash
npm run engine:test:full
npm run engine:benchmark
npm run lint
npm run typecheck
npm run build
```

`engine:test:full` compares both searches through 6 ply on curated positions and compares movement, every legal wall, candidate ordering, paths, and evaluation on 2,000 deterministic random positions. `engine:benchmark` reports TypeScript and WebAssembly NPS on fixed positions and fails if WebAssembly is slower. `npm run build` creates the GitHub Pages output in `dist-pages`.

For a quicker development check, `npm run engine:test` uses 4 ply and 250 random positions. The worker backend can be selected internally with `VITE_ENGINE_BACKEND=wasm`, `typescript`, or `compare`; production defaults to `wasm`.

## Deployment

Every push to `main` triggers [`.github/workflows/pages.yml`](.github/workflows/pages.yml). The workflow installs Emscripten 6.0.6 and Node.js 22, runs full native parity, lint, and TypeScript checks, builds the static site, uploads `dist-pages`, and deploys it to [GitHub Pages](https://souuk.github.io/walwuk/).

## Contributing

1. Create a focused branch.
2. Make a focused change.
3. Run the build, lint, and TypeScript checks.
4. Open a pull request with a concise description.
5. Include screenshots when changing the UI.

When changing engine behavior, describe the rule or evaluation change and include a position that demonstrates it. When changing the UI, check both desktop and narrow/mobile layouts for overflow and clipped text.

## Known limitations

- The engine is an analysis aid, not a solved-game oracle.
- Wall search is selective rather than exhaustive, so not every legal wall placement is considered at every node.
- Evaluation is handcrafted and path-based; it is not a trained NNUE engine.
- A finite depth and time limit can cause a tactical win or loss beyond the current search horizon to be missed.
- The native engine is single-threaded and avoids browser features that require cross-origin isolation.
- The native transposition table is fixed at 32 MiB and is discarded with the worker when a new search starts.

## License

walwuk is available under the [MIT License](LICENSE). Copyright © 2026 souwuk.
