import {
  fixtures,
  nativeAnalyze,
  typescriptAnalyze,
} from "./engine-harness.mjs";

const benchmarkFixtures = fixtures.filter(({ name }) =>
  ["opening", "channelled routes", "transposition rich"].includes(name));
const results = [];

for (const fixture of benchmarkFixtures) {
  const typescript = typescriptAnalyze(fixture.state, 15, 1_000);
  const wasm = nativeAnalyze(fixture.state, 15, 1_000);
  results.push({
    position: fixture.name,
    typescriptNps: typescript.nps,
    wasmNps: wasm.nps,
    speedup: Number((wasm.nps / Math.max(1, typescript.nps)).toFixed(2)),
    nodes: wasm.nodes,
    depth: wasm.depth,
  });
}

console.table(results);
const median = (values) => values.toSorted((left, right) => left - right)[Math.floor(values.length / 2)];
const medianSpeedup = median(results.map(({ speedup }) => speedup));
console.log(`median WebAssembly speedup: ${medianSpeedup.toFixed(2)}x`);
if (medianSpeedup < 1) {
  throw new Error("WebAssembly benchmark regressed below the TypeScript baseline.");
}
