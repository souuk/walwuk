# walwuk

walwuk is a browser-based position analyzer for the Wallz board game, with an interactive 9×9 board and a Stockfish-inspired search engine.

[play walwuk](https://souuk.github.io/walwuk/)

![walwuk board and analysis panel](docs/assets/walwuk-board.png)

## Features

- Interactive 9×9 board with legal pawn movement and wall placement.
- Periwinkle and blossom player colors.
- New game, undo, redo, arrow-key history controls, and board rotation.
- Optional engine toggle with adjustable thinking time and search depth.
- Evaluation bar, best move, shortest paths, and principal variation output.
- Board interaction locks after a win and finishes with a winner-colored animation.

## How to use

1. Click a softly marked destination square to move the current pawn.
2. Click an empty wall slot to place a legal horizontal or vertical wall.
3. Use **new game** to reset the position.
4. Use **undo** and **redo**, or press the left and right arrow keys, to navigate move history.
5. Use **rotate** to view the board from the opposite orientation.
6. Toggle **engine** to start or pause analysis.
7. Adjust **thinking time** to control the time budget for each analysis and **depth** to set the maximum search depth.

The status line shows `paths x / y`, where `x` is periwinkle’s current shortest route to the top goal and `y` is blossom’s shortest route to the bottom goal. A **ply** is one half-move: one move by one player. Two plies make one complete turn by both players.

## Engine overview

The engine is implemented in [`app/engine.ts`](app/engine.ts) and runs in a browser Web Worker through [`app/engine-worker.ts`](app/engine-worker.ts).

It evaluates positions using:

- shortest-path distance to each goal;
- walls remaining;
- legal movement options (mobility).

For search, it combines:

- legal pawn and wall generation;
- selective tactical wall candidates near critical paths and pawns;
- iterative deepening, so completed results are available at progressively greater depths;
- negamax search with alpha-beta pruning;
- transposition-table caching for positions reached through different move orders;
- move ordering that prioritizes wins, previously strong moves, forward pawn moves, and disruptive walls;
- configurable time and depth limits.

The engine returns the best move from its deepest fully completed search before the time limit expires. It is designed as a practical browser analysis aid rather than a solved-game oracle.

## Local development

Requires Node.js 22.13.0 or newer.

```bash
npm install
npm run dev
```

## Validation

Run the production build, lint checks, and TypeScript validation before opening a pull request:

```bash
npm run build
npm run lint
npx tsc --noEmit
```

## Deployment

Every push to `main` triggers [`.github/workflows/pages.yml`](.github/workflows/pages.yml), which builds the static site and deploys it to [GitHub Pages](https://souuk.github.io/walwuk/).

## Contributing

1. Create a focused branch.
2. Make a focused change.
3. Run the build, lint, and TypeScript checks.
4. Open a pull request with a concise description. Include screenshots for UI changes.

## Known limitations

- The engine is an analysis aid, not a solved-game oracle.
- Wall search is selective rather than exhaustive, so not every legal wall placement is searched at every node.
- Evaluation is handcrafted and path-based; it is not a trained NNUE engine.

## License

No license has been specified yet. Until a license is added, do not assume that the source may be reused, redistributed, or included in another project.
