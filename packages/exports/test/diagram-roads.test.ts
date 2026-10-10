// The diagram (PDF and PNG) draws the same roads as the 3D view: one outline per carriageway with the median
// open, paint kept on its road, stalls in the lots.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { parseScene, simulate } from "@csd/core";
import type { RoadNetwork, SimulationResult } from "@csd/core";
import { parseOverpass } from "@csd/mapdata";
import { planDiagram } from "../src/diagram";
import type { Prim, Pt } from "../src/draw";
import { color } from "../src/style";
import { brandMeasure } from "./helpers";

function load(name: string): { net: RoadNetwork; sim: SimulationResult } {
  const dir = new URL(`../../../examples/${name}/`, import.meta.url);
  const osm = JSON.parse(readFileSync(new URL("osm.json", dir), "utf8"));
  const net = parseOverpass(osm, { origin: osm.center }, osm.radiusM, osm.fetchedAt);
  const sc = parseScene(JSON.parse(readFileSync(new URL("scene.json", dir), "utf8")));
  if (!sc.ok) throw new Error("scene");
  const r = simulate(sc.value, net);
  if (!r.ok) throw new Error("sim");
  return { net, sim: r.result };
}
/** Non-zero winding, the rule a canvas or PDF fill uses (a road outline that crosses itself on a tight bend still fills). */
function filled(p: Pt, poly: readonly Pt[]): boolean {
  let w = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j]!, b = poly[i]!;
    const side = (b[0] - a[0]) * (p[1] - a[1]) - (p[0] - a[0]) * (b[1] - a[1]);
    if (a[1] <= p[1]) { if (b[1] > p[1] && side > 0) w++; } else if (b[1] <= p[1] && side < 0) w--;
  }
  return w !== 0;
}
const area = (poly: readonly Pt[]) => Math.abs(poly.reduce((s, a, i) => { const b = poly[(i + 1) % poly.length]!; return s + a[0] * b[1] - b[0] * a[1]; }, 0)) / 2;
const roadFills = (prims: readonly Prim[]) => prims.filter((p): p is Extract<Prim, { k: "poly" }> => p.k === "poly" && p.closed === true && p.fill === color("color-scene-road") && !p.stroke);
const paintLines = (prims: readonly Prim[]) => prims.filter((p): p is Extract<Prim, { k: "poly" }> => p.k === "poly" && !p.closed && p.stroke?.color === color("color-scene-lane"));

describe("the diagram's roads", () => {
  let measure: Awaited<ReturnType<typeof brandMeasure>>;
  beforeAll(async () => { measure = await brandMeasure(); });
  const box = { x: 0, y: 0, w: 1600, h: 1450 };

  it("draws the two carriageways of the highway as separate outlines with the median open", () => {
    const { net, sim } = load("highway-rear-end");
    const plan = planDiagram(sim, net, { box, minTextSize: 20, minLine: 2 }, measure);
    const fills = roadFills(plan.prims).sort((p, q) => area(q.pts) - area(p.pts));
    const [one, two] = fills;
    expect(one && two).toBeTruthy();
    // no point of the picture is on both carriageways, and between them there is bare ground along the whole picture
    let gap = 0;
    for (let y = 0; y < box.h; y += 25) {
      let both = false, between = false, inOne = false, inTwo = false;
      for (let x = 0; x < box.w; x += 5) {
        const a = filled([x, y], one!.pts), b = filled([x, y], two!.pts);
        if (a && b) both = true;
        if (a) inOne = true;
        if (b) inTwo = true;
        if (inOne && inTwo && !a && !b) between = true;
      }
      expect(both, `row ${y}`).toBe(false);
      if (between) gap++;
    }
    expect(gap).toBeGreaterThan(20);
  });

  for (const name of ["t-bone-intersection", "highway-rear-end", "parking-lot-backing"]) {
    it(`${name}: every lane line lies on a road surface`, () => {
      const { net, sim } = load(name);
      const plan = planDiagram(sim, net, { box, minTextSize: 20, minLine: 2 }, measure);
      const fills = roadFills(plan.prims);
      expect(fills.length).toBeGreaterThan(0);
      const lines = paintLines(plan.prims);
      expect(lines.length).toBeGreaterThan(0);
      const stallWidth = Math.max(0.4 * 2, 0.12 * plan.scale);
      for (const l of lines) {
        if (Math.abs((l.stroke?.width ?? 0) - stallWidth) < 1e-6) continue; // stall lines are on the lot, not a road
        for (const p of l.pts) {
          if (p[0] < 0 || p[0] > box.w || p[1] < 0 || p[1] > box.h) continue;
          // inside a road outline, or on its edge (a line that ends at the end of its road touches the outline)
          const dEdge = Math.min(...fills.flatMap((f) => f.pts.map((q, i) => { const r = f.pts[(i + 1) % f.pts.length]!; const vx = r[0] - q[0], vy = r[1] - q[1]; const k = Math.max(0, Math.min(1, ((p[0] - q[0]) * vx + (p[1] - q[1]) * vy) / (vx * vx + vy * vy || 1))); return Math.hypot(p[0] - q[0] - vx * k, p[1] - q[1] - vy * k); })));
          expect(fills.some((f) => filled(p, f.pts)) || dEdge < 1.5, `lane line point ${p[0].toFixed(0)},${p[1].toFixed(0)} is off the road (${dEdge.toFixed(1)} px from the nearest outline)`).toBe(true);
        }
      }
    });
  }

  it("parking-lot-backing: the lot is drawn with stall lines and the aisles carry no centerline", () => {
    const { net, sim } = load("parking-lot-backing");
    const plan = planDiagram(sim, net, { box, minTextSize: 20, minLine: 2 }, measure);
    const thin = paintLines(plan.prims).filter((l) => l.pts.length === 2 && !l.stroke?.dash);
    expect(thin.length).toBeGreaterThan(20);
    // no dashed or long center lines run along the aisle in view: every paint line here is a two-point stall stroke or short
    const aisleLines = paintLines(plan.prims).filter((l) => l.pts.length > 2);
    for (const l of aisleLines) expect(l.stroke?.width ?? 0).toBeLessThan(plan.scale * 0.5);
  });
});
