// Measures the fixer on the benchmark (docs/FIXER-BENCHMARK.md). Run by scripts/fixer-bench.mjs.
import type { RoadNetwork, Scene } from "../../src";
import { simulate, suggestFixes } from "../../src";
import { type BenchCase, roadsOf } from "./bench";

export interface CaseResult {
  readonly id: string;
  readonly src: string;
  readonly vehicles: number;
  readonly code: string;
  /** Fixes offered that draw exactly as the button says (re-checked here with simulate()). */
  readonly working: number;
  readonly offered: number;
  readonly best: string | null;
  /** Search time, ms: the fastest of `repeat` runs (other processes on the machine only ever add time). */
  readonly ms: number;
}

/** Does this scene draw, with no hit side swapped in behind the button? */
export function draws(scene: Scene, roads: RoadNetwork | null): boolean {
  const r = simulate(scene, roads);
  return r.ok && !r.result.warnings.some((w) => w.code === "zone-used");
}

export function measureCase(c: BenchCase, repeat = 2, fixer: typeof suggestFixes = suggestFixes): CaseResult {
  const roads = roadsOf(c.net);
  const first = simulate(c.scene, roads);
  const code = first.ok ? "draws" : first.errors[0]!.code;
  let best = Infinity, s = fixer(c.scene, roads);
  for (let i = 0; i < repeat; i++) {
    const t0 = performance.now();
    s = fixer(c.scene, roads);
    best = Math.min(best, performance.now() - t0);
  }
  const working = s.fixes.filter((f) => draws(f.scene, roads)).length;
  return { id: c.id, src: c.src, vehicles: c.scene.vehicles.length, code, working, offered: s.fixes.length, best: s.fixes[0]?.id ?? null, ms: best };
}

const pct = (a: number, b: number): string => (b ? `${((100 * a) / b).toFixed(1)}%` : "-");
const quantile = (xs: readonly number[], q: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]! : 0;
};
const ms = (x: number): string => `${x.toFixed(0)} ms`;

function row(label: string, rs: readonly CaseResult[]): string {
  const fixed = rs.filter((r) => r.working > 0).length;
  const t = rs.map((r) => r.ms);
  return `| ${label} | ${rs.length} | ${fixed} | ${pct(fixed, rs.length)} | ${ms(quantile(t, 0.5))} | ${ms(quantile(t, 0.95))} | ${ms(Math.max(0, ...t))} |`;
}

/** A markdown summary: overall, by vehicle count, by generator and by refusal code. */
export function summarize(rs: readonly CaseResult[], title: string): string {
  const head = "| Group | Refused | With a working fix | Share | Median | p95 | Worst |\n|---|---:|---:|---:|---:|---:|---:|";
  const lines = [`### ${title}`, "", head, row("**All**", rs)];
  for (const n of [2, 3, 4]) lines.push(row(`${n} vehicles`, rs.filter((r) => r.vehicles === n)));
  for (const src of [...new Set(rs.map((r) => r.src))]) lines.push(row(`from ${src}`, rs.filter((r) => r.src === src)));
  const codes = [...new Set(rs.map((r) => r.code))].sort();
  for (const code of codes) lines.push(row(`\`${code}\``, rs.filter((r) => r.code === code)));
  const slow = [...rs].sort((a, b) => b.ms - a.ms).slice(0, 5).map((r) => `${r.id} (${r.vehicles} vehicles, ${r.code}, ${ms(r.ms)})`);
  lines.push("", `Slowest: ${slow.join("; ")}.`);
  return lines.join("\n");
}
