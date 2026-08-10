export type Player = 0 | 1;

export type Square = { r: number; c: number };
export type Wall = { r: number; c: number; o: "h" | "v" };

export type PawnMove = { kind: "pawn"; to: Square };
export type WallMove = { kind: "wall"; wall: Wall };
export type Move = PawnMove | WallMove;

export interface GameState {
  pawns: [Square, Square];
  walls: Wall[];
  wallsLeft: [number, number];
  turn: Player;
}

export interface AnalysisLimits {
  maxDepth: number;
  timeMs: number;
}

export interface AnalysisResult {
  bestMove: Move | null;
  score: number;
  depth: number;
  pv: Move[];
  nodes: number;
  nps: number;
  timeMs: number;
  ttHits: number;
  selective: boolean;
}

const SIZE = 9;
const INF = 1_000_000;
const WIN = 100_000;
const DIRS = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
] as const;

export const INITIAL_STATE: GameState = {
  pawns: [
    { r: 8, c: 4 },
    { r: 0, c: 4 },
  ],
  walls: [],
  wallsLeft: [10, 10],
  turn: 0,
};

const sameSquare = (a: Square, b: Square) => a.r === b.r && a.c === b.c;
const inside = (s: Square) => s.r >= 0 && s.r < SIZE && s.c >= 0 && s.c < SIZE;
const moveKey = (move: Move) =>
  move.kind === "pawn"
    ? `p${move.to.r}${move.to.c}`
    : `${move.wall.o}${move.wall.r}${move.wall.c}`;

export function blocked(a: Square, b: Square, walls: Wall[]): boolean {
  if (a.r !== b.r) {
    const row = Math.min(a.r, b.r);
    return walls.some(
      (w) => w.o === "h" && w.r === row && (w.c === a.c || w.c + 1 === a.c),
    );
  }
  const col = Math.min(a.c, b.c);
  return walls.some(
    (w) => w.o === "v" && w.c === col && (w.r === a.r || w.r + 1 === a.r),
  );
}

function pathNeighbors(square: Square, walls: Wall[]): Square[] {
  const out: Square[] = [];
  for (const [dr, dc] of DIRS) {
    const next = { r: square.r + dr, c: square.c + dc };
    if (inside(next) && !blocked(square, next, walls)) out.push(next);
  }
  return out;
}

export function shortestPath(
  state: GameState,
  player: Player,
): { distance: number; path: Square[] } {
  const start = state.pawns[player];
  const targetRow = player === 0 ? 0 : 8;
  const queue: Square[] = [start];
  const seen = new Set([`${start.r},${start.c}`]);
  const parent = new Map<string, Square>();
  let head = 0;
  while (head < queue.length) {
    const current = queue[head++];
    if (current.r === targetRow) {
      const path = [current];
      let cursor = current;
      while (!sameSquare(cursor, start)) {
        const prev = parent.get(`${cursor.r},${cursor.c}`);
        if (!prev) break;
        path.push(prev);
        cursor = prev;
      }
      path.reverse();
      return { distance: path.length - 1, path };
    }
    for (const next of pathNeighbors(current, state.walls)) {
      const key = `${next.r},${next.c}`;
      if (seen.has(key)) continue;
      seen.add(key);
      parent.set(key, current);
      queue.push(next);
    }
  }
  return { distance: 99, path: [] };
}

export function legalPawnMoves(state: GameState, player = state.turn): PawnMove[] {
  const own = state.pawns[player];
  const other = state.pawns[(1 - player) as Player];
  const destinations: Square[] = [];

  for (const [dr, dc] of DIRS) {
    const adjacent = { r: own.r + dr, c: own.c + dc };
    if (!inside(adjacent) || blocked(own, adjacent, state.walls)) continue;
    if (!sameSquare(adjacent, other)) {
      destinations.push(adjacent);
      continue;
    }

    const beyond = { r: other.r + dr, c: other.c + dc };
    if (inside(beyond) && !blocked(other, beyond, state.walls)) {
      destinations.push(beyond);
      continue;
    }

    const sides = dr === 0 ? [[-1, 0], [1, 0]] : [[0, -1], [0, 1]];
    for (const [sr, sc] of sides) {
      const diagonal = { r: other.r + sr, c: other.c + sc };
      if (inside(diagonal) && !blocked(other, diagonal, state.walls)) {
        destinations.push(diagonal);
      }
    }
  }

  const unique = new Map(destinations.map((s) => [`${s.r},${s.c}`, s]));
  return [...unique.values()].map((to) => ({ kind: "pawn", to }));
}

