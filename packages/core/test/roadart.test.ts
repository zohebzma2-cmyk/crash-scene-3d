// Road art: ribbons follow the lane convention, medians stay open, paint stays on its road and stops at junctions, aisles get stalls.
import { describe, expect, it } from "vitest";
import { ART, buildRoadArt, insideRibbon, ribbonExcess, isContinuation, placeStreetNames, pointInPolygon, streetNameSpots } from "../src";
import type { Building, ParkingArea, RoadKind, RoadNetwork, RoadWay, Vec2 } from "../src";

let n = 0;
function way(pts: Array<[number, number]>, o: Partial<RoadWay> & { kind?: RoadKind } = {}): RoadWay {
  return {
    id: o.id ?? `r${++n}`, name: o.name ?? null, ref: null, kind: o.kind ?? "residential", oneway: o.oneway ?? false,
    lanesForward: o.lanesForward ?? 1, lanesBackward: o.lanesBackward ?? (o.oneway ? 0 : 1), laneWidthM: o.laneWidthM ?? 3.5,
    centerline: pts.map(([x, y]) => ({ x, y })), speedLimitMph: null, osmWayIds: [],
  };
}
const net = (ways: RoadWay[], extra: { parking?: ParkingArea[]; buildings?: Building[] } = {}): RoadNetwork => ({
  frame: { origin: { lat: 42.7, lon: -71.4 } }, radiusM: 250, ways, buildings: extra.buildings ?? [], parking: extra.parking ?? [],
  terrain: null, attribution: [], fetchedAt: "t",
});
const along = (pts: readonly Vec2[], step = 0.4): Vec2[] => {
  const out: Vec2[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!, b = pts[i + 1]!, k = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let j = 0; j < k; j++) out.push({ x: a.x + ((b.x - a.x) * j) / k, y: a.y + ((b.y - a.y) * j) / k });
  }
  out.push(pts[pts.length - 1]!);
  return out;
};

describe("ribbons follow the lane convention", () => {
  it("a two-way road has its backward lanes left of the centerline and forward lanes right of it", () => {
    const art = buildRoadArt(net([way([[0, -50], [0, 50]], { id: "a", lanesForward: 3, lanesBackward: 2 })]));
    const r = art.byId("a")!;
    expect(r.right[0]).toBeCloseTo(10.5);
    expect(r.left[0]).toBeCloseTo(7);
    // heading north: right is east
    expect(insideRibbon(art, "a", { x: 10, y: 0 })).toBe(true);
    expect(insideRibbon(art, "a", { x: -6.9, y: 0 })).toBe(true);
    expect(insideRibbon(art, "a", { x: 11, y: 0 })).toBe(false);
    expect(insideRibbon(art, "a", { x: -7.2, y: 0 })).toBe(false);
  });
  it("a one-way road is centred", () => {
    const art = buildRoadArt(net([way([[0, -50], [0, 50]], { id: "a", oneway: true, lanesForward: 4 })]));
    expect(art.byId("a")!.left[0]).toBeCloseTo(7);
    expect(art.byId("a")!.right[0]).toBeCloseTo(7);
  });
  it("the ribbon is cut square at the ends", () => {
    const art = buildRoadArt(net([way([[0, -50], [0, 50]], { id: "a" })]));
    expect(insideRibbon(art, "a", { x: 0, y: 49.9 })).toBe(true);
    expect(insideRibbon(art, "a", { x: 0, y: 50.5 })).toBe(false);
  });
  it("points are no more than STEP_M apart so the road can follow the terrain", () => {
    const r = buildRoadArt(net([way([[0, -200], [0, 200]], { id: "a" })])).byId("a")!;
    for (let i = 1; i < r.line.length; i++) expect(Math.hypot(r.line[i]!.x - r.line[i - 1]!.x, r.line[i]!.y - r.line[i - 1]!.y)).toBeLessThanOrEqual(ART.STEP_M + 1e-9);
  });
});

