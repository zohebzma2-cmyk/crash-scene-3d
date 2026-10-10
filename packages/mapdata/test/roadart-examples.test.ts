// The three example scenes through the road art: the highway's two carriageways, the lot, and paint on every road.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ART, buildRoadArt, insideRibbon, isContinuation, parseScene, pointInPolygon, ribbonExcess, simulate } from "@csd/core";
import type { RoadNetwork, Scene, Vec2 } from "@csd/core";
import { parseOverpass } from "../src";
import { loadExample } from "./helpers";

const NAMES = ["t-bone-intersection", "highway-rear-end", "parking-lot-backing"] as const;
function roadsOf(name: string): RoadNetwork {
  const { json, frame } = loadExample(name);
  return parseOverpass(json, frame, json.radiusM, json.fetchedAt);
}
function sceneOf(name: string): Scene {
  const r = parseScene(JSON.parse(readFileSync(new URL(`../../../examples/${name}/scene.json`, import.meta.url), "utf8")));
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.value;
}
const inBox = (r: { box: { minX: number; minY: number; maxX: number; maxY: number } }, p: Vec2, pad = 3) => p.x >= r.box.minX - pad && p.x <= r.box.maxX + pad && p.y >= r.box.minY - pad && p.y <= r.box.maxY + pad;
/** Points along a polyline with the direction(s) of the piece(s) they sit on: two at a vertex. */
const sampled = (pts: readonly Vec2[], step = 1): Array<{ p: Vec2; dirs: Vec2[] }> => {
  const out: Array<{ p: Vec2; dirs: Vec2[] }> = [];
  const dirOf = (a: Vec2, b: Vec2): Vec2 => { const l = Math.hypot(b.x - a.x, b.y - a.y) || 1; return { x: (b.x - a.x) / l, y: (b.y - a.y) / l }; };
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!, b = pts[i + 1]!, d = dirOf(a, b), k = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let j = 0; j <= k; j++) {
      const dirs = [d];
      if (j === 0 && i > 0) dirs.push(dirOf(pts[i - 1]!, a));
      if (j === k && i + 2 < pts.length) dirs.push(dirOf(b, pts[i + 2]!));
      out.push({ p: { x: a.x + ((b.x - a.x) * j) / k, y: a.y + ((b.y - a.y) * j) / k }, dirs });
    }
  }
  return out;
};
const along = (pts: readonly Vec2[], step = 0.5): Vec2[] => {
  const out: Vec2[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!, b = pts[i + 1]!, k = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let j = 0; j < k; j++) out.push({ x: a.x + ((b.x - a.x) * j) / k, y: a.y + ((b.y - a.y) * j) / k });
  }
  out.push(pts[pts.length - 1]!);
  return out;
};

describe("highway-rear-end: what OSM says about the Everett Turnpike", () => {
  const { json } = loadExample("highway-rear-end");
  type El = { type: string; id: number; tags?: Record<string, string> };
  const tags = (id: number) => (json.elements as El[]).find((e) => e.type === "way" && e.id === id)!.tags!;

  it("tags each carriageway as one-way with lanes=5, with no lanes:forward, turn:lanes or width to read instead", () => {
    for (const id of [32477474, 42004744]) {
      const t = tags(id);
      expect(t.oneway).toBe("yes");
      expect(t.lanes).toBe("5");
      expect(t["lanes:forward"]).toBeUndefined();
      expect(t["turn:lanes"]).toBeUndefined();
      expect(t.width).toBeUndefined();
    }
  });
  it("carries the extra lanes as a motorway_link merging in (2 lanes) and a lane that cannot change (change:lanes), not as a mistake of ours", () => {
    expect(tags(909191004).highway).toBe("motorway_link");
    expect(tags(909191004).lanes).toBe("2");
    expect(tags(32477472).lanes).toBe("3"); // the 3-lane bridge upstream
    expect(tags(1340425291)["change:lanes"]).toBe("yes|yes|yes|not_right|no");
  });
  it("parses to two opposite one-way roads of 5 lanes each, and nothing else on the Turnpike's carriageways", () => {
    const net = roadsOf("highway-rear-end");
    const nb = net.ways.find((w) => w.id === "w42004744")!, sb = net.ways.find((w) => w.id === "w32477474")!;
    for (const w of [nb, sb]) { expect(w.oneway).toBe(true); expect(w.lanesForward).toBe(5); expect(w.lanesBackward).toBe(0); expect(w.laneWidthM).toBe(3.5); }
    const nbEnd = nb.centerline[nb.centerline.length - 1]!, nbStart = nb.centerline[0]!;
    expect(nbEnd.y).toBeGreaterThan(nbStart.y);
    expect(sb.centerline[sb.centerline.length - 1]!.y).toBeLessThan(sb.centerline[0]!.y);
  });
});