export function isLegalWall(state: GameState, wall: Wall): boolean {
  if (wall.r < 0 || wall.r > 7 || wall.c < 0 || wall.c > 7) return false;
  if (state.wallsLeft[state.turn] <= 0) return false;
  for (const placed of state.walls) {
    if (placed.o === wall.o) {
      if (wall.o === "h" && placed.r === wall.r && Math.abs(placed.c - wall.c) <= 1) return false;
      if (wall.o === "v" && placed.c === wall.c && Math.abs(placed.r - wall.r) <= 1) return false;
    } else if (placed.r === wall.r && placed.c === wall.c) {
      return false;
    }
  }
  const trial = { ...state, walls: [...state.walls, wall] };
  return shortestPath(trial, 0).distance < 99 && shortestPath(trial, 1).distance < 99;
}

export function applyMove(state: GameState, move: Move): GameState {
  const pawns: [Square, Square] = [{ ...state.pawns[0] }, { ...state.pawns[1] }];
  const wallsLeft: [number, number] = [...state.wallsLeft];
  let walls = state.walls;
  if (move.kind === "pawn") pawns[state.turn] = { ...move.to };
  else {
    walls = [...walls, move.wall];
    wallsLeft[state.turn]--;
  }
  return { pawns, walls, wallsLeft, turn: (1 - state.turn) as Player };
}

export function winner(state: GameState): Player | null {
  if (state.pawns[0].r === 0) return 0;
  if (state.pawns[1].r === 8) return 1;
  return null;
}

function candidatesFromPath(path: Square[], out: Map<string, Wall>) {
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i];
    const b = path[i + 1];
    if (a.r !== b.r) {
      const r = Math.min(a.r, b.r);
      for (const c of [a.c - 1, a.c]) {
        const wall: Wall = { r, c, o: "h" };
        if (c >= 0 && c <= 7) out.set(moveKey({ kind: "wall", wall }), wall);
      }
    } else {
      const c = Math.min(a.c, b.c);
      for (const r of [a.r - 1, a.r]) {
        const wall: Wall = { r, c, o: "v" };
        if (r >= 0 && r <= 7) out.set(moveKey({ kind: "wall", wall }), wall);
      }
    }
  }
}

function candidateWalls(state: GameState): WallMove[] {
  if (state.wallsLeft[state.turn] <= 0) return [];
  const candidates = new Map<string, Wall>();
  const us = shortestPath(state, state.turn);
  const them = shortestPath(state, (1 - state.turn) as Player);
  candidatesFromPath(them.path, candidates);
  candidatesFromPath(us.path.slice(0, 5), candidates);

  // Include nearby tactical walls so jumps and local funnels are not missed.
  for (const pawn of state.pawns) {
    for (let dr = -1; dr <= 0; dr++) {
      for (let dc = -1; dc <= 0; dc++) {
        for (const o of ["h", "v"] as const) {
          const wall: Wall = { r: pawn.r + dr, c: pawn.c + dc, o };
          if (wall.r >= 0 && wall.r <= 7 && wall.c >= 0 && wall.c <= 7) {
            candidates.set(moveKey({ kind: "wall", wall }), wall);
          }
        }
      }
    }
  }
  return [...candidates.values()]
    .filter((wall) => isLegalWall(state, wall))
    .map((wall) => ({ kind: "wall", wall }));
}

function generateMoves(state: GameState): Move[] {
  return [...legalPawnMoves(state), ...candidateWalls(state)];
}

function evaluateAbsolute(state: GameState): number {
  const blue = shortestPath(state, 0).distance;
  const amber = shortestPath(state, 1).distance;
  const pathScore = (amber - blue) * 100;
  const wallScore = (state.wallsLeft[0] - state.wallsLeft[1]) * 13;
  const mobilityBlue = legalPawnMoves(state, 0).length;
  const mobilityAmber = legalPawnMoves(state, 1).length;
  const mobility = (mobilityBlue - mobilityAmber) * 4;
  return pathScore + wallScore + mobility;
}

