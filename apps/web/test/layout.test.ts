import { describe, expect, it } from "vitest";
import type { Vec2 } from "@csd/core";
import { pointInPolygon, rectsOverlap } from "../src/lib/geometry";
import { placeLabels, type LabelRequest } from "../src/lib/labels";
import { layoutMiniMap, metersPerPixel } from "../src/lib/miniMapLayout";

const bounds = { w: 400, h: 300 };
const req = (id: string, x: number, y: number): LabelRequest => ({ id, anchor: { x, y }, w: 120, h: 28, clearance: 24 });

describe("label collision avoidance", () => {
  it("never lets labels overlap, even when every anchor is the same point", () => {
    const placed = placeLabels([req("a", 200, 150), req("b", 200, 150), req("c", 200, 150), req("d", 205, 152)], { bounds });
    const rects = placed.map((p) => ({ x: p.x, y: p.y, w: 120, h: 28 }));
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) expect(rectsOverlap(rects[i]!, rects[j]!)).toBe(false);
    for (const r of rects) expect(r.x >= 0 && r.y >= 0 && r.x + r.w <= bounds.w && r.y + r.h <= bounds.h).toBe(true);
  });

  it("flips below near the top edge", () => {
    const [p] = placeLabels([req("a", 200, 10)], { bounds });
    expect(p?.side).toBe("below");
    expect(p?.y).toBeGreaterThan(10);
  });

  it("gives a label that had to move away a leader line back to its anchor", () => {
    const placed = placeLabels([req("a", 200, 150), req("b", 200, 150), req("c", 200, 150), req("d", 200, 150), req("e", 200, 150)], { bounds });
    const far = placed.filter((p) => p.side === "far");
    expect(far.length).toBeGreaterThan(0);
    for (const p of far) expect(p.leader).not.toBeNull();
    for (const p of placed.filter((x) => x.side !== "far")) expect(p.leader).toBeNull();
  });

  it("keeps labels off obstacles such as vehicle bodies", () => {
    const obstacle = { x: 140, y: 100, w: 120, h: 40 };
    const [p] = placeLabels([req("a", 200, 150)], { bounds, obstacles: [obstacle] });
    expect(rectsOverlap({ x: p!.x, y: p!.y, w: 120, h: 28 }, obstacle)).toBe(false);
  });
});

describe("street names in the same label pass", () => {
  const street = (id: string, spots: Array<{ x: number; y: number; w: number; h: number }>): LabelRequest => ({ id, anchor: { x: 0, y: 0 }, w: 0, h: 0, clearance: 0, spots, optional: true });

  it("takes the first spot that is free of vehicle labels and measurement pills", () => {
    const vehicle = req("v", 200, 150);
    const [v] = placeLabels([vehicle], { bounds });
    const onLabel = { x: v!.x, y: v!.y, w: 90, h: 20 };
    const free = { x: 20, y: 250, w: 90, h: 20 };
    const out = placeLabels([vehicle, street("Main Street", [onLabel, free])], { bounds });
    const s = out.find((p) => p.id === "Main Street")!;
    expect(s.side).toBe("spot");
    expect(s.spot).toBe(1);
    expect(rectsOverlap({ x: s.x, y: s.y, w: 90, h: 20 }, { x: out[0]!.x, y: out[0]!.y, w: 120, h: 28 })).toBe(false);
  });

  it("drops a street name rather than overlap anything, and never moves the vehicle labels for it", () => {
    const labels = [req("a", 100, 100), req("b", 300, 200)];
    const before = placeLabels(labels, { bounds });
    const blocked = before.map((p) => ({ x: p.x, y: p.y, w: 120, h: 28 }));
    const out = placeLabels([...labels, street("Park Street", blocked)], { bounds });
    expect(out.find((p) => p.id === "Park Street")).toBeUndefined();
    expect(out.filter((p) => p.id !== "Park Street")).toEqual(before);
  });

  it("keeps street names inside the bounds and apart from each other and from obstacles", () => {
    const obstacle = { x: 150, y: 100, w: 100, h: 100 };
    const spot = (x: number, y: number) => ({ x, y, w: 80, h: 18 });
    const out = placeLabels([
      street("One Street", [spot(160, 120), spot(10, 10)]),
      street("Two Street", [spot(10, 10), spot(10, 40)]),
      street("Off Street", [spot(390, 290)]),
    ], { bounds, obstacles: [obstacle] });
    expect(out.map((p) => p.id)).toEqual(["One Street", "Two Street"]);
    const rects = out.map((p) => ({ x: p.x, y: p.y, w: 80, h: 18 }));
    expect(rectsOverlap(rects[0]!, rects[1]!)).toBe(false);
    for (const r of rects) expect(rectsOverlap(r, obstacle)).toBe(false);
  });
});