describe("highway-rear-end: the two carriageways are drawn apart, each around its own centerline", () => {
  const net = roadsOf("highway-rear-end");
  const art = buildRoadArt(net);
  it("each ribbon is 17.5 m (5 lanes) wide around its own line", () => {
    for (const id of ["w42004744", "w32477474"]) {
      const r = art.byId(id)!;
      expect(r.left.every((e) => Math.abs(e - 8.75) < 1e-9)).toBe(true);
      expect(r.right.every((e) => Math.abs(e - 8.75) < 1e-9)).toBe(true);
    }
  });
  it("the ribbons never overlap, with a median between them", () => {
    const nb = art.byId("w42004744")!, sb = art.byId("w32477474")!;
    let minGap = Infinity;
    for (const p of nb.leftEdge) {
      const e = ribbonExcess(sb, p).excess; // how far the nb left edge is outside the sb ribbon
      minGap = Math.min(minGap, e);
    }
    expect(minGap).toBeGreaterThanOrEqual(ART.MEDIAN_M);
    for (let y = -240; y <= 240; y += 4) for (let x = -50; x <= 30; x += 0.5) {
      expect(insideRibbon(art, "w42004744", { x, y }) && insideRibbon(art, "w32477474", { x, y }), `${x},${y}`).toBe(false);
    }
  });
  it("each carriageway has four dashed lane lines and a solid edge line on each side, including next to the median", () => {
    for (const id of ["w42004744", "w32477474"]) {
      const mine = art.paint.filter((p) => p.roadId === id);
      expect(mine.filter((p) => p.kind === "lane" && p.dashed).length).toBe(4);
      const edges = mine.filter((p) => p.kind === "edge" && !p.dashed);
      expect(edges.length).toBe(2);
      expect(mine.some((p) => p.kind === "center")).toBe(false);
      const r = art.byId(id)!;
      // one edge line runs along the median side (the side facing the other carriageway)
      const other = art.byId(id === "w42004744" ? "w32477474" : "w42004744")!;
      const medianSide = edges.filter((e) => e.points.every((p) => ribbonExcess(other, p).excess < 25));
      expect(medianSide.length).toBeGreaterThan(0);
      for (const e of edges) for (const p of e.points) expect(ribbonExcess(r, p).excess).toBeLessThanOrEqual(0.05);
    }
  });
  it("the physics lane paths sit inside the drawn ribbon of their own carriageway, before impact", () => {
    const r = simulate(sceneOf("highway-rear-end"), net);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sim = r.result;
    const before = Math.floor(-sim.startTimeS / sim.dtS);
    expect(before).toBeGreaterThan(100);
    for (const v of sim.vehicles) {
      expect(v.path?.roadId).toBe("w42004744");
      for (let i = 0; i < before; i += 5) {
        const t = v.track[i]!;
        const p = { x: t.xM, y: t.yM };
        expect(insideRibbon(art, "w42004744", p), `${v.id} at t=${(sim.startTimeS + i * sim.dtS).toFixed(2)} (${p.x.toFixed(1)}, ${p.y.toFixed(1)})`).toBe(true);
        expect(insideRibbon(art, "w32477474", p)).toBe(false);
        // and inside a lane of that ribbon, not on its edge line
        expect(ribbonExcess(art.byId("w42004744")!, p).excess).toBeLessThan(-ART.EDGE_IN_M);
      }
    }
  });
});

