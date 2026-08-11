(function installWalperCore(root) {
  const PLAYER_TO_ENGINE = Object.freeze({ p1: 1, p2: 0 });
  const ENGINE_TO_PLAYER = Object.freeze(["p2", "p1"]);

  function normalizePlayer(value, fallback) {
    return value === "p1" || value === "p2" ? value : fallback;
  }

  function clampWalls(value, fallback) {
    if (value === "" || value === null || value === undefined) return fallback;
    const parsed = Number(value);
    return Number.isInteger(parsed) ? Math.max(0, Math.min(10, parsed)) : fallback;
  }

  function toEngineState(scan, overrides = {}) {
    const turn = normalizePlayer(overrides.turn, scan.turn);
    const p1Walls = clampWalls(overrides.p1Walls, scan.wallsRemaining.p1);
    const p2Walls = clampWalls(overrides.p2Walls, scan.wallsRemaining.p2);
    return {
      pawns: [
        { r: scan.pawns.p2.y, c: scan.pawns.p2.x },
        { r: scan.pawns.p1.y, c: scan.pawns.p1.x },
      ],
      walls: scan.walls.map((wall) => ({ r: wall.y, c: wall.x, o: wall.o })),
      wallsLeft: [p2Walls, p1Walls],
      turn: PLAYER_TO_ENGINE[turn],
    };
  }

  function stateSignature(state) {
    const walls = state.walls
      .map((wall) => `${wall.o}${wall.r}${wall.c}`)
      .sort()
      .join(",");
    return `${state.turn}|${state.pawns[0].r}${state.pawns[0].c}|` +
      `${state.pawns[1].r}${state.pawns[1].c}|${state.wallsLeft.join(",")}|${walls}`;
  }

  function enginePlayerName(player) {
    return ENGINE_TO_PLAYER[player] ?? "unknown";
  }

  function formatMove(move, flipped = false) {
    if (!move) return "none";
    if (move.kind === "pawn") {
      const rank = flipped ? move.to.r + 1 : 9 - move.to.r;
      return `pawn → ${String.fromCharCode(97 + move.to.c)}${rank}`;
    }
    const rank = flipped ? move.wall.r + 1 : 8 - move.wall.r;
    return `${move.wall.o === "h" ? "horizontal" : "vertical"} wall · ` +
      `${String.fromCharCode(97 + move.wall.c)}${rank}`;
  }

  function formatEvaluation(result, state) {
    const score = Number(result?.score ?? 0);
    if (!Number.isFinite(score) || !state) return "—";
    if (Math.abs(score) < 10) return "even";
    const favoredEnginePlayer = score > 0 ? state.turn : 1 - state.turn;
    const player = enginePlayerName(favoredEnginePlayer);
    if (Math.abs(score) >= 99_900) return `${player} · forced win`;
    return `${player} ahead · +${(Math.abs(score) / 100).toFixed(2)}`;
  }

  root.WalperCore = Object.freeze({
    ENGINE_TO_PLAYER,
    PLAYER_TO_ENGINE,
    enginePlayerName,
    formatEvaluation,
    formatMove,
    stateSignature,
    toEngineState,
  });
})(globalThis);
