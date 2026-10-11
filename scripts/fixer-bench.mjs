#!/usr/bin/env node
// The fixer benchmark (docs/FIXER-BENCHMARK.md).
//
//   npm run fixer:bench                  measure suggestFixes on packages/core/test/data/fixer-bench.jsonl, print a table
//   npm run fixer:bench -- --json out    also write the per-scene results as JSON
//   npm run fixer:bench -- --v1          measure the frozen copy of the fixer before round A (test/fixer/suggest-v1.ts)
//   npm run fixer:bench -- --generate    rebuild the benchmark file from its seeded generators (changes the "before" set!)
//
// Loads the TypeScript sources through Vite's module runner, so no build step and no extra dependency.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runnerImport } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const { module: bench } = await runnerImport(`${root}packages/core/test/fixer/bench.ts`);

if (args.includes("--generate")) {
  const cases = bench.generateBench();
  writeFileSync(bench.BENCH_PATH, bench.toJsonl(cases));
  const by = {};
  for (const c of cases) by[`${c.src}:${c.scene.vehicles.length}`] = (by[`${c.src}:${c.scene.vehicles.length}`] ?? 0) + 1;
  console.log(`wrote ${cases.length} refused scenes`, by);
  process.exit(0);
}

const { module: run } = await runnerImport(`${root}packages/core/test/fixer/bench-run.ts`);
const v1 = args.includes("--v1");
const fixer = v1 ? (await runnerImport(`${root}packages/core/test/fixer/suggest-v1.ts`)).module.suggestFixes : undefined;
const cases = bench.loadBench();
const results = [];
const t0 = performance.now();
for (const c of cases) results.push(run.measureCase(c, 2, fixer));
console.log(run.summarize(results, `${v1 ? "Before (suggest-v1)" : "suggestFixes"} on ${cases.length} refused scenes (Node ${process.version})`));
console.log(`\n(total ${((performance.now() - t0) / 1000).toFixed(1)} s)`);
const out = args[args.indexOf("--json") + 1];
if (args.includes("--json") && out) writeFileSync(out, JSON.stringify(results, null, 1));