describe("parking-lot-backing: the lot, its aisles and its stalls", { timeout: 60_000 }, () => {
  const net = roadsOf("parking-lot-backing");
  const art = buildRoadArt(net);
  it("aisles carry no centerline and no edge lines", () => {
    const aisles = new Set(net.ways.filter((w) => w.kind === "parking_aisle").map((w) => w.id));
    expect(aisles.size).toBeGreaterThan(10);
    for (const p of art.paint) if (aisles.has(p.roadId)) expect(p.kind).toBe("stall");
  });
  it("stalls are about 5.5 m deep at most, inside a lot, clear of buildings and of every road ribbon", () => {
    const stalls = art.paint.filter((p) => p.kind === "stall");
    expect(stalls.length).toBeGreaterThan(200);
    for (const s of stalls) {
      const [a, b] = s.points as [Vec2, Vec2];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      expect(len).toBeLessThanOrEqual(ART.STALL_D_M + 0.3);
      expect(len).toBeGreaterThanOrEqual(ART.STALL_MIN_D_M - 0.3);
      for (const p of along([a, b], 0.5)) {
        if (Math.hypot(p.x - a.x, p.y - a.y) < 0.3) continue; // the start sits on the aisle edge
        expect(net.parking.some((l) => pointInPolygon(p, l.outline)), `stall point ${p.x.toFixed(1)},${p.y.toFixed(1)} is outside every lot`).toBe(true);
        expect(net.buildings.some((bd) => pointInPolygon(p, bd.footprint)), "stall point is inside a building").toBe(false);
        for (const r of art.ribbons) if (r.way.id !== s.roadId && inBox(r, p) && !isContinuation(r, art.byId(s.roadId)!)) expect(ribbonExcess(r, p).excess, `stall of ${s.roadId} crosses ${r.way.id}`).toBeGreaterThanOrEqual(-0.15);
      }
    }
  });
});

describe("every example: paint stays on its road and out of the junction boxes", { timeout: 60_000 }, () => {
  for (const name of NAMES) {
    it(name, () => {
      const net = roadsOf(name);
      const art = buildRoadArt(net);
      expect(art.paint.length).toBeGreaterThan(0);
      const margin = ART.JUNCTION_GAP_M - 0.6;
      for (const line of art.paint) {
        if (line.kind === "stall") continue;
        const own = art.byId(line.roadId)!;
        for (const { p, dirs } of sampled(line.points, 1)) {
          expect(ribbonExcess(own, p).excess, `${line.roadId} ${line.kind} at ${p.x.toFixed(1)},${p.y.toFixed(1)} is outside its ribbon`).toBeLessThanOrEqual(0.06);
          for (const other of art.ribbons) {
            if (other === own || isContinuation(own, other) || !inBox(other, p)) continue;
            const { excess, dir } = ribbonExcess(other, p);
            if (dirs.length > 1) continue; // a vertex: the road turns here, which of its two pieces counts is a matter of a point
            if (dirs.some((d) => Math.abs(d.x * dir.x + d.y * dir.y) > ART.PARALLEL_COS)) continue; // a parallel neighbour, not a crossing
            expect(excess, `${line.roadId} ${line.kind} at ${p.x.toFixed(1)},${p.y.toFixed(1)} is inside the box of ${other.way.id} (paint dirs ${JSON.stringify(dirs)}, road dir ${JSON.stringify(dir)})`).toBeGreaterThanOrEqual(margin);
          }
        }
      }
    });
  }
});