export function staticEvaluation(state: GameState): number {
  const won = winner(state);
  if (won !== null) return won === state.turn ? WIN : -WIN;
  const absolute = evaluateAbsolute(state);
  return state.turn === 0 ? absolute : -absolute;
}

export function explainMove(before: GameState, move: Move, after: GameState): string {
  const player = before.turn;
  const opponent = (1 - player) as Player;
  const playerName = player === 0 ? "periwinkle" : "blossom";
  const ownBefore = shortestPath(before, player).distance;
  const ownAfter = shortestPath(after, player).distance;
  const opponentBefore = shortestPath(before, opponent).distance;
  const opponentAfter = shortestPath(after, opponent).distance;
  const ownChange = ownBefore - ownAfter;
  const opponentChange = opponentAfter - opponentBefore;
  const mobilityBefore = legalPawnMoves(before, player).length;
  const mobilityAfter = legalPawnMoves(after, player).length;

  if (winner(after) === player) return `${playerName} reaches the goal, so this move wins the game.`;

  if (move.kind === "pawn") {
    if (ownChange > 0 && opponentChange > 0) {
      return `this move shortens ${playerName}'s route by ${ownChange} and adds ${opponentChange} to the opponent's route.`;
    }
    if (ownChange > 0) return `this move shortens ${playerName}'s route by ${ownChange} move${ownChange === 1 ? "" : "s"}.`;
    if (opponentChange > 0) return `this move leaves the route length unchanged but adds ${opponentChange} to the opponent's route.`;
    if (mobilityAfter > mobilityBefore) return `this move keeps the route length steady and opens more movement options.`;
    if (mobilityAfter < mobilityBefore) return `this move gives up ${mobilityBefore - mobilityAfter} movement option${mobilityBefore - mobilityAfter === 1 ? "" : "s"} without shortening the route.`;
    return "this move keeps both shortest routes unchanged.";
  }

  if (opponentChange > 0 && ownChange <= 0) {
    return `this wall adds ${opponentChange} to the opponent's shortest route while keeping ${playerName}'s route from getting longer.`;
  }
  if (opponentChange > ownChange) {
    return `this wall slows the opponent more than it slows ${playerName}, adding ${opponentChange} route move${opponentChange === 1 ? "" : "s"} for them.`;
  }
  if (ownChange > 0 && opponentChange === 0) {
    return `this wall makes ${playerName}'s route ${ownChange} move${ownChange === 1 ? "" : "s"} longer without delaying the opponent.`;
  }
  if (mobilityAfter > mobilityBefore) return "this wall leaves the shortest routes steady and preserves more movement options.";
  return "this wall changes the local routes without changing either shortest-path distance.";
}

type Bound = "exact" | "lower" | "upper";
type TTEntry = { depth: number; score: number; bound: Bound; best: Move | null };

function stateKey(state: GameState): string {
  const walls = [...state.walls]
    .sort((a, b) => a.o.localeCompare(b.o) || a.r - b.r || a.c - b.c)
    .map((w) => `${w.o}${w.r}${w.c}`)
    .join("");
  return `${state.turn}|${state.pawns[0].r}${state.pawns[0].c}|${state.pawns[1].r}${state.pawns[1].c}|${state.wallsLeft.join(",")}|${walls}`;
}

export function formatMove(move: Move, player?: Player): string {
  if (move.kind === "wall") {
    const file = String.fromCharCode(97 + move.wall.c);
    return `${move.wall.o === "h" ? "H" : "V"}-${file}${move.wall.r + 1}`;
  }
  const file = String.fromCharCode(97 + move.to.c);
  const rank = 9 - move.to.r;
  return `${player === 0 ? "Blue" : player === 1 ? "Amber" : "Pawn"} ${file}${rank}`;
}

