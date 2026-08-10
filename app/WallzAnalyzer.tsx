import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  INITIAL_STATE,
  applyMove,
  explainMove,
  formatMove,
  isLegalWall,
  legalPawnMoves,
  shortestPath,
  winner,
  type AnalysisResult,
  type GameState,
  type Move,
  type MoveExplanation,
  type Square,
  type Wall,
} from "./engine";

interface WorkerMessage {
  type: "progress" | "done";
  result: AnalysisResult;
}

const cloneState = (state: GameState): GameState => JSON.parse(JSON.stringify(state));
const sameSquare = (a: Square, b: Square) => a.r === b.r && a.c === b.c;
const THINK_TIMES = [250, 500, 750, 1000, 1500, 2000, 3000, 5000, 7500, 10000, 15000, 30000];
const playerLabel = (player: 0 | 1) => player === 0 ? "periwinkle" : "blossom";

export function WallzAnalyzer() {
  const [state, setState] = useState<GameState>(cloneState(INITIAL_STATE));
  const [past, setPast] = useState<GameState[]>([]);
  const [future, setFuture] = useState<GameState[]>([]);
  const [engineEnabled, setEngineEnabled] = useState(true);
  const [thinking, setThinking] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [timeMs, setTimeMs] = useState(1000);
  const [maxDepth, setMaxDepth] = useState(8);
  const [rotated, setRotated] = useState(false);
  const [notice, setNotice] = useState("");
  const [moveExplanation, setMoveExplanation] = useState<MoveExplanation | null>(null);
  const workerRef = useRef<Worker | null>(null);

  const legalPawn = useMemo(() => legalPawnMoves(state), [state]);
  const bluePath = useMemo(() => shortestPath(state, 0), [state]);
  const amberPath = useMemo(() => shortestPath(state, 1), [state]);
  const currentWinner = winner(state);

  useEffect(() => {
    workerRef.current?.terminate();
    workerRef.current = null;

    if (!engineEnabled || currentWinner !== null) {
      const timeout = window.setTimeout(() => {
        setThinking(false);
        if (!engineEnabled) setAnalysis(null);
      }, 0);
      return () => window.clearTimeout(timeout);
    }

    const worker = new Worker(new URL("./engine-worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    const startTimeout = window.setTimeout(() => {
      setThinking(true);
      setAnalysis(null);
    }, 0);
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      setAnalysis(event.data.result);
      if (event.data.type === "done") {
        setThinking(false);
        worker.terminate();
        if (workerRef.current === worker) workerRef.current = null;
      }
    };
    worker.onerror = () => {
      setThinking(false);
      setNotice("The engine paused unexpectedly. Toggle it off and on to retry.");
    };
    worker.postMessage({ state, limits: { timeMs, maxDepth } });

    return () => {
      window.clearTimeout(startTimeout);
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
    };
  }, [state, engineEnabled, timeMs, maxDepth, currentWinner]);

  useEffect(() => () => workerRef.current?.terminate(), []);

  const commitMove = (next: GameState, message: string, move: Move) => {
    setPast((items) => [...items, cloneState(state)]);
    setFuture([]);
    setState(next);
    setNotice(message);
    setMoveExplanation(explainMove(state, move, next, analysis?.bestMove ?? null));
  };

  const handleSquare = (square: Square) => {
    if (currentWinner !== null) return;
    const move = legalPawn.find((candidate) => sameSquare(candidate.to, square));
    if (!move) {
      setNotice("");
      return;
    }
    commitMove(
      applyMove(state, move),
      `${playerLabel(state.turn)} moved to ${formatMove(move).replace("Pawn ", "")}.`,
      move,
    );
  };

  const handleWall = (wall: Wall) => {
    if (currentWinner !== null) return;
    const placed = state.walls.some(
      (item) => item.r === wall.r && item.c === wall.c && item.o === wall.o,
    );
    if (placed) return;
    if (!isLegalWall(state, wall)) {
      setNotice("That wall would overlap, cross, or close every route to a goal.");
      return;
    }
    const move = { kind: "wall", wall } as const;
    commitMove(applyMove(state, move), `${playerLabel(state.turn)} placed ${formatMove(move)}.`, move);
  };

  const reset = () => {
    workerRef.current?.terminate();
    setPast([]);
    setFuture([]);
    setState(cloneState(INITIAL_STATE));
    setAnalysis(null);
    setNotice("");
    setMoveExplanation(null);
  };

  const undo = useCallback(() => {
    const previous = past.at(-1);
    if (!previous) return;
    setPast((items) => items.slice(0, -1));
    setFuture((items) => [...items, cloneState(state)]);
    setState(previous);
    setNotice("Move undone.");
    setMoveExplanation(null);
  }, [past, state]);

  const redo = useCallback(() => {
    const next = future.at(-1);
    if (!next) return;
    setFuture((items) => items.slice(0, -1));
    setPast((items) => [...items, cloneState(state)]);
    setState(next);
    setNotice("Move restored.");
    setMoveExplanation(null);
  }, [future, state]);

  useEffect(() => {
    const handleHistoryKeys = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        undo();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", handleHistoryKeys);
    return () => window.removeEventListener("keydown", handleHistoryKeys);
  }, [undo, redo]);

  const playBest = () => {
    if (currentWinner !== null || !analysis?.bestMove) return;
    commitMove(
      applyMove(state, analysis.bestMove),
      `engine line played: ${formatMove(analysis.bestMove, state.turn).replace("Blue", "periwinkle").replace("Amber", "blossom")}.`,
      analysis.bestMove,
    );
  };

  const toGridRow = (r: number) => r * 2 + 1;
  const toGridCol = (c: number) => c * 2 + 1;
  const wallStyle = (wall: Wall) => {
    const r = rotated ? 7 - wall.r : wall.r;
    const c = rotated ? 7 - wall.c : wall.c;
    return wall.o === "h"
      ? { gridRow: `${r * 2 + 2}`, gridColumn: `${c * 2 + 1} / span 3` }
      : { gridRow: `${r * 2 + 1} / span 3`, gridColumn: `${c * 2 + 2}` };
  };

  const circleStyle = (square: Square) => {
    const c = rotated ? 8 - square.c : square.c;
    const r = rotated ? 8 - square.r : square.r;
    const leftPercent = ((c + 0.225) * 100) / 9;
    const topPercent = ((r + 0.225) * 100) / 9;
    const leftPixels = c - 1.8;
    const topPixels = r - 1.8;
    return {
      left: `calc(${leftPercent}% + ${leftPixels}px)`,
      top: `calc(${topPercent}% + ${topPixels}px)`,
    };
  };

  const blueScore = currentWinner !== null
    ? currentWinner === 0 ? 100_000 : -100_000
    : analysis ? analysis.score * (state.turn === 0 ? 1 : -1) : 0;
  const evalPercent = Math.max(8, Math.min(92, 50 + blueScore / 12));
  const evaluationLabel = currentWinner !== null
    ? `${playerLabel(currentWinner)} wins`
    : !engineEnabled
    ? "engine off"
    : !analysis
      ? thinking ? "calculating…" : "—"
      : Math.abs(blueScore) > 90_000
        ? blueScore > 0 ? "periwinkle has a forced win" : "blossom has a forced win"
        : blueScore === 0
          ? "even"
          : `${blueScore > 0 ? "periwinkle" : "blossom"} +${(Math.abs(blueScore) / 100).toFixed(2)} moves`;

  const displaySquare = (displayRow: number, displayColumn: number): Square => rotated
    ? { r: 8 - displayRow, c: 8 - displayColumn }
    : { r: displayRow, c: displayColumn };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <h1>walwuk</h1>
        </div>
      </header>

      <section className="workspace">
        <aside className="panel controls-panel">
          <div className="game-actions">
            <button className="new-game" onClick={reset}>new game</button>
            <button className="history-button" disabled={!past.length} onClick={undo} title="Left arrow" aria-label="Undo move">←<small>Undo</small></button>
            <button className="history-button" disabled={!future.length} onClick={redo} title="Right arrow" aria-label="Redo move">→<small>Redo</small></button>
            <button className="history-button" onClick={() => setRotated((value) => !value)} aria-label="Rotate board">↻<small>Rotate</small></button>
          </div>

          <div className="wall-reserves">
            <div><span><i className="blue-chip" />periwinkle</span><strong>{state.wallsLeft[0]}</strong></div>
            <div><span><i className="amber-chip" />blossom</span><strong>{state.wallsLeft[1]}</strong></div>
          </div>
          <div className="engine-toggle-card">
            <strong>engine</strong>
            <button
              type="button"
              className={`toggle ${engineEnabled ? "on" : ""}`}
              role="switch"
              aria-checked={engineEnabled}
              onClick={() => setEngineEnabled((enabled) => !enabled)}
            ><i /></button>
          </div>
          <div className="engine-controls">
            <label className="control-label" htmlFor="think-time">thinking time <b>{timeMs < 1000 ? `${timeMs} ms` : `${(timeMs / 1000).toFixed(1)} s`}</b></label>
            <input
              id="think-time"
              className="range"
              type="range"
              min="0"
              max={THINK_TIMES.length - 1}
              step="1"
              value={THINK_TIMES.indexOf(timeMs)}
              onChange={(e) => setTimeMs(THINK_TIMES[Number(e.target.value)])}
            />
            <label className="control-label" htmlFor="max-depth">depth <b>{maxDepth} ply</b></label>
            <input id="max-depth" className="range" type="range" min="2" max="12" value={maxDepth} onChange={(e) => setMaxDepth(Number(e.target.value))} />
          </div>
          <div className="engine-console" aria-live="polite">
            <small>engine console</small>
            <div><span>status</span><b>{thinking ? "searching" : engineEnabled ? analysis ? "ready" : "idle" : "off"}</b></div>
            <div><span>searches</span><b>{(analysis?.nodes ?? 0).toLocaleString()}</b></div>
            <div><span>depth</span><b>{analysis?.depth ?? 0} ply</b></div>
            <div><span>speed</span><b>{(analysis?.nps ?? 0).toLocaleString()} nps</b></div>
            <div><span>time</span><b>{analysis?.timeMs ?? 0} ms</b></div>
            <div><span>tt hits</span><b>{(analysis?.ttHits ?? 0).toLocaleString()}</b></div>
          </div>
        </aside>

        <section className="board-column">
          <div className="board-frame">
            <div className="board" aria-label={`Wallz board, ${rotated ? "rotated" : "standard"} orientation`}>
              {[...Array(9)].flatMap((_, displayRow) => [...Array(9)].map((__, displayColumn) => {
                const square = displaySquare(displayRow, displayColumn);
                const isLegal = currentWinner === null && legalPawn.some((move) => sameSquare(move.to, square));
                const pathBlue = engineEnabled && bluePath.path.some((item) => sameSquare(item, square));
                const pathAmber = engineEnabled && amberPath.path.some((item) => sameSquare(item, square));
                const winnerClass = currentWinner === 0 ? "winner-periwinkle" : currentWinner === 1 ? "winner-blossom" : "";
                return (
                  <button
                    key={`${square.r}-${square.c}`}
                    className={`square ${(square.r + square.c) % 2 ? "dark" : "light"} ${isLegal ? "legal" : ""} ${pathBlue ? "blue-path" : ""} ${pathAmber ? "amber-path" : ""} ${winnerClass}`}
                    style={{ gridRow: toGridRow(displayRow), gridColumn: toGridCol(displayColumn), "--win-delay": `${(displayRow * 9 + displayColumn) * 12}ms` } as CSSProperties}
                    onClick={() => handleSquare(square)}
                    aria-label={`${String.fromCharCode(97 + square.c)}${9 - square.r}${isLegal ? ", legal destination" : ""}`}
                  >
                    {displayColumn === 0 && <span className="rank-label">{9 - square.r}</span>}
                    {displayRow === 8 && <span className="file-label">{String.fromCharCode(97 + square.c)}</span>}
                    {isLegal && <span className="legal-dot" />}
                  </button>
                );
              }))}

              <span className="circle-piece blue" style={circleStyle(state.pawns[0])} aria-hidden="true" />
              <span className="circle-piece amber" style={circleStyle(state.pawns[1])} aria-hidden="true" />

              {[...Array(8)].flatMap((_, r) => [...Array(8)].flatMap((__, c) =>
                (["h", "v"] as const).map((o) => {
                  const wall: Wall = { r, c, o };
                  const placed = state.walls.some((item) => item.r === r && item.c === c && item.o === o);
                  if (placed) return <span key={`${o}${r}${c}`} className={`wall-slot ${o} placed`} style={wallStyle(wall)} aria-hidden="true" />;
                  return (
                    <button
                      key={`${o}${r}${c}`}
                      className={`wall-slot ${o}`}
                      style={wallStyle(wall)}
                      onClick={() => handleWall(wall)}
                      aria-label={`Place ${o === "h" ? "horizontal" : "vertical"} wall at ${String.fromCharCode(97 + c)}${r + 1}`}
                    />
                  );
                }),
              ))}
            </div>
          </div>
          <div className="status-line">
            <span>{notice}</span>
            <span>{currentWinner !== null ? `${playerLabel(currentWinner)} wins` : `paths ${bluePath.distance} / ${amberPath.distance}`}</span>
          </div>
        </section>

        <aside className="panel analysis-panel">
          <div className="evaluation-hero">
            <small>eval</small><strong>{evaluationLabel}</strong>
            <div className={`eval-track ${!engineEnabled ? "disabled" : ""}`}><div className="eval-blue" style={{ width: `${engineEnabled ? evalPercent : 50}%` }} /><i style={{ left: `${engineEnabled ? evalPercent : 50}%` }} /></div>
            <div className="eval-ends"><span>periwinkle</span><span>blossom</span></div>
          </div>
          {currentWinner === null && (
            <div className="best-move-card">
              <small>best</small>
              <strong>{analysis?.bestMove ? formatMove(analysis.bestMove, state.turn).replace("Blue", "periwinkle").replace("Amber", "blossom") : engineEnabled ? "reading the board" : "analysis paused"}</strong>
              <button disabled={!analysis?.bestMove} onClick={playBest}>play</button>
            </div>
          )}
          <div className={`move-explanation ${moveExplanation ? `quality-${moveExplanation.quality}` : ""}`}>
            <small>move quality</small>
            <strong>{moveExplanation?.quality ?? "make a move"}</strong>
            <p>{moveExplanation?.text ?? "the next move will get a short strategic explanation."}</p>
          </div>
        </aside>
      </section>
      <a
        className="github-link"
        href="https://github.com/souuk/walwuk"
        target="_blank"
        rel="noreferrer"
        aria-label="open walwuk on github"
        title="github"
      />
    </main>
  );
}