describe("divided roads keep a median", () => {
  const carriageways = (gap: number, lanes: number) => net([
    way([[0, -100], [0, 100]], { id: "nb", oneway: true, lanesForward: lanes, name: "Pike" }),
    way([[-gap, 100], [-gap, -100]], { id: "sb", oneway: true, lanesForward: lanes, name: "Pike" }),
  ]);
  it("leaves them alone when they are far enough apart", () => {
    const art = buildRoadArt(carriageways(25, 5));
    expect(art.byId("nb")!.right[5]).toBeCloseTo(8.75);
  });
  it("pulls the facing sides back when the ribbons would overlap or touch, leaving the median open", () => {
    const art = buildRoadArt(carriageways(12, 5)); // 5 lanes each want 8.75 m either side of lines 12 m apart
    const nb = art.byId("nb")!, sb = art.byId("sb")!;
    for (let i = 5; i < nb.line.length - 5; i++) {
      // nb runs north: its left is west, the median side
      expect(nb.left[i]! + sb.left[i]!).toBeLessThanOrEqual(12 - ART.MEDIAN_M + 1e-6);
      expect(nb.left[i]!).toBeLessThan(8.75);
      expect(nb.right[i]).toBeCloseTo(8.75); // the outside is untouched
    }
    // no point is inside both ribbons
    for (let y = -90; y <= 90; y += 5) for (let x = -25; x <= 12; x += 0.5) {
      const p = { x, y };
      expect(insideRibbon(art, "nb", p) && insideRibbon(art, "sb", p), `${x},${y}`).toBe(false);
    }
  });
  it("draws a solid edge line on each side, on the ribbon edge even where it was pulled in", () => {
    const art = buildRoadArt(carriageways(12, 5));
    const edges = art.paint.filter((p) => p.roadId === "nb" && p.kind === "edge");
    expect(edges).toHaveLength(2);
    for (const e of edges) for (const p of e.points) expect(insideRibbon(art, "nb", p)).toBe(true);
    const lane = art.paint.filter((p) => p.roadId === "nb" && p.kind === "lane");
    expect(lane.every((l) => l.dashed)).toBe(true);
    expect(edges.every((l) => !l.dashed)).toBe(true);
  });
  it("draws four dashed lane lines between five lanes", () => {
    const art = buildRoadArt(carriageways(25, 5));
    const lanes = art.paint.filter((p) => p.roadId === "nb" && p.kind === "lane");
    expect(lanes).toHaveLength(4);
  });
});

describe("paint stops at junctions", () => {
  const MARGIN = ART.JUNCTION_GAP_M - 0.6;
  const checkPaint = (art: ReturnType<typeof buildRoadArt>) => {
    for (const line of art.paint) {
      if (line.kind === "stall") continue;
      for (const p of along(line.points)) {
        expect(insideRibbon(art, line.roadId, p, 0.05), `${line.roadId} ${line.kind} at ${p.x},${p.y} is outside its road`).toBe(true);
        for (const other of art.ribbons) {
          if (other.way.id === line.roadId) continue;
          const own = art.byId(line.roadId)!;
          if (isContinuation(own, other)) continue;
          const { excess, dir } = ribbonExcess(other, p);
          // only roads that really cross: not nearly parallel neighbours
          const i = own.line.reduce((best, q, k) => (Math.hypot(q.x - p.x, q.y - p.y) < Math.hypot(own.line[best]!.x - p.x, own.line[best]!.y - p.y) ? k : best), 0);
          const a = own.line[Math.max(0, i - 1)]!, b = own.line[Math.min(own.line.length - 1, i + 1)]!;
          const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
          const cos = Math.abs(((b.x - a.x) / l) * dir.x + ((b.y - a.y) / l) * dir.y);
          if (cos > ART.PARALLEL_COS) continue;
          expect(excess, `${line.roadId} ${line.kind} at ${p.x.toFixed(1)},${p.y.toFixed(1)} is inside the box of ${other.way.id}`).toBeGreaterThanOrEqual(MARGIN);
        }
      }
    }
  };
  it("a crossroads has no lane lines in its box, and lines stop about a meter and a half short of the other road", () => {
    const art = buildRoadArt(net([
      way([[-100, 0], [100, 0]], { id: "ew", lanesForward: 2, lanesBackward: 2 }),
      way([[0, -100], [0, 100]], { id: "ns", lanesForward: 2, lanesBackward: 2 }),
    ]));
    checkPaint(art);
    // the east-west road's lines exist on both sides of the box
    const ew = art.paint.filter((p) => p.roadId === "ew");
    expect(ew.some((l) => l.points.some((p) => p.x < -20))).toBe(true);
    expect(ew.some((l) => l.points.some((p) => p.x > 20))).toBe(true);
    // none of them inside the ns ribbon (14 m wide: x within 7 m) plus the gap
    for (const l of ew) for (const p of l.points) expect(Math.abs(p.x)).toBeGreaterThanOrEqual(7 + MARGIN);
    // and they come close to it: within the gap plus the dash cut resolution
    const nearest = Math.min(...ew.flatMap((l) => l.points.map((p) => Math.abs(p.x))));
    expect(nearest).toBeLessThan(7 + ART.JUNCTION_GAP_M + 0.5);
  });
  it("a T: the side road ends before the main road's edge, the main road's lines break across the mouth", () => {
    const art = buildRoadArt(net([
      way([[-100, 0], [0, 0]], { id: "w" }),
      way([[0, 0], [100, 0]], { id: "e" }),
      way([[0, -100], [0, 0]], { id: "stem" }),
    ]));
    checkPaint(art);
    const stem = art.paint.filter((p) => p.roadId === "stem");
    expect(stem.length).toBeGreaterThan(0);
    for (const l of stem) for (const p of l.points) expect(p.y).toBeLessThanOrEqual(-3.5 - MARGIN + 1e-6);
    // the through road has paint far from the mouth
    expect(art.paint.some((p) => p.roadId === "w" && p.points.some((q) => q.x < -30))).toBe(true);
  });
  it("two pieces of one street that meet end to end carry their paint through the joint", () => {
    const a = way([[-100, 0], [0, 0]], { id: "a", name: "Main" }), b = way([[0, 0], [100, 0]], { id: "b", name: "Main" });
    const art = buildRoadArt(net([a, b]));
    expect(isContinuation(art.byId("a")!, art.byId("b")!)).toBe(true);
    const center = art.paint.filter((p) => p.kind === "center");
    expect(center.some((l) => l.roadId === "a" && l.points.some((p) => p.x > -0.5))).toBe(true);
    expect(center.some((l) => l.roadId === "b" && l.points.some((p) => p.x < 0.5))).toBe(true);
  });
  it("where two nearly parallel ribbons overlap, the wider road keeps its paint and the other gives it up", () => {
    const art = buildRoadArt(net([
      way([[0, -50], [0, 50]], { id: "big", lanesForward: 3, lanesBackward: 3, name: "Big" }),
      way([[2, -50], [2, 50]], { id: "dupe", lanesForward: 1, lanesBackward: 1, name: "Big" }),
    ]));
    checkPaint(art);
    const dupe = art.paint.filter((p) => p.roadId === "dupe");
    for (const l of dupe) for (const p of l.points) expect(insideRibbon(art, "big", p, 0)).toBe(false);
    expect(art.paint.filter((p) => p.roadId === "big").length).toBeGreaterThan(0);
  });
  it("a bendy road keeps all its paint inside its own ribbon", () => {
    const art = buildRoadArt(net([way([[-80, -20], [-30, 0], [0, 30], [40, 25], [90, 60]], { id: "bend", lanesForward: 2, lanesBackward: 2 })]));
    checkPaint(art);
    expect(art.paint.length).toBeGreaterThan(3);
  });
});

