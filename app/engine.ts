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

export type MoveQuality = "best" | "acceptable" | "mistake" | "cry";

export interface MoveExplanation {
  quality: MoveQuality;
  text: string;
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

const insideCoords = (r: number, c: number) => r >= 0 && r < SIZE && c >= 0 && c < SIZE;
const moveKey = (move: Move) =>
  move.kind === "pawn"
    ? `p${move.to.r}${move.to.c}`
    : `${move.wall.o}${move.wall.r}${move.wall.c}`;

function blockedCoords(ar: number, ac: number, br: number, bc: number, walls: Wall[]): boolean {
  if (ar !== br) {
    const row = ar < br ? ar : br;
    for (let i = 0; i < walls.length; i++) {
      const wall = walls[i];
      if (wall.o === "h" && wall.r === row && (wall.c === ac || wall.c + 1 === ac)) return true;
    }
    return false;
  }
  const col = ac < bc ? ac : bc;
  for (let i = 0; i < walls.length; i++) {
    const wall = walls[i];
    if (wall.o === "v" && wall.c === col && (wall.r === ar || wall.r + 1 === ar)) return true;
  }
  return false;
}

interface WallMap {
  horizontal: Uint8Array;
  vertical: Uint8Array;
}

function createWallMap(walls: Wall[]): WallMap {
  const horizontal = new Uint8Array(8 * SIZE);
  const vertical = new Uint8Array(SIZE * 8);
  for (let i = 0; i < walls.length; i++) {
    const wall = walls[i];
    if (wall.o === "h") {
      horizontal[wall.r * SIZE + wall.c] = 1;
      horizontal[wall.r * SIZE + wall.c + 1] = 1;
    } else {
      vertical[wall.r * 8 + wall.c] = 1;
      vertical[(wall.r + 1) * 8 + wall.c] = 1;
    }
  }
  return { horizontal, vertical };
}

function blockedByMap(ar: number, ac: number, br: number, bc: number, map: WallMap): boolean {
  if (ar !== br) return map.horizontal[(ar < br ? ar : br) * SIZE + ac] === 1;
  return map.vertical[ar * 8 + (ac < bc ? ac : bc)] === 1;
}

export function blocked(a: Square, b: Square, walls: Wall[]): boolean {
  return blockedCoords(a.r, a.c, b.r, b.c, walls);
}

export function shortestPath(
  state: GameState,
  player: Player,
): { distance: number; path: Square[] } {
  const start = state.pawns[player];
  const targetRow = player === 0 ? 0 : 8;
  const startIndex = start.r * SIZE + start.c;
  const queue = new Uint8Array(SIZE * SIZE);
  const seen = new Uint8Array(SIZE * SIZE);
  const parent = new Int16Array(SIZE * SIZE);
  const wallMap = createWallMap(state.walls);
  parent.fill(-1);
  queue[0] = startIndex;
  seen[startIndex] = 1;
  let tail = 1;
  let head = 0;
  while (head < tail) {
    const currentIndex = queue[head++];
    const currentRow = Math.floor(currentIndex / SIZE);
    const currentColumn = currentIndex % SIZE;
    if (currentRow === targetRow) {
      const path: Square[] = [];
      let cursor = currentIndex;
      while (cursor !== -1) {
        path.push({ r: Math.floor(cursor / SIZE), c: cursor % SIZE });
        if (cursor === startIndex) break;
        cursor = parent[cursor];
      }
      path.reverse();
      return { distance: path.length - 1, path };
    }
    for (const [dr, dc] of DIRS) {
      const nextRow = currentRow + dr;
      const nextColumn = currentColumn + dc;
      if (!insideCoords(nextRow, nextColumn) || blockedByMap(currentRow, currentColumn, nextRow, nextColumn, wallMap)) continue;
      const nextIndex = nextRow * SIZE + nextColumn;
      if (seen[nextIndex]) continue;
      seen[nextIndex] = 1;
      parent[nextIndex] = currentIndex;
      queue[tail++] = nextIndex;
    }
  }
  return { distance: 99, path: [] };
}

export function legalPawnMoves(state: GameState, player = state.turn): PawnMove[] {
  const own = state.pawns[player];
  const other = state.pawns[(1 - player) as Player];
  const destinations: Square[] = [];
  const seen = new Uint8Array(SIZE * SIZE);
  const wallMap = createWallMap(state.walls);
  const addDestination = (r: number, c: number) => {
    const index = r * SIZE + c;
    if (seen[index]) return;
    seen[index] = 1;
    destinations.push({ r, c });
  };

  for (const [dr, dc] of DIRS) {
    const adjacentRow = own.r + dr;
    const adjacentColumn = own.c + dc;
    if (!insideCoords(adjacentRow, adjacentColumn) || blockedByMap(own.r, own.c, adjacentRow, adjacentColumn, wallMap)) continue;
    if (adjacentRow !== other.r || adjacentColumn !== other.c) {
      addDestination(adjacentRow, adjacentColumn);
      continue;
    }

    const beyondRow = other.r + dr;
    const beyondColumn = other.c + dc;
    if (insideCoords(beyondRow, beyondColumn) && !blockedByMap(other.r, other.c, beyondRow, beyondColumn, wallMap)) {
      addDestination(beyondRow, beyondColumn);
      continue;
    }

    const sides = dr === 0 ? [[-1, 0], [1, 0]] : [[0, -1], [0, 1]];
    for (const [sr, sc] of sides) {
      const diagonalRow = other.r + sr;
      const diagonalColumn = other.c + sc;
      if (insideCoords(diagonalRow, diagonalColumn) && !blockedByMap(other.r, other.c, diagonalRow, diagonalColumn, wallMap)) {
        addDestination(diagonalRow, diagonalColumn);
      }
    }
  }

  return destinations.map((to) => ({ kind: "pawn", to }));
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

type PathResult = ReturnType<typeof shortestPath>;

function candidateWalls(state: GameState, us?: PathResult, them?: PathResult): WallMove[] {
  if (state.wallsLeft[state.turn] <= 0) return [];
  const candidates = new Map<string, Wall>();
  const currentPath = us ?? shortestPath(state, state.turn);
  const opposingPath = them ?? shortestPath(state, (1 - state.turn) as Player);
  candidatesFromPath(opposingPath.path, candidates);
  candidatesFromPath(currentPath.path.slice(0, 5), candidates);

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

function generateMoves(state: GameState, us?: PathResult, them?: PathResult): Move[] {
  return [...legalPawnMoves(state), ...candidateWalls(state, us, them)];
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

export function explainMove(
  before: GameState,
  move: Move,
  after: GameState,
  preferredMove: Move | null = null,
): MoveExplanation {
  const player = before.turn;
  const opponent = (1 - player) as Player;
  const playerName = player === 0 ? "periwinkle" : "blossom";
  const opponentName = opponent === 0 ? "periwinkle" : "blossom";
  const ownBefore = shortestPath(before, player).distance;
  const ownAfter = shortestPath(after, player).distance;
  const opponentBefore = shortestPath(before, opponent).distance;
  const opponentAfter = shortestPath(after, opponent).distance;
  const ownChange = ownBefore - ownAfter;
  const opponentChange = opponentAfter - opponentBefore;
  const ownMobilityBefore = legalPawnMoves(before, player).length;
  const ownMobilityAfter = legalPawnMoves(after, player).length;
  const opponentMobilityBefore = legalPawnMoves(before, opponent).length;
  const opponentMobilityAfter = legalPawnMoves(after, opponent).length;
  const ownMobilityChange = ownMobilityAfter - ownMobilityBefore;
  const opponentMobilityChange = opponentMobilityAfter - opponentMobilityBefore;
  const scoreBefore = evaluateAbsolute(before) * (player === 0 ? 1 : -1);
  const scoreAfter = evaluateAbsolute(after) * (player === 0 ? 1 : -1);
  const scoreDelta = scoreAfter - scoreBefore;
  const recommended = preferredMove !== null && moveKey(preferredMove) === moveKey(move);
  const quality: MoveQuality = winner(after) === player || recommended
    ? "best"
    : scoreDelta >= 35 ? "best"
      : scoreDelta >= -35 ? "acceptable"
        : scoreDelta >= -150 ? "mistake"
          : "cry";
  const routeDetails = `${playerName} ${ownBefore}→${ownAfter}; ${opponentName} ${opponentBefore}→${opponentAfter}`;
  const optionDetails = ownMobilityChange !== 0 || opponentMobilityChange !== 0
    ? ` options ${ownMobilityAfter}/${opponentMobilityAfter}`
    : "";

  if (winner(after) === player) {
    return { quality, text: `reaches the goal and ends the game immediately. ${routeDetails}.` };
  }

  if (move.kind === "pawn") {
    const reserve = `${playerName} still has ${after.wallsLeft[player]} walls in reserve for a later defensive or attacking turn`;
    if (ownChange > 0 && opponentChange > 0) {
      return { quality, text: `${routeDetails}${optionDetails}. gains a tempo and forces ${opponentName} to reroute; ${reserve}.` };
    }
    if (ownChange > 0) {
      return { quality, text: `${routeDetails}${optionDetails}. advances the race without spending a wall; ${reserve}.` };
    }
    if (opponentChange > 0) {
      return { quality, text: `${routeDetails}${optionDetails}. does not shorten your route, but forces a longer reply; ${reserve}.` };
    }
    if (ownMobilityChange > 0) {
      return { quality, text: `${routeDetails}${optionDetails}. distance is unchanged, but future choices open up; ${reserve}.` };
    }
    if (ownMobilityChange < 0) {
      return { quality, text: `${routeDetails}${optionDetails}. distance is unchanged and choices narrow; ${reserve}.` };
    }
    return { quality, text: `${routeDetails}. quiet move: preserves the race and ${reserve}.` };
  }

  const reserve = `it spends one wall, leaving ${after.wallsLeft[player]} for future turns`;
  if (opponentChange > 0 && ownChange <= 0) {
    return { quality, text: `${routeDetails}${optionDetails}. buys time by forcing ${opponentName} to reroute; ${reserve}.` };
  }
  if (opponentChange > 0 && opponentChange > ownChange) {
    return { quality, text: `${routeDetails}${optionDetails}. delays ${opponentName} more than yourself; ${reserve}.` };
  }
  if (ownChange > 0 && opponentChange === 0) {
    return { quality, text: `${routeDetails}${optionDetails}. makes your route longer without delaying ${opponentName}; ${reserve}.` };
  }
  if (opponentMobilityChange < 0) {
    return { quality, text: `${routeDetails}${optionDetails}. leaves distance unchanged but narrows ${opponentName}'s replies; ${reserve}.` };
  }
  if (ownMobilityChange < 0) {
    return { quality, text: `${routeDetails}${optionDetails}. leaves distance unchanged but narrows your choices; ${reserve}.` };
  }
  return { quality, text: `${routeDetails}. quiet wall: shapes future routes and replies; ${reserve}.` };
}

type Bound = "exact" | "lower" | "upper";
type TTEntry = { depth: number; score: number; bound: Bound; best: Move | null };

function stateKey(state: GameState): string {
  const walls = new Array<number>(state.walls.length);
  for (let i = 0; i < state.walls.length; i++) {
    const wall = state.walls[i];
    walls[i] = (wall.o === "h" ? 0 : 1) * 64 + wall.r * 8 + wall.c;
  }
  walls.sort((a, b) => a - b);
  return `${state.turn}|${state.pawns[0].r}${state.pawns[0].c}|${state.pawns[1].r}${state.pawns[1].c}|${state.wallsLeft.join(",")}|${walls.join(",")}`;
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
  let lastReport = started;

  const checkTime = () => {
    if ((nodes & 255) !== 0) return;
    const now = performance.now();
    if (now - lastReport >= 1000) {
      lastReport = now;
      const elapsed = Math.max(1, now - started);
      onDepth?.({
        ...completed,
        nodes,
        nps: Math.round((nodes * 1000) / elapsed),
        timeMs: Math.round(elapsed),
        ttHits,
      });
    }
    if (now >= deadline) throw new Error("timeout");
  };

  const orderMoves = (
    state: GameState,
    moves: Move[],
    ttMove: Move | null,
    beforeUs: number,
    beforeThem: number,
  ) => {
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

    const currentPath = shortestPath(state, state.turn);
    const opposingPath = shortestPath(state, (1 - state.turn) as Player);
    const moves = orderMoves(
      state,
      generateMoves(state, currentPath, opposingPath),
      cached?.best ?? null,
      currentPath.distance,
      opposingPath.distance,
    );
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
    if (performance.now() >= deadline) break;
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
