import { useEffect, useMemo, useRef, useState } from "react";
import {
  INITIAL_STATE,
  applyMove,
  formatMove,
  isLegalWall,
  legalPawnMoves,
  shortestPath,
  winner,
  type AnalysisResult,
  type GameState,
  type Player,
  type Square,
  type Wall,
} from "./engine";

type WorkerMessage = { type: "progress" | "done"; result: AnalysisResult };

const cloneState = (state: GameState): GameState => JSON.parse(JSON.stringify(state));
const sameSquare = (a: Square, b: Square) => a.r === b.r && a.c === b.c;

export default function WallzAnalyzer() {
  const [state, setState] = useState<GameState>(cloneState(INITIAL_STATE));
  const [past, setPast] = useState<GameState[]>([]);
  const [future, setFuture] = useState<GameState[]>([]);
  const [engineEnabled, setEngineEnabled] = useState(true);
  const [thinking, setThinking] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [timeMs, setTimeMs] = useState(1200);
  const [maxDepth, setMaxDepth] = useState(8);
  const [notice, setNotice] = useState("Blue begins. Move a circle or place a wall.");
  const workerRef = useRef<Worker | null>(null);

  const legalPawn = useMemo(() => legalPawnMoves(state), [state]);
  const bluePath = useMemo(() => shortestPath(state, 0), [state]);
  const amberPath = useMemo(() => shortestPath(state, 1), [state]);
  const currentWinner = winner(state);

  useEffect(() => {
    workerRef.current?.terminate();
    workerRef.current = null;

    if (!engineEnabled || currentWinner !== null) {
      setThinking(false);
      if (!engineEnabled) setAnalysis(null);
      return;
    }

    const worker = new Worker(new URL("./engine-worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    setThinking(true);
    setAnalysis(null);
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
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
    };
  }, [state, engineEnabled, timeMs, maxDepth, currentWinner]);

  useEffect(() => () => workerRef.current?.terminate(), []);

  const commitMove = (next: GameState, message: string) => {
    setPast((items) => [...items, cloneState(state)]);
    setFuture([]);
    setState(next);
    setNotice(message);
  };

  const handleSquare = (square: Square) => {
    const move = legalPawn.find((candidate) => sameSquare(candidate.to, square));
    if (!move) {
      setNotice("Choose one of the softly marked destination squares.");
      return;
    }
    commitMove(
      applyMove(state, move),
      `${state.turn === 0 ? "Blue" : "Amber"} moved to ${formatMove(move).replace("Pawn ", "")}.`,
    );
  };

  const handleWall = (wall: Wall) => {
    const placed = state.walls.some(
      (item) => item.r === wall.r && item.c === wall.c && item.o === wall.o,
    );
    if (placed) return;
    if (!isLegalWall(state, wall)) {
      setNotice("That wall would overlap, cross, or close every route to a goal.");
      return;
    }
    commitMove(
      applyMove(state, { kind: "wall", wall }),
      `${state.turn === 0 ? "Blue" : "Amber"} placed ${formatMove({ kind: "wall", wall })}.`,
    );
  };

  const reset = () => {
    workerRef.current?.terminate();
    setPast([]);
    setFuture([]);
    setState(cloneState(INITIAL_STATE));
    setAnalysis(null);
    setNotice("Blue begins. Move a circle or place a wall.");
  };

  const undo = () => {
    const previous = past.at(-1);
    if (!previous) return;
    setPast((items) => items.slice(0, -1));
    setFuture((items) => [...items, cloneState(state)]);
    setState(previous);
    setNotice("Move undone.");
  };

  const redo = () => {
    const next = future.at(-1);
    if (!next) return;
    setFuture((items) => items.slice(0, -1));
    setPast((items) => [...items, cloneState(state)]);
    setState(next);
    setNotice("Move restored.");
  };

  const playBest = () => {
    if (!analysis?.bestMove) return;
    commitMove(
      applyMove(state, analysis.bestMove),
      `Engine line played: ${formatMove(analysis.bestMove, state.turn)}.`,
    );
  };

  const toGridRow = (r: number) => r * 2 + 1;
  const toGridCol = (c: number) => c * 2 + 1;
  const wallStyle = (wall: Wall) =>
    wall.o === "h"
      ? { gridRow: `${wall.r * 2 + 2}`, gridColumn: `${wall.c * 2 + 1} / span 3` }
      : { gridRow: `${wall.r * 2 + 1} / span 3`, gridColumn: `${wall.c * 2 + 2}` };

  const circleStyle = (square: Square) => {
    const leftPercent = ((square.c + 0.225) * 100) / 9;
    const topPercent = ((square.r + 0.225) * 100) / 9;
    const leftPixels = square.c - 1.8;
    const topPixels = square.r - 1.8;
    return {
      left: `calc(${leftPercent}% + ${leftPixels}px)`,
      top: `calc(${topPercent}% + ${topPixels}px)`,
    };
  };

  const blueScore = analysis ? analysis.score * (state.turn === 0 ? 1 : -1) : 0;
  const evalPercent = Math.max(8, Math.min(92, 50 + blueScore / 12));
  const evaluationLabel = !engineEnabled
    ? "Engine off"
    : !analysis
      ? thinking ? "Calculating…" : "—"
      : Math.abs(blueScore) > 90_000
        ? blueScore > 0 ? "Blue has a forced win" : "Amber has a forced win"
        : blueScore === 0
          ? "Even"
          : `${blueScore > 0 ? "Blue" : "Amber"} +${(Math.abs(blueScore) / 100).toFixed(2)} moves`;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">W</span>
          <div><h1>Walver</h1><p>Wallz position laboratory</p></div>
        </div>
        <div className={`engine-status ${thinking ? "thinking" : ""}`}>
          <i />{thinking ? "Calculating" : engineEnabled ? "Engine on" : "Engine off"}
        </div>
      </header>

      <section className="workspace">
        <aside className="panel controls-panel">
          <div className="section-heading"><span>01</span><h2>Game</h2></div>
          <div className="game-actions">
            <button className="new-game" onClick={reset}>New game</button>
            <button className="history-button" disabled={!past.length} onClick={undo} aria-label="Undo move">↶<small>Undo</small></button>
            <button className="history-button" disabled={!future.length} onClick={redo} aria-label="Redo move">↷<small>Redo</small></button>
          </div>

          <div className="turn-indicator" aria-label={`${state.turn === 0 ? "Blue" : "Amber"} to play`}>
            <i className={state.turn === 0 ? "blue-chip" : "amber-chip"} />
            <strong>{state.turn === 0 ? "Blue" : "Amber"}</strong>
            <span>to play</span>
          </div>

          <div className="wall-reserves">
            <div><span><i className="blue-chip" />Blue</span><strong>{state.wallsLeft[0]}</strong></div>
            <div><span><i className="amber-chip" />Amber</span><strong>{state.wallsLeft[1]}</strong></div>
          </div>
          <p className="helper">Click a marked square to move. Click an empty channel to place a wall. Placed walls can only be reversed with Undo.</p>

          <div className="section-heading analysis-settings"><span>02</span><h2>Engine</h2></div>
          <div className="engine-toggle-card">
            <div><strong>Automatic analysis</strong><span>Refresh after every move</span></div>
            <button
              type="button"
              className={`toggle ${engineEnabled ? "on" : ""}`}
              role="switch"
              aria-checked={engineEnabled}
              onClick={() => setEngineEnabled((enabled) => !enabled)}
            ><i /></button>
          </div>
          <label className="control-label" htmlFor="think-time">Think time <b>{timeMs < 1000 ? `${timeMs} ms` : `${(timeMs / 1000).toFixed(1)} s`}</b></label>
          <input id="think-time" className="range" type="range" min="250" max="5000" step="250" value={timeMs} onChange={(e) => setTimeMs(Number(e.target.value))} />
          <label className="control-label" htmlFor="max-depth">Maximum depth <b>{maxDepth} ply</b></label>
          <input id="max-depth" className="range" type="range" min="2" max="12" value={maxDepth} onChange={(e) => setMaxDepth(Number(e.target.value))} />
        </aside>

        <section className="board-column">
          <div className="board-frame">
            <div className="board" aria-label="Wallz board">
              {[...Array(9)].flatMap((_, r) => [...Array(9)].map((__, c) => {
                const square = { r, c };
                const isLegal = legalPawn.some((move) => sameSquare(move.to, square));
                const pathBlue = engineEnabled && bluePath.path.some((item) => sameSquare(item, square));
                const pathAmber = engineEnabled && amberPath.path.some((item) => sameSquare(item, square));
                return (
                  <button
                    key={`${r}-${c}`}
                    className={`square ${(r + c) % 2 ? "dark" : "light"} ${isLegal ? "legal" : ""} ${pathBlue ? "blue-path" : ""} ${pathAmber ? "amber-path" : ""}`}
                    style={{ gridRow: toGridRow(r), gridColumn: toGridCol(c) }}
                    onClick={() => handleSquare(square)}
                    aria-label={`${String.fromCharCode(97 + c)}${9 - r}${isLegal ? ", legal destination" : ""}`}
                  >
                    {c === 0 && <span className="rank-label">{9 - r}</span>}
                    {r === 8 && <span className="file-label">{String.fromCharCode(97 + c)}</span>}
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
            <span>{currentWinner !== null ? `${currentWinner === 0 ? "Blue" : "Amber"} wins` : `Paths ${bluePath.distance} / ${amberPath.distance}`}</span>
          </div>
        </section>

        <aside className="panel analysis-panel">
          <div className="section-heading"><span>03</span><h2>Evaluation</h2></div>
          <div className="evaluation-hero">
            <small>Position score</small><strong>{evaluationLabel}</strong>
            <div className={`eval-track ${!engineEnabled ? "disabled" : ""}`}><div className="eval-blue" style={{ width: `${engineEnabled ? evalPercent : 50}%` }} /><i style={{ left: `${engineEnabled ? evalPercent : 50}%` }} /></div>
            <div className="eval-ends"><span>Blue</span><span>Amber</span></div>
          </div>
          <div className="best-move-card">
            <small>Engine choice</small>
            <strong>{analysis?.bestMove ? formatMove(analysis.bestMove, state.turn) : engineEnabled ? "Reading the board" : "Analysis paused"}</strong>
            <p>{analysis?.bestMove?.kind === "wall" ? "This wall creates the strongest tempo-adjusted detour." : analysis?.bestMove ? "This circle move leads the strongest searched race." : engineEnabled ? "A recommendation appears after the current search." : "Switch the engine on to evaluate each position automatically."}</p>
            <button disabled={!analysis?.bestMove || thinking} onClick={playBest}>Play engine move</button>
          </div>
          <div className="metrics">
            <div><small>Depth</small><strong>{analysis?.depth ?? 0}<em> ply</em></strong></div>
            <div><small>Nodes</small><strong>{analysis ? analysis.nodes.toLocaleString() : "0"}</strong></div>
            <div><small>Speed</small><strong>{analysis ? `${Math.round(analysis.nps / 1000)}k` : "0k"}<em> n/s</em></strong></div>
            <div><small>TT hits</small><strong>{analysis?.ttHits.toLocaleString() ?? "0"}</strong></div>
          </div>
          <div className="pv-block">
            <div className="pv-title"><span>Principal variation</span><small>{analysis ? `${analysis.timeMs} ms` : "—"}</small></div>
            {analysis?.pv.length ? (
              <ol>{analysis.pv.map((move, index) => (
                <li key={`${formatMove(move)}-${index}`}><span>{index + 1}</span><b>{index % 2 === 0 ? (state.turn === 0 ? "Blue" : "Amber") : (state.turn === 0 ? "Amber" : "Blue")}</b><code>{formatMove(move)}</code></li>
              ))}</ol>
            ) : <div className="empty-pv">{engineEnabled ? "The calculated line will appear here." : "Automatic analysis is switched off."}</div>}
          </div>
          <div className="engine-note"><span>αβ</span><p><strong>Stockfish-inspired search</strong>Iterative deepening, alpha–beta pruning, move ordering, and a transposition table—refreshed after every move.</p></div>
        </aside>
      </section>
    </main>
  );
}
