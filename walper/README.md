# walper

walper is a local Chrome/Chromium extension that reads the visible classic Wallz board and analyzes it with walwuk's exhaustive C++/WebAssembly engine.

It reads only rendered page elements on `wallz.gg`. It does not send board data to a server, click the board, or play moves automatically.

## Build

From the repository root:

```bash
npm install
npm run walper:build
```

The build requires the same pinned Emscripten 6.0.6 setup as walwuk. The unpacked extension is written to `walper/dist`.

## Install in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select the generated `walper/dist` folder.
5. Open a classic game on `https://www.wallz.gg/`.

The walper panel appears in the lower-left corner. Clicking the toolbar icon collapses or expands it.

After rebuilding or replacing the folder, return to `chrome://extensions` and click walper's reload button before refreshing the Wallz tab.

## What it detects

walper uses the site's visible SVG board rather than private application state:

- both pawn coordinates;
- every horizontal and vertical wall;
- the pulsing active-turn marker;
- `p1` and `p2` wall reserves;
- board rotation, used to infer which side belongs to the viewer.

The panel includes manual side, turn, and reserve overrides in case the website changes its rendering or the current page is a spectator/replay view.

## Analysis

Wallz `p2` maps to walwuk's upward-moving player zero, while Wallz `p1` maps to downward-moving player one. The extension packages the same single-threaded WebAssembly engine used by the walwuk site. Every legal wall is considered at every visited search node.

The suggested destination or wall is highlighted directly on the SVG board. The engine still has finite time and depth limits, so a suggestion is the best result from the deepest completed search—not proof that the complete game is solved.

## Scope

The detector targets the classic 9×9, ten-wall game. Race variants with different goals are not supported. Use analysis tools only where doing so is permitted by the game mode and the people you are playing with.
