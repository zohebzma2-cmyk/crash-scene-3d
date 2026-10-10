// Self-checks for the helpers the physics tests rely on (these run today; they guard the test code, not the physics).
import { describe, expect, it } from "vitest";
import { PRESETS } from "../src";
import { angleDiffDeg, bearingDegOf, contactProblems, cornersOf, crossings, dimsOf, distToPolyline, fwdOf, overlapDepth, rightOf, zoneAnchor } from "./physics-helpers";
import { FRAME, HWY_X_M, LANE_W_M, highwayNet, intersectionNet, lanesLabNet, parkingLotNet, twoWayLaneOffsetM } from "./roads-fixtures";
import type { RoadNetwork } from "../src";

const pose = (xM: number, yM: number, headingRad: number) => ({ xM, yM, headingRad, speedMps: 0 });

describe("test helpers", () => {
  it("compass headings: 0 faces north, 90 east; right of north is east", () => {
    expect(fwdOf(0).y).toBeCloseTo(1, 12);
    expect(fwdOf(Math.PI / 2).x).toBeCloseTo(1, 12);
    expect(rightOf(0).x).toBeCloseTo(1, 12);
    expect(rightOf(Math.PI / 2).y).toBeCloseTo(-1, 12);
    expect(bearingDegOf({ x: 0, y: 0 }, { x: 1, y: 0 })).toBeCloseTo(90, 9);
    expect(bearingDegOf({ x: 0, y: 0 }, { x: 0, y: -1 })).toBeCloseTo(180, 9);
    expect(angleDiffDeg(350, 10)).toBeCloseTo(20, 9);
  });

  it("separating-axis depth: overlap is positive, touching ~0, apart negative", () => {
    const a = cornersOf(pose(0, 0, 0), 4, 2);
    expect(overlapDepth(a, cornersOf(pose(1.5, 0, 0), 4, 2))).toBeCloseTo(0.5, 9);
    expect(overlapDepth(a, cornersOf(pose(2, 0, 0), 4, 2))).toBeCloseTo(0, 9);
    expect(overlapDepth(a, cornersOf(pose(5, 0, 0), 4, 2))).toBeLessThan(-0.9);
    expect(overlapDepth(a, cornersOf(pose(0, 4, Math.PI / 2), 4, 2))).toBeLessThan(0.01); // a rotated car end-on to A's side: apart or touching
  });

  it("zone anchors sit on the outline in the right place", () => {
    const p = pose(10, 20, Math.PI / 2); // facing east
    const L = 4, W = 2;
    expect(zoneAnchor(p, L, W, "front")).toEqual({ x: 12, y: 20 });
    expect(zoneAnchor(p, L, W, "rear").x).toBeCloseTo(8, 12);
    expect(zoneAnchor(p, L, W, "left").y).toBeCloseTo(21, 12); // facing east, left is north
    expect(zoneAnchor(p, L, W, "right").y).toBeCloseTo(19, 12);
    const c = zoneAnchor(p, L, W, "front-right");
    expect(c.x).toBeCloseTo(12, 12);
    expect(c.y).toBeCloseTo(19, 12);
  });

  it("finds crossings and distances", () => {
    const x = crossings([{ x: -5, y: 1 }, { x: 5, y: 1 }], [{ x: 2, y: -3 }, { x: 2, y: 3 }]);
    expect(x).toHaveLength(1);
    expect(x[0]!.x).toBeCloseTo(2, 12);
    expect(distToPolyline({ x: 0, y: 4 }, [{ x: -5, y: 1 }, { x: 5, y: 1 }])).toBeCloseTo(3, 12);
  });

  it("contactProblems reports a hand-built perfect T-bone as clean and a shifted one as not", () => {
    const A = dimsOf("car"), B = dimsOf("suv");
    const impactPointM = { x: 5, y: -2 };
    const scene = {
      vehicles: [{ id: "A", type: "car", zone: "left" }, { id: "B", type: "suv", zone: "front" }],
    } as unknown as Parameters<typeof contactProblems>[0];
    const good = {
      ok: true as const, impactPointM,
      vehicles: [
        { id: "A" as const, path: null, impactPose: pose(5 + A.W / 2, -2, 0) },
        { id: "B" as const, path: null, impactPose: pose(5 - B.L / 2, -2, Math.PI / 2) },
      ],
    };
    expect(contactProblems(scene, good, "A", "B")).toEqual([]);
    const bad = { ...good, vehicles: [good.vehicles[0]!, { ...good.vehicles[1]!, impactPose: pose(4, -2, Math.PI / 2) }] };
    expect(contactProblems(scene, bad, "A", "B").length).toBeGreaterThan(0);
  });
});

describe("road fixtures", () => {
  const nets: Array<[string, RoadNetwork]> = [
    ["intersection", intersectionNet()], ["intersection, split Main", intersectionNet({ splitMain: true })], ["one-way Park", intersectionNet({ parkOneWay: true })],
    ["highway", highwayNet()], ["parking lot", parkingLotNet()], ["lanes lab", lanesLabNet()],
  ];

  it("are well-formed: unique way ids, 2+ centerline points, counter-clockwise buildings, shared frame", () => {
    for (const [name, net] of nets) {
      const ids = net.ways.map((w) => w.id);
      expect(new Set(ids).size, name).toBe(ids.length);
      for (const w of net.ways) {
        expect(w.centerline.length, `${name}/${w.id}`).toBeGreaterThanOrEqual(2);
        if (w.oneway) expect(w.lanesBackward).toBe(0);
      }
      for (const b of net.buildings) {
        let area = 0;
        b.footprint.forEach((p, i) => { const q = b.footprint[(i + 1) % b.footprint.length]!; area += p.x * q.y - q.x * p.y; });
        expect(area, `${name}/${b.id}`).toBeGreaterThan(0);
      }
      expect(net.frame).toEqual(FRAME);
    }
  });

  it("keep buildings clear of the roads and the junction", () => {
    for (const [, net] of nets) {
      for (const b of net.buildings) {
        for (const w of net.ways) {
          const nearest = Math.min(...b.footprint.map((p) => distToPolyline(p, w.centerline)));
          if (w.id !== "hill") expect(nearest).toBeGreaterThan(10);
        }
      }
    }
  });

  it("have the lane geometry the placement tests assume", () => {
    expect(twoWayLaneOffsetM(1, LANE_W_M, 0)).toBe(LANE_W_M / 2);
    expect(twoWayLaneOffsetM(2, LANE_W_M, 0)).toBe(1.5 * LANE_W_M);
    expect(HWY_X_M).toBeLessThan(0);
    expect(PRESETS.car.length.value).toBeGreaterThan(4);
  });
});
