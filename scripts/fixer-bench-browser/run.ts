// One benchmark scene through the old (v1) or the new fixer: its time and how many fixes it offered.
import { suggestFixes } from "@csd/core";
// The fixer before round A (commit 8dde902, its own physics), unpacked by scripts/fixer-v1.mjs.
import { suggestFixes as suggestV1 } from "@fixer-v1";
import { cases, roadsOf } from "./data";

export interface One { readonly i: number; readonly ms: number; readonly fixes: number; readonly vehicles: number }
export function runOne(i: number, which: string): One {
  const c = cases[i]!;
  const roads = roadsOf(c.net);
  const fixer = which === "v1" ? suggestV1 : suggestFixes;
  // The fastest of two cold runs, as in Node: each on its own copy of the roads, so nothing remembered per road network helps.
  let best = Infinity, fixes = 0;
  for (let k = 0; k < 2; k++) {
    const fresh = roads ? structuredClone(roads) : null;
    const t0 = performance.now();
    fixes = fixer(c.scene, fresh).fixes.length;
    best = Math.min(best, performance.now() - t0);
  }
  return { i, ms: best, fixes, vehicles: c.scene.vehicles.length };
}
