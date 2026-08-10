# Walver

Walver is a Stockfish-inspired position analyzer for the Wallz board game. It
provides an editable 9×9 board, full pawn and wall legality, shortest-path
evaluation, timed iterative-deepening alpha-beta search, transposition-table
caching, move ordering, and a principal variation.

## Run locally

Requires Node.js 22 or newer.

```bash
npm install
npm run dev
```

## Validate a production build

```bash
npm test
```

The GitHub Actions workflow in `.github/workflows/pages.yml` automatically
builds and deploys the `main` branch to GitHub Pages.

## Engine scope

Walver uses a handcrafted evaluation based on shortest paths, wall reserves,
mobility, tempo, and forced jumps. Wall moves are selectively searched around
critical paths, so this is an analysis aid rather than a solved-game oracle or
a trained NNUE engine.
