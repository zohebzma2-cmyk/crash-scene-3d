// The fixer can only get better (docs/FIXER-BENCHMARK.md, "The corpus"): every refused scene in
// test/data/fixer-corpus.jsonl (the benchmark, the red team's, the e2e suite's and any added later with
// `npm run fixer:corpus -- --add`) is re-checked. A case fails when it loses its fix or its best fix gets bigger
// (more details changed, or the same number at a higher cost). A case that improves passes; record it with
// `npm run fixer:corpus -- --update`. The best fix must draw exactly as its button says.
import { describe, expect, it } from "vitest";
import { MAX_FIXES } from "../src";
import { asBest, compare, draws, loadCorpus, resolve } from "./fixer/corpus";
import { suggestFixes } from "../src";

describe("the fixer's regression corpus", () => {
  const cases = loadCorpus();

  it("has the benchmark, the red team's and the e2e suite's refused scenes, each id once", () => {
    expect(cases.length).toBeGreaterThanOrEqual(570);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    expect(cases.some((c) => c.src === "e2e")).toBe(true);
    // Most cases have a recorded fix: the bar the fixer has to keep clearing.
    expect(cases.filter((c) => c.best).length / cases.length).toBeGreaterThan(0.8);
  });

  it("never loses a fix or makes the best one bigger", () => {
    const worse: string[] = [];
    let better = 0;
    for (const c of cases) {
      const { scene, roads } = resolve(c);
      const s = suggestFixes(scene, roads);
      expect(s.fixes.length, c.id).toBeLessThanOrEqual(MAX_FIXES);
      const now = asBest(s.fixes[0]);
      const verdict = compare(now, c.best);
      if (verdict === "worse") worse.push(`${c.id}: was ${c.best?.label ?? "none"} (${c.best?.size ?? "-"}), now ${now?.label ?? "none"} (${now?.size ?? "-"})`);
      if (verdict === "better") better++;
      // The best fix draws exactly as its button says (the full simulation, no hit side swapped in).
      if (s.fixes[0]) expect(draws(s.fixes[0].scene, roads), `${c.id}: ${s.fixes[0].label}`).toBe(true);
    }
    expect(worse, `${worse.length} case(s) got worse`).toEqual([]);
    if (better) console.info(`fixer corpus: ${better} case(s) improved; record them with npm run fixer:corpus -- --update`);
  }, 600_000);
});
