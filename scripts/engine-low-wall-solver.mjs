import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  applyMove,
  fixtures,
  generateMoves,
  winner,
} from "./engine-harness.mjs";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function positionKey(state) {
  const walls = [...state.walls]
    .sort((left, right) => left.o.localeCompare(right.o) || left.r - right.r || left.c - right.c)
    .map((wall) => `${wall.o}${wall.r}${wall.c}`)
    .join(",");
  return `${state.pawns[0].r * 9 + state.pawns[0].c}|` +
    `${state.pawns[1].r * 9 + state.pawns[1].c}|${state.wallsLeft.join(",")}|` +
    `${state.turn}|${walls}`;
}

const fixtureName = option("position", "low reserves");
const fixture = fixtures.find((item) => item.name === fixtureName);
if (!fixture) throw new Error(`unknown fixture ${fixtureName}`);
const state = structuredClone(fixture.state);
const playerZeroWalls = Math.max(0, Number.parseInt(option("p0-walls", `${state.wallsLeft[0]}`), 10));
const playerOneWalls = Math.max(0, Number.parseInt(option("p1-walls", `${state.wallsLeft[1]}`), 10));
state.wallsLeft = [playerZeroWalls, playerOneWalls];
const maxStates = Math.max(1, Number.parseInt(option("max-states", "1000000"), 10));
const output = option("output", "");

const states = [state];
const keys = [positionKey(state)];
const indexes = new Map([[keys[0], 0]]);
const children = [];
const predecessors = [];
let complete = true;
for (let cursor = 0; cursor < states.length; ++cursor) {
  const current = states[cursor];
  const destinations = [];
  if (winner(current) === null) {
    for (const move of generateMoves(current)) {
      const child = applyMove(current, move);
      const key = positionKey(child);
      let index = indexes.get(key);
      if (index === undefined) {
        if (states.length >= maxStates) {
          complete = false;
          break;
        }
        index = states.length;
        indexes.set(key, index);
        keys.push(key);
        states.push(child);
      }
      destinations.push({ index, move });
    }
  }
  children[cursor] = destinations;
  if (!complete) break;
}

let rootOutcome = "unknown";
let rootDistance = 0;
let certificate = [];
if (complete) {
  for (let parent = 0; parent < children.length; ++parent) {
    for (const child of children[parent]) {
      predecessors[child.index] ??= [];
      predecessors[child.index].push(parent);
    }
  }
  const outcomes = new Int8Array(states.length);
  const distances = new Uint32Array(states.length);
  const remaining = Uint32Array.from(children.map((items) => items.length));
  const queue = [];
  for (let index = 0; index < states.length; ++index) {
    const gameWinner = winner(states[index]);
    if (gameWinner === null) continue;
    outcomes[index] = gameWinner === states[index].turn ? 1 : -1;
    queue.push(index);
  }
  for (let head = 0; head < queue.length; ++head) {
    const resolved = queue[head];
    for (const parent of predecessors[resolved] ?? []) {
      if (outcomes[parent] !== 0) continue;
      if (outcomes[resolved] < 0) {
        outcomes[parent] = 1;
        distances[parent] = distances[resolved] + 1;
        queue.push(parent);
      } else if (--remaining[parent] === 0) {
        outcomes[parent] = -1;
        distances[parent] = Math.max(
          ...children[parent].map((child) => distances[child.index] + 1),
        );
        queue.push(parent);
      }
    }
  }
  rootOutcome = outcomes[0] > 0 ? "win" : outcomes[0] < 0 ? "loss" : "unknown";
  rootDistance = distances[0];
  let current = 0;
  const seen = new Set();
  while (outcomes[current] !== 0 && winner(states[current]) === null &&
         certificate.length < 256 && !seen.has(current)) {
    seen.add(current);
    const desired = -outcomes[current];
    const choices = children[current].filter((child) => outcomes[child.index] === desired);
    if (choices.length === 0) break;
    choices.sort((left, right) => outcomes[current] > 0
      ? distances[left.index] - distances[right.index]
      : distances[right.index] - distances[left.index]);
    certificate.push(choices[0].move);
    current = choices[0].index;
  }
}

const report = {
  version: 1,
  position: fixtureName,
  root: state,
  completeGraph: complete,
  states: states.length,
  maxStates,
  outcome: rootOutcome,
  distance: rootDistance,
  certificate,
  graphSha256: createHash("sha256").update(keys.join("\n")).digest("hex"),
  note: complete
    ? "Resolved outcomes are exact. Cyclic unresolved components remain unknown."
    : "The state ceiling was reached; no exact result is claimed.",
};
console.log(JSON.stringify(report, null, 2));
if (output) {
  await mkdir(path.dirname(path.resolve(output)), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
}