describe("mini map layout", () => {
  const mPerPx = metersPerPixel(42.76, 18);
  const markerPx = 44;
  const diameter = markerPx * mPerPx;
  const lane = (x: number): Vec2[] => [{ x, y: -100 }, { x, y: 40 }];

  it("puts two vehicles in the same lane one behind the other, never overlapping and never on the pin", () => {
    // a rear-end: both vehicles share a lane and touch at impact
    const out = layoutMiniMap({
      pin: { x: 0, y: 0 }, buildings: [], mPerPx, markerPx,
      vehicles: [
        { id: "A", path: lane(1.7), impact: { x: 1.7, y: 2 }, headingDeg: 0 },
        { id: "B", path: lane(1.7), impact: { x: 1.7, y: -2.5 }, headingDeg: 0 },
      ],
    });
    expect(out).toHaveLength(2);
    const [a, b] = out as [typeof out[0], typeof out[0]];
    expect(Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y)).toBeGreaterThanOrEqual(diameter);
    for (const o of out) expect(Math.hypot(o.pos.x, o.pos.y)).toBeGreaterThanOrEqual(diameter * 0.9);
    // they sit on their lane (x stays on the lane line) and behind the impact point
    for (const o of out) expect(o.pos.x).toBeCloseTo(1.7, 5);
  });

  it("never puts a marker on a building: it slides back along its lane instead", () => {
    const building: Vec2[] = [{ x: -6, y: -60 }, { x: 6, y: -60 }, { x: 6, y: -12 }, { x: -6, y: -12 }];
    const out = layoutMiniMap({ pin: { x: 0, y: 0 }, buildings: [building], mPerPx, markerPx, vehicles: [{ id: "A", path: lane(0), impact: { x: 0, y: 2 }, headingDeg: 0 }] });
    const p = out[0]!;
    expect(pointInPolygon(p.pos, building)).toBe(false);
    expect(p.backM).toBeGreaterThan(diameter * 1.7 - 1e-9);
  });

  it("keeps four vehicles apart and keeps the heading the vehicle faces (a backing vehicle's path runs the other way)", () => {
    const out = layoutMiniMap({
      pin: { x: 0, y: 0 }, buildings: [], mPerPx, markerPx,
      vehicles: [
        { id: "A", path: lane(1.7), impact: { x: 1.7, y: 0 }, headingDeg: 0 },
        { id: "B", path: [{ x: -100, y: -1.7 }, { x: 40, y: -1.7 }], impact: { x: 0, y: -1.7 }, headingDeg: 90 },
        { id: "C", path: [{ x: 100, y: 1.7 }, { x: -40, y: 1.7 }], impact: { x: 0, y: 1.7 }, headingDeg: 270 },
        { id: "D", path: null, impact: { x: 0, y: 0 }, headingDeg: 180 },
      ],
    });
    for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) {
      expect(Math.hypot(out[i]!.pos.x - out[j]!.pos.x, out[i]!.pos.y - out[j]!.pos.y), `${out[i]!.id}-${out[j]!.id}`).toBeGreaterThanOrEqual(diameter);
    }
    expect(out.map((o) => o.headingDeg)).toEqual([0, 90, 270, 180]);
  });
});