describe("parking aisles and stalls", () => {
  const lot: ParkingArea = { id: "lot", outline: [{ x: -40, y: -30 }, { x: 40, y: -30 }, { x: 40, y: 30 }, { x: -40, y: 30 }] };
  it("an aisle has no centerline and no edge lines, only stalls", () => {
    const art = buildRoadArt(net([way([[-30, 0], [30, 0]], { id: "aisle", kind: "parking_aisle" })], { parking: [lot] }));
    const mine = art.paint.filter((p) => p.roadId === "aisle");
    expect(mine.length).toBeGreaterThan(10);
    expect(mine.every((p) => p.kind === "stall")).toBe(true);
  });
  it("stalls are about 2.6 m apart, 5.5 m deep, perpendicular, on both sides, inside the lot", () => {
    const art = buildRoadArt(net([way([[-30, 0], [30, 0]], { id: "aisle", kind: "parking_aisle" })], { parking: [lot] }));
    const stalls = art.paint.filter((p) => p.kind === "stall");
    const north = stalls.filter((s) => s.points[1]!.y > 0), south = stalls.filter((s) => s.points[1]!.y < 0);
    expect(north.length).toBeGreaterThan(15);
    expect(south.length).toBe(north.length);
    for (const s of stalls) {
      const [a, b] = s.points as [Vec2, Vec2];
      expect(Math.abs(a.x - b.x)).toBeLessThan(1e-6);
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(ART.STALL_D_M, 0);
      expect(Math.abs(a.y)).toBeCloseTo(3.5, 1); // starts on the aisle edge
      expect(pointInPolygon(b, lot.outline)).toBe(true);
    }
    const xs = north.map((s) => s.points[0]!.x).sort((p, q) => p - q);
    expect(xs[1]! - xs[0]!).toBeCloseTo(ART.STALL_W_M, 1);
  });
  it("stalls never cross a building, another aisle or the lot edge", () => {
    const building: Building = { id: "b", footprint: [{ x: -10, y: 5 }, { x: 10, y: 5 }, { x: 10, y: 20 }, { x: -10, y: 20 }], heightM: 5, heightSource: "default" };
    const cross = way([[20, -30], [20, 30]], { id: "cross", kind: "parking_aisle" });
    const art = buildRoadArt(net([way([[-30, 0], [30, 0]], { id: "aisle", kind: "parking_aisle" }), cross], { parking: [lot], buildings: [building] }));
    for (const s of art.paint.filter((p) => p.roadId === "aisle" && p.kind === "stall")) {
      for (const p of along(s.points, 0.1)) {
        expect(pointInPolygon(p, building.footprint) && p.y > 5.001, `${p.x},${p.y} in building`).toBe(false);
        expect(insideRibbon(art, "cross", p, -0.05), `${p.x},${p.y} in the cross aisle`).toBe(false);
      }
    }
    // the building is 5 m from the aisle edge at its nearest (y 3.5 to 5): too shallow for a stall
    expect(art.paint.some((s) => s.roadId === "aisle" && s.points[0]!.y > 0 && Math.abs(s.points[0]!.x) < 9)).toBe(false);
  });
  it("draws no stalls outside a lot", () => {
    const art = buildRoadArt(net([way([[-30, 100], [30, 100]], { id: "aisle", kind: "parking_aisle" })], { parking: [lot] }));
    expect(art.paint).toHaveLength(0);
  });
});

