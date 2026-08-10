"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  INITIAL_STATE, applyMove, formatMove, isLegalWall, legalPawnMoves,
  shortestPath, winner, type AnalysisResult, type GameState, type Player,
  type Square, type Wall,
} from "./engine";

type Tool = "play" | "blue" | "amber";
type WorkerMessage = { type: "progress" | "done"; result: AnalysisResult };
const cloneState = (state: GameState): GameState => JSON.parse(JSON.stringify(state));
const sameSquare = (a: Square, b: Square) => a.r === b.r && a.c === b.c;

export default function WallzAnalyzer() {
  const [state, setState] = useState<GameState>(cloneState(INITIAL_STATE));
  const [history, setHistory] = useState<GameState[]>([]);
  const [tool, setTool] = useState<Tool>("play");
  const [flipped, setFlipped] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [timeMs, setTimeMs] = useState(1200);
  const [maxDepth, setMaxDepth] = useState(8);
  const [notice, setNotice] = useState("Set a position or analyze the opening.");
  const workerRef = useRef<Worker | null>(null);

  const legalPawn = useMemo(() => legalPawnMoves(state), [state]);
  const bluePath = useMemo(() => shortestPath(state, 0), [state]);
  const amberPath = useMemo(() => shortestPath(state, 1), [state]);
  const currentWinner = winner(state);

  useEffect(() => () => workerRef.current?.terminate(), []);

  const updatePosition = (next: GameState, message = "Position changed — analysis is now stale.") => {
    setHistory((items) => [...items, cloneState(state)]);
    setState(next);
    setAnalysis(null);
    setNotice(message);
  };

  const handleSquare = (square: Square) => {
    if (tool === "play") {
      const move = legalPawn.find((candidate) => sameSquare(candidate.to, square));
      if (!move) return setNotice("That pawn move is not legal in this position.");
      return updatePosition(applyMove(state, move), `${state.turn === 0 ? "Blue" : "Amber"} moved ${formatMove(move)}.`);
    }
    const player: Player = tool === "blue" ? 0 : 1;
    if (sameSquare(state.pawns[(1 - player) as Player], square)) return setNotice("Both pawns cannot occupy the same square.");
    const pawns: [Square, Square] = [{ ...state.pawns[0] }, { ...state.pawns[1] }];
    pawns[player] = square;
    updatePosition({ ...state, pawns }, `${player === 0 ? "Blue" : "Amber"} pawn placed.`);
  };

  const handleWall = (wall: Wall) => {
    const index = state.walls.findIndex((placed) => placed.r === wall.r && placed.c === wall.c && placed.o === wall.o);
    if (index >= 0) return updatePosition({ ...state, walls: state.walls.filter((_, i) => i !== index) }, "Wall removed.");
    if (!isLegalWall(state, wall)) return setNotice("Illegal wall: it overlaps, crosses, or removes every path to a goal.");
    updatePosition({ ...state, walls: [...state.walls, wall] }, `Placed ${wall.o === "h" ? "horizontal" : "vertical"} wall.`);
  };

  const startAnalysis = () => {
    workerRef.current?.terminate();
    const worker = new Worker(new URL("./engine-worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    setThinking(true);
    setAnalysis(null);
    setNotice("Searching candidate lines…");
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      setAnalysis(event.data.result);
      if (event.data.type === "done") {
        setThinking(false);
        setNotice("Analysis complete.");
        worker.terminate();
        workerRef.current = null;
      }
    };
    worker.onerror = () => {
      setThinking(false);
      setNotice("The search stopped unexpectedly. Try a shorter analysis.");
    };
    worker.postMessage({ state, limits: { timeMs, maxDepth } });
  };

  const stopAnalysis = () => {
    workerRef.current?.terminate(); workerRef.current = null; setThinking(false);
    setNotice("Search stopped; the last completed depth is shown.");
  };

  const reset = () => {
    workerRef.current?.terminate(); workerRef.current = null; setThinking(false);
    setHistory([]); setState(cloneState(INITIAL_STATE)); setAnalysis(null); setTool("play");
    setNotice("New game loaded.");
  };

  const undo = () => {
    const previous = history.at(-1); if (!previous) return;
    setState(previous); setHistory((items) => items.slice(0, -1)); setAnalysis(null);
    setNotice("Last board edit undone.");
  };

  const visualRows = flipped ? [...Array(9).keys()].reverse() : [...Array(9).keys()];
  const visualCols = flipped ? [...Array(9).keys()].reverse() : [...Array(9).keys()];
  const toGridRow = (r: number) => visualRows.indexOf(r) * 2 + 1;
  const toGridCol = (c: number) => visualCols.indexOf(c) * 2 + 1;
  const wallStyle = (wall: Wall) => {
    const topRow = Math.min(toGridRow(wall.r), toGridRow(wall.r + 1));
    const leftCol = Math.min(toGridCol(wall.c), toGridCol(wall.c + 1));
    return wall.o === "h"
      ? { gridRow: `${topRow + 1}`, gridColumn: `${leftCol} / span 3` }
      : { gridRow: `${topRow} / span 3`, gridColumn: `${leftCol + 1}` };
  };

  const blueScore = analysis ? analysis.score * (state.turn === 0 ? 1 : -1) : 0;
  const evalPercent = Math.max(8, Math.min(92, 50 + blueScore / 12));
  const evaluationLabel = !analysis ? "—" : Math.abs(blueScore) > 90_000
    ? blueScore > 0 ? "Blue has a forced win" : "Amber has a forced win"
    : blueScore === 0 ? "Even" : `${blueScore > 0 ? "Blue" : "Amber"} +${(Math.abs(blueScore) / 100).toFixed(2)} moves`;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">W</span><div><h1>Walver</h1><p>Wallz position laboratory</p></div></div>
        <div className="engine-state"><span className={thinking ? "pulse" : "dot"} /> {thinking ? "Calculating" : "Engine ready"}</div>
      </header>

      <section className="workspace">
        <aside className="panel controls-panel">
          <div className="section-heading"><span>01</span><h2>Position</h2></div>
          <div className="turn-card">
            <span className={`mini-pawn ${state.turn === 0 ? "blue" : "amber"}`} />
            <div><small>Side to move</small><strong>{state.turn === 0 ? "Blue" : "Amber"}</strong></div>
            <button className="switch-button" onClick={() => updatePosition({ ...state, turn: (1 - state.turn) as Player }, "Side to move changed.")} aria-label="Switch side to move">⇄</button>
          </div>
          <label className="control-label">Board tool</label>
          <div className="segmented three">
            <button className={tool === "play" ? "active" : ""} onClick={() => setTool("play")}>Play</button>
            <button className={tool === "blue" ? "active" : ""} onClick={() => setTool("blue")}>Place blue</button>
            <button className={tool === "amber" ? "active" : ""} onClick={() => setTool("amber")}>Place amber</button>
          </div>
          <div className="reserve-grid">
            {([0, 1] as Player[]).map((player) => <label key={player}>
              <span><i className={player === 0 ? "blue-chip" : "amber-chip"} />{player === 0 ? "Blue" : "Amber"} walls</span>
              <input type="number" min="0" max="10" value={state.wallsLeft[player]} onChange={(e) => {
                const wallsLeft: [number, number] = [...state.wallsLeft]; wallsLeft[player] = Math.max(0, Math.min(10, Number(e.target.value)));
                updatePosition({ ...state, wallsLeft }, "Wall reserve changed.");
              }} />
            </label>)}
          </div>
          <div className="button-row"><button className="secondary" onClick={reset}>New game</button><button className="secondary" disabled={!history.length} onClick={undo}>Undo</button><button className="secondary icon-only" onClick={() => setFlipped((value) => !value)} aria-label="Flip board">↻</button></div>
          <p className="helper">In Play mode, legal pawn destinations glow. Click a wall channel to add or remove a wall.</p>
          <div className="section-heading analysis-settings"><span>02</span><h2>Search</h2></div>
          <label className="control-label" htmlFor="think-time">Think time <b>{timeMs < 1000 ? `${timeMs} ms` : `${(timeMs / 1000).toFixed(1)} s`}</b></label>
          <input id="think-time" className="range" type="range" min="250" max="5000" step="250" value={timeMs} onChange={(e) => setTimeMs(Number(e.target.value))} />
          <label className="control-label" htmlFor="max-depth">Maximum depth <b>{maxDepth} ply</b></label>
          <input id="max-depth" className="range" type="range" min="2" max="12" value={maxDepth} onChange={(e) => setMaxDepth(Number(e.target.value))} />
          <button className="primary" onClick={thinking ? stopAnalysis : startAnalysis}>{thinking ? "Stop search" : "Analyze position"}<span>{thinking ? "■" : "→"}</span></button>
        </aside>

        <section className="board-column">
          <div className="board-frame"><div className="board" aria-label="Wallz board">
            {visualRows.flatMap((r) => visualCols.map((c) => {
              const square = { r, c };
              const pawn = sameSquare(state.pawns[0], square) ? 0 : sameSquare(state.pawns[1], square) ? 1 : null;
              const isLegal = tool === "play" && legalPawn.some((move) => sameSquare(move.to, square));
              const pathBlue = bluePath.path.some((item) => sameSquare(item, square));
              const pathAmber = amberPath.path.some((item) => sameSquare(item, square));
              return <button key={`${r}-${c}`} className={`square ${(r + c) % 2 ? "dark" : "light"} ${isLegal ? "legal" : ""} ${pathBlue ? "blue-path" : ""} ${pathAmber ? "amber-path" : ""}`} style={{ gridRow: toGridRow(r), gridColumn: toGridCol(c) }} onClick={() => handleSquare(square)} aria-label={`${String.fromCharCode(97 + c)}${9 - r}${pawn !== null ? `, ${pawn === 0 ? "blue" : "amber"} pawn` : ""}`}>
                {c === visualCols[0] && <span className="rank-label">{9 - r}</span>}{r === visualRows[8] && <span className="file-label">{String.fromCharCode(97 + c)}</span>}
                {pawn !== null && <span className={`pawn ${pawn === 0 ? "blue" : "amber"}`}><i /></span>}{isLegal && <span className="legal-dot" />}
              </button>;
            }))}
            {[...Array(8)].flatMap((_, r) => [...Array(8)].flatMap((__, c) => (["h", "v"] as const).map((o) => {
              const wall: Wall = { r, c, o }; const placed = state.walls.some((item) => item.r === r && item.c === c && item.o === o);
              return <button key={`${o}${r}${c}`} className={`wall-slot ${o} ${placed ? "placed" : ""}`} style={wallStyle(wall)} onClick={() => handleWall(wall)} aria-label={`${placed ? "Remove" : "Place"} ${o === "h" ? "horizontal" : "vertical"} wall at ${String.fromCharCode(97 + c)}${r + 1}`} />;
            })))}
          </div></div>
          <div className="status-line"><span>{notice}</span><span>{currentWinner !== null ? `${currentWinner === 0 ? "Blue" : "Amber"} has reached the goal` : `Paths ${bluePath.distance} / ${amberPath.distance}`}</span></div>
        </section>

        <aside className="panel analysis-panel">
          <div className="section-heading"><span>03</span><h2>Evaluation</h2></div>
          <div className="evaluation-hero"><small>Position score</small><strong>{evaluationLabel}</strong><div className="eval-track"><div className="eval-blue" style={{ width: `${evalPercent}%` }} /><i style={{ left: `${evalPercent}%` }} /></div><div className="eval-ends"><span>Blue</span><span>Amber</span></div></div>
          <div className="best-move-card"><small>Engine choice</small><strong>{analysis?.bestMove ? formatMove(analysis.bestMove, state.turn) : "Waiting for analysis"}</strong><p>{analysis?.bestMove?.kind === "wall" ? "The wall creates the best tempo-adjusted detour." : analysis?.bestMove ? "The pawn move wins the strongest searched race." : "Run the engine to calculate a principal variation."}</p><button disabled={!analysis?.bestMove || thinking} onClick={() => analysis?.bestMove && updatePosition(applyMove(state, analysis.bestMove), `Played ${formatMove(analysis.bestMove, state.turn)}.`)}>Play engine move</button></div>
          <div className="metrics"><div><small>Depth</small><strong>{analysis?.depth ?? 0}<em> ply</em></strong></div><div><small>Nodes</small><strong>{analysis ? analysis.nodes.toLocaleString() : "0"}</strong></div><div><small>Speed</small><strong>{analysis ? `${Math.round(analysis.nps / 1000)}k` : "0k"}<em> n/s</em></strong></div><div><small>TT hits</small><strong>{analysis?.ttHits.toLocaleString() ?? "0"}</strong></div></div>
          <div className="pv-block"><div className="pv-title"><span>Principal variation</span><small>{analysis ? `${analysis.timeMs} ms` : "—"}</small></div>
            {analysis?.pv.length ? <ol>{analysis.pv.map((move, index) => <li key={`${formatMove(move)}-${index}`}><span>{index + 1}</span><b>{index % 2 === 0 ? (state.turn === 0 ? "Blue" : "Amber") : (state.turn === 0 ? "Amber" : "Blue")}</b><code>{formatMove(move)}</code></li>)}</ol> : <div className="empty-pv">The calculated line will appear here, move by move.</div>}
          </div>
          <div className="engine-note"><span>αβ</span><p><strong>Stockfish-inspired search</strong>Iterative deepening, alpha–beta pruning, aspiration windows, move ordering, and a transposition table. Wall placement is selectively searched around critical paths.</p></div>
        </aside>
      </section>
    </main>
  );
}
