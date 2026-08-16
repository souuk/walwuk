import assert from "node:assert/strict";
import {createHash} from "node:crypto";

import {
  applyMove,
  fixtures,
  generateMoves,
  moveKey,
  winner,
} from "./engine-harness.mjs";

function stateKey(state) {
  const walls = [...state.walls]
    .map(({r, c, o}) => `${o}${r}${c}`)
    .sort()
    .join(",");
  return [
    state.pawns[0].r,
    state.pawns[0].c,
    state.pawns[1].r,
    state.pawns[1].c,
    state.wallsLeft[0],
    state.wallsLeft[1],
    state.turn,
    walls,
  ].join("|");
}

export function provePosition(initial, {maxDepth = 8, maxStates = 250_000} = {}) {
  const rootSide = initial.turn;
  const memo = new Map();
  const active = new Set();
  let states = 0;

  const visit = (state, depth) => {
    const key = stateKey(state);
    const terminal = winner(state);
    if (terminal !== null) {
      return {
        outcome: terminal === rootSide ? "win" : "loss",
        distance: 0,
        certificate: {stateKey: key, outcome: terminal === rootSide ? "win" : "loss", terminal},
      };
    }
    if (depth === 0 || states >= maxStates || active.has(key)) {
      return {outcome: "unknown", distance: 0, certificate: null};
    }
    const memoKey = `${key}|${depth}`;
    if (memo.has(memoKey)) return memo.get(memoKey);
    ++states;
    active.add(key);
    const existential = state.turn === rootSide;
    const moves = generateMoves(state);
    const children = [];
    for (const move of moves) {
      const result = visit(applyMove(state, move), depth - 1);
      children.push({move, result});
      const decisive = existential
        ? result.outcome === "win"
        : result.outcome === "loss";
      if (decisive) break;
    }
    active.delete(key);

    const decisiveOutcome = existential ? "win" : "loss";
    const oppositeOutcome = existential ? "loss" : "win";
    const decisive = children.find(({result}) => result.outcome === decisiveOutcome);
    let result;
    if (decisive) {
      result = {
        outcome: decisiveOutcome,
        distance: decisive.result.distance + 1,
        certificate: {
          stateKey: key,
          outcome: decisiveOutcome,
          mode: existential ? "exists" : "forall",
          branches: [{move: moveKey(decisive.move), child: decisive.result.certificate}],
        },
      };
    } else if (children.length === moves.length &&
               children.every(({result: child}) => child.outcome === oppositeOutcome)) {
      const distances = children.map(({result: child}) => child.distance);
      result = {
        outcome: oppositeOutcome,
        distance: (existential ? Math.max(...distances) : Math.min(...distances)) + 1,
        certificate: {
          stateKey: key,
          outcome: oppositeOutcome,
          mode: existential ? "exists" : "forall",
          branches: children.map(({move, result: child}) => ({
            move: moveKey(move),
            child: child.certificate,
          })),
        },
      };
    } else {
      result = {outcome: "unknown", distance: 0, certificate: null};
    }
    memo.set(memoKey, result);
    return result;
  };

  const result = visit(initial, maxDepth);
  const certificateJson = result.certificate === null
    ? null
    : JSON.stringify(result.certificate);
  return {
    ...result,
    states,
    complete: result.outcome !== "unknown",
    certificateSha256: certificateJson === null
      ? null
      : createHash("sha256").update(certificateJson).digest("hex"),
  };
}

export function replayProof(initial, proof) {
  const rootSide = initial.turn;
  const visit = (state, node) => {
    if (node === null || node.stateKey !== stateKey(state)) return false;
    const terminal = winner(state);
    if (terminal !== null) {
      return node.terminal === terminal &&
        node.outcome === (terminal === rootSide ? "win" : "loss");
    }
    const legal = new Map(generateMoves(state).map((move) => [moveKey(move), move]));
    const mustCoverAll =
      (node.mode === "exists" && node.outcome === "loss") ||
      (node.mode === "forall" && node.outcome === "win");
    if (!Array.isArray(node.branches) || node.branches.length === 0) return false;
    if (mustCoverAll && node.branches.length !== legal.size) return false;
    const seen = new Set();
    for (const branch of node.branches) {
      const move = legal.get(branch.move);
      if (move === undefined || seen.has(branch.move)) return false;
      seen.add(branch.move);
      if (!visit(applyMove(state, move), branch.child)) return false;
      if (branch.child.outcome !== node.outcome) return false;
    }
    return true;
  };
  return proof !== null && visit(initial, proof);
}

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function runSelfTest() {
  for (const [name, reserves] of [
    ["periwinkle near win", [0, 1]],
    ["blossom near win", [1, 0]],
  ]) {
    const fixture = fixtures.find(({name: candidate}) => candidate === name);
    const state = {...fixture.state, wallsLeft: reserves};
    const result = provePosition(state, {maxDepth: 1});
    assert.equal(result.outcome, "win");
    assert.equal(result.distance, 1);
    assert.equal(replayProof(state, result.certificate), true);
  }
  const opening = fixtures.find(({name}) => name === "opening").state;
  const nearWin = fixtures.find(({name}) => name === "periwinkle near win").state;
  for (const [row, expected, distance] of [
    [2, "win", 3],
    [3, "loss", 4],
  ]) {
    const state = {
      ...nearWin,
      pawns: [{r: row, c: 4}, nearWin.pawns[1]],
      wallsLeft: [0, 1],
    };
    const result = provePosition(state, {maxDepth: 7});
    assert.deepEqual([result.outcome, result.distance], [expected, distance]);
    assert.equal(replayProof(state, result.certificate), true);
  }
  assert.equal(provePosition(opening, {maxDepth: 0}).outcome, "unknown");
  console.log("proof search tests passed");
}

if (process.argv.includes("--self-test")) {
  runSelfTest();
} else if (process.argv[1]?.endsWith("engine-proof-search.mjs")) {
  const fixtureName = option("fixture", "periwinkle near win");
  const fixture = fixtures.find(({name}) => name === fixtureName);
  if (fixture === undefined) throw new Error(`unknown fixture: ${fixtureName}`);
  const walls = option("walls", "0,1").split(",").map(Number);
  const state = {...fixture.state, wallsLeft: walls};
  const result = provePosition(state, {
    maxDepth: Number(option("depth", 8)),
    maxStates: Number(option("max-states", 250_000)),
  });
  console.log(JSON.stringify({
    schemaVersion: 1,
    fixture: fixtureName,
    walls,
    outcome: result.outcome,
    distance: result.distance,
    states: result.states,
    replayValid: replayProof(state, result.certificate),
    certificateSha256: result.certificateSha256,
  }, null, 2));
}
