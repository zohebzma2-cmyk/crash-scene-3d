#!/usr/bin/env node
// The fixer's regression corpus (packages/core/test/data/fixer-corpus.jsonl; docs/FIXER-BENCHMARK.md).
//
//   npm run fixer:corpus -- --add <scene.json> --roads <t-bone-intersection|highway-rear-end|parking-lot-backing|none|roads.json>
//                           [--id name] [--src visibility] [--note "why it is interesting"]
//       Adds one refused scene (a scene file the app saved, or a bare Scene) with the fixer's best fix for it now.
//   npm run fixer:corpus -- --check     How every case does now: better, same or worse than recorded (exit 1 if any is worse).
//   npm run fixer:corpus -- --update    Records every case that got better (never one that got worse; exit 1 if any did).
//   npm run fixer:corpus -- --seed      Rebuilds the file from the benchmark and the red-team and e2e scenes (resets the bar!).
//
// The test packages/core/test/fixer-corpus.test.ts fails when a case loses its fix or its best fix gets bigger.
// Runs the TypeScript through Vite's module runner. Nothing leaves the machine.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runnerImport } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const { module: corpus } = await runnerImport(`${root}packages/core/test/fixer/corpus.ts`);
const { module: core } = await runnerImport(`${root}packages/core/src/index.ts`);
const { module: bench } = await runnerImport(`${root}packages/core/test/fixer/bench.ts`);
const EXAMPLES = ["t-bone-intersection", "highway-rear-end", "parking-lot-backing"];

function fail(msg) { console.error(msg); process.exit(1); }

if (args.includes("--add")) {
  const file = opt("--add");
  const roadsArg = opt("--roads");
  if (!file) fail("--add needs a scene file.");
  if (!roadsArg) fail(`--roads is needed: one of ${EXAMPLES.join(", ")}, none, or a RoadNetwork JSON file.`);
  const parsed = core.parseScene(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.ok) fail(`Not a scene the app could open: ${parsed.errors.map((e) => e.text ?? e).join(" ")}`);
  const net = roadsArg === "none" || EXAMPLES.includes(roadsArg) ? roadsArg : JSON.parse(readFileSync(roadsArg, "utf8"));
  const roads = bench.roadsOf(net);
  if (core.simulate(parsed.value, roads).ok) fail("That scene draws: the corpus is for refused scenes.");
  const cases = corpus.loadCorpus();
  const id = opt("--id") ?? `${opt("--src") ?? "added"}-${String(cases.length + 1).padStart(4, "0")}`;
  if (cases.some((c) => c.id === id)) fail(`There is already a case ${id}.`);
  const best = corpus.bestNow(parsed.value, roads);
  cases.push({ id, src: opt("--src") ?? "added", net, scene: parsed.value, best, ...(opt("--note") ? { note: opt("--note") } : {}) });
  corpus.saveCorpus(cases);
  console.log(`Added ${id}: ${best ? `best fix "${best.label}" (${best.size} detail${best.size === 1 ? "" : "s"})` : "no fix yet"}.`);
  process.exit(0);
}

if (args.includes("--seed")) {
  const cases = bench.loadBench().map((b) => {
    const best = corpus.bestNow(b.scene, bench.roadsOf(b.net));
    return { id: `bench-${b.id}`, src: "bench", ref: b.id, best };
  });
  for (const s of corpus.seedScenes()) cases.push({ id: s.id, src: s.src, net: s.net, scene: s.scene, best: corpus.bestNow(s.scene, bench.roadsOf(s.net)), note: s.note });
  corpus.saveCorpus(cases);
  console.log(`Wrote ${cases.length} cases, ${cases.filter((c) => c.best).length} with a fix.`);
  process.exit(0);
}

// --check and --update
const cases = corpus.loadCorpus();
const tally = { better: 0, same: 0, worse: 0 };
const worse = [];
const next = cases.map((c) => {
  const { scene, roads } = corpus.resolve(c);
  const now = corpus.bestNow(scene, roads);
  const verdict = corpus.compare(now, c.best);
  tally[verdict]++;
  if (verdict === "worse") worse.push(`${c.id}: was ${c.best ? `"${c.best.label}"` : "none"}, now ${now ? `"${now.label}"` : "none"}`);
  return verdict === "better" ? { ...c, best: now } : c;
});
console.log(`${cases.length} cases: ${tally.better} better, ${tally.same} the same, ${tally.worse} worse.`);
for (const w of worse) console.log(`  worse: ${w}`);
if (args.includes("--update") && tally.better) { corpus.saveCorpus(next); console.log(`Recorded ${tally.better} improvement(s).`); }
process.exit(tally.worse ? 1 : 0);