describe("street names", () => {
  const cross = () => buildRoadArt(net([
    way([[-120, 0], [120, 0]], { id: "ew", name: "Park Street", lanesForward: 1, lanesBackward: 1 }),
    way([[0, -120], [0, 120]], { id: "ns", name: "Main Street", lanesForward: 2, lanesBackward: 2 }),
    way([[60, 40], [60, 100]], { id: "aisle", kind: "parking_aisle" }),
    way([[-60, 40], [-60, 100]], { id: "unnamed" }),
  ]));
  const focus = { x: 0, y: 0 };
  it("offers spots only on named roads, never inside a junction box", () => {
    const art = cross();
    const spots = streetNameSpots(art, focus);
    expect(new Set(spots.map((s) => s.name))).toEqual(new Set(["Park Street", "Main Street"]));
    for (const s of spots) {
      const own = s.name === "Park Street" ? "ew" : "ns", other = s.name === "Park Street" ? "ns" : "ew";
      expect(ribbonExcess(art.byId(other)!, s.at).excess, `${s.name} at ${s.at.x},${s.at.y}`).toBeGreaterThanOrEqual(1 - 1e-9);
      expect(insideRibbon(art, own, s.at)).toBe(true);
      expect(s.angleRad).toBeLessThanOrEqual(Math.PI / 2 + 0.21 + 1e-9);
      expect(s.angleRad).toBeGreaterThan(-Math.PI / 2 + 0.21 - 1e-9);
      expect(s.halfSpanM).toBeGreaterThanOrEqual(3);
    }
  });
  it("places one name per street, clear of each other, of the crash and of the vehicle paths, within reach", () => {
    const art = cross();
    const spots = streetNameSpots(art, focus);
    const size = (name: string) => [{ lengthM: name.length * 0.9, heightM: 1.4 }];
    const avoid = Array.from({ length: 40 }, (_, i) => ({ x: 3.5, y: -30 + i * 1.5 }));
    const placed = placeStreetNames(spots, size, focus, { avoid });
    expect(placed.map((p) => p.name).sort()).toEqual(["Main Street", "Park Street"]);
    for (const p of placed) {
      const l = p.lengthM, h = p.heightM, c = Math.cos(p.angleRad), s = Math.sin(p.angleRad);
      const fu = Math.abs((0 - p.at.x) * c + (0 - p.at.y) * s), fv = Math.abs(-(0 - p.at.x) * s + (0 - p.at.y) * c);
      expect(Math.hypot(Math.max(fu - l / 2, 0), Math.max(fv - h / 2, 0))).toBeGreaterThanOrEqual(5);
      expect(Math.hypot(fu + l / 2, fv + h / 2)).toBeLessThanOrEqual(22);
      for (const a of avoid) {
        const u = Math.abs((a.x - p.at.x) * c + (a.y - p.at.y) * s), v = Math.abs(-(a.x - p.at.x) * s + (a.y - p.at.y) * c);
        expect(u < l / 2 && v < h / 2, `path point ${a.x},${a.y} is under ${p.name}`).toBe(false);
      }
    }
  });
  it("leaves a name off when it has no room", () => {
    const art = cross();
    const placed = placeStreetNames(streetNameSpots(art, focus), () => [{ lengthM: 200, heightM: 1.4 }], focus);
    expect(placed).toHaveLength(0);
  });
});