export function analyze(
  initial: GameState,
  limits: AnalysisLimits,
  onDepth?: (result: AnalysisResult) => void,
): AnalysisResult {
  const started = performance.now();
  const deadline = started + limits.timeMs;
  const tt = new Map<string, TTEntry>();
  let nodes = 0;
  let ttHits = 0;

  const timedOut = () => performance.now() >= deadline;
  const checkTime = () => {
    if ((nodes & 255) === 0 && timedOut()) throw new Error("timeout");
  };

  const orderMoves = (state: GameState, moves: Move[], ttMove: Move | null) => {
    const beforeUs = shortestPath(state, state.turn).distance;
    const beforeThem = shortestPath(state, (1 - state.turn) as Player).distance;
    return moves
      .map((move) => {
        let priority = ttMove && moveKey(ttMove) === moveKey(move) ? 1_000_000 : 0;
        const next = applyMove(state, move);
        if (winner(next) === state.turn) priority += 500_000;
        if (move.kind === "pawn") {
          const goal = state.turn === 0 ? 0 : 8;
          priority += (Math.abs(state.pawns[state.turn].r - goal) - Math.abs(move.to.r - goal)) * 90;
        } else {
          const afterUs = shortestPath(next, state.turn).distance;
          const afterThem = shortestPath(next, (1 - state.turn) as Player).distance;
          priority += (afterThem - beforeThem) * 120 - (afterUs - beforeUs) * 90;
        }
        return { move, priority };
      })
      .sort((a, b) => b.priority - a.priority)
      .map(({ move }) => move);
  };

  const negamax = (state: GameState, depth: number, alpha: number, beta: number, ply: number): number => {
    nodes++;
    checkTime();
    const won = winner(state);
    if (won !== null) return won === state.turn ? WIN - ply : -WIN + ply;
    if (depth <= 0) return staticEvaluation(state);

    const key = stateKey(state);
    const cached = tt.get(key);
    const originalAlpha = alpha;
    if (cached && cached.depth >= depth) {
      ttHits++;
      if (cached.bound === "exact") return cached.score;
      if (cached.bound === "lower") alpha = Math.max(alpha, cached.score);
      else beta = Math.min(beta, cached.score);
      if (alpha >= beta) return cached.score;
    }

    const moves = orderMoves(state, generateMoves(state), cached?.best ?? null);
    if (!moves.length) return staticEvaluation(state);
    let bestScore = -INF;
    let best: Move | null = null;
    for (const move of moves) {
      const score = -negamax(applyMove(state, move), depth - 1, -beta, -alpha, ply + 1);
      if (score > bestScore) {
        bestScore = score;
        best = move;
      }
      alpha = Math.max(alpha, score);
      if (alpha >= beta) break;
    }
    const bound: Bound = bestScore <= originalAlpha ? "upper" : bestScore >= beta ? "lower" : "exact";
    tt.set(key, { depth, score: bestScore, bound, best });
    return bestScore;
  };

  const extractPv = (depth: number): Move[] => {
    const pv: Move[] = [];
    let state = initial;
    for (let i = 0; i < depth; i++) {
      const move = tt.get(stateKey(state))?.best;
      if (!move) break;
      pv.push(move);
      state = applyMove(state, move);
      if (winner(state) !== null) break;
    }
    return pv;
  };

  let completed: AnalysisResult = {
    bestMove: null,
    score: staticEvaluation(initial),
    depth: 0,
    pv: [],
    nodes: 0,
    nps: 0,
    timeMs: 0,
    ttHits: 0,
    selective: true,
  };

  for (let depth = 1; depth <= limits.maxDepth; depth++) {
    if (timedOut()) break;
    try {
      let alpha = -INF;
      let beta = INF;
      if (depth > 2) {
        alpha = completed.score - 175;
        beta = completed.score + 175;
      }
      let score = negamax(initial, depth, alpha, beta, 0);
      if (score <= alpha || score >= beta) score = negamax(initial, depth, -INF, INF, 0);
      const elapsed = Math.max(1, performance.now() - started);
      const pv = extractPv(depth);
      completed = {
        bestMove: pv[0] ?? null,
        score,
        depth,
        pv,
        nodes,
        nps: Math.round((nodes * 1000) / elapsed),
        timeMs: Math.round(elapsed),
        ttHits,
        selective: true,
      };
      onDepth?.(completed);
    } catch (error) {
      if (error instanceof Error && error.message === "timeout") break;
      throw error;
    }
  }
  return completed;
}
