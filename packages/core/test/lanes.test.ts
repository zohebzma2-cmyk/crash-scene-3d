import { describe, expect, it } from "vitest";
import { lanePath } from "../src";
import type { LanePath, RoadNetwork, RoadWay } from "../src";
import { dot, fwdOf, polylineLength, rightOf, sub, toRad } from "./physics-helpers";
import { HWY_LANE_W_M, HWY_X_M, LANE_W_M, highwayNet, intersectionNet, lanesLabNet } from "./roads-fixtures";

/**
 * Independent oracle for the lane offset. Right-hand traffic; lane 0 is the RIGHTMOST lane
 * for its direction, so on a two-way road it is the lane FARTHEST from the centerline, and
 * the last lane (N - 1) is the leftmost, next to the centerline:
 *  - travelling with the centerline: (N - 1/2 - i) * w to the right of the line;
 *  - travelling against it: the same distance on the line's left, i.e. -(N - 1/2 - i) * w
 *    in "meters to the right of the centerline direction";
 *  - one-way: all N lanes share the full width, centred on the line: ((N - 1)/2 - i) * w.
 * For one lane per direction this is the plan's "(i + 1/2) * w" offset; for more lanes the
 * plan's formula and the contract's "0 = rightmost" disagree and this follows the contract
 * (reported to the lead as a decision).
 * Returned in "meters to the right of the centerline direction".
 */
function rightOfLineM(way: RoadWay, withLine: boolean, i: number): number {
  const w = way.laneWidthM;
  if (way.oneway) return ((way.lanesForward - 1) / 2 - i) * w;
  return withLine ? (way.lanesForward - 0.5 - i) * w : -(way.lanesBackward - 0.5 - i) * w;
}

/** Check a lane path along a straight way: lateral offset, travel order, coverage. */
function expectStraightLane(net: RoadNetwork, p: LanePath, wayId: string, travelBearingDeg: number, withLine: boolean, laneIndex: number): void {
  const way = net.ways.find((w) => w.id === wayId)!;
  const a = way.centerline[0]!, b = way.centerline[way.centerline.length - 1]!;
  const lineBearing = Math.atan2(b.x - a.x, b.y - a.y);
  const lineFwd = fwdOf(lineBearing), lineRight = rightOf(lineBearing);
  const lateral = rightOfLineM(way, withLine, laneIndex);
  expect(p.roadId).toBe(wayId);
  expect(p.laneIndex).toBe(laneIndex);
  expect(p.points.length).toBeGreaterThanOrEqual(2);
  const along = p.points.map((q) => dot(sub(q, a), lineFwd));
  for (const q of p.points) expect(dot(sub(q, a), lineRight)).toBeCloseTo(lateral, 6);
  // Travel order: increasing along the travel direction.
  const travel = fwdOf(toRad(travelBearingDeg));
  const sign = dot(travel, lineFwd) > 0 ? 1 : -1;
  for (let i = 1; i < along.length; i++) expect((along[i]! - along[i - 1]!) * sign).toBeGreaterThan(0);
  expect(polylineLength(p.points)).toBeGreaterThan(0.9 * polylineLength(way.centerline));
}

describe("lanePath: right-hand traffic", () => {
  const net = intersectionNet({ mainLanes: 2 });

  it("puts a northbound lane east of the centerline", () => {
    for (const i of [0, 1]) {
      const p = lanePath(net, "main", 0, i)!;
      expect(p).not.toBeNull();
      expectStraightLane(net, p, "main", 0, true, i);
      for (const q of p.points) expect(q.x).toBeCloseTo((2 - 0.5 - i) * LANE_W_M, 6);
    }
  });

  it("with one lane per direction, the lane centre is half a lane width east of the line (the plan's (i + 1/2) * w)", () => {
    const one = intersectionNet();
    for (const q of lanePath(one, "main", 0, 0)!.points) expect(q.x).toBeCloseTo(0.5 * LANE_W_M, 6);
    for (const q of lanePath(one, "main", 180, 0)!.points) expect(q.x).toBeCloseTo(-0.5 * LANE_W_M, 6);
  });

  it("puts a southbound lane west of the centerline, with points running south", () => {
    for (const i of [0, 1]) {
      const p = lanePath(net, "main", 180, i)!;
      expectStraightLane(net, p, "main", 180, false, i);
      for (const q of p.points) expect(q.x).toBeCloseTo(-(2 - 0.5 - i) * LANE_W_M, 6);
      expect(p.points[0]!.y).toBeGreaterThan(p.points[p.points.length - 1]!.y);
    }
  });

  it("numbers lanes from the right: laneIndex 0 is the rightmost, the highest index is next to the centerline", () => {
    const l0 = lanePath(net, "main", 0, 0)!, l1 = lanePath(net, "main", 0, 1)!;
    expect(l0.points[0]!.x).toBeGreaterThan(l1.points[0]!.x); // facing north, lane 1 is to the left (west) of lane 0
    expect(l1.points[0]!.x).toBeGreaterThan(0); // and still on the northbound side of the line
    const s0 = lanePath(net, "main", 180, 0)!, s1 = lanePath(net, "main", 180, 1)!;
    expect(s0.points[0]!.x).toBeLessThan(s1.points[0]!.x); // facing south, right is west
    expect(s1.points[0]!.x).toBeLessThan(0);
  });

  it("offsets an eastbound lane south of the line and a westbound lane north of it", () => {
    const e = lanePath(net, "park", 90, 0)!, w = lanePath(net, "park", 270, 0)!;
    expectStraightLane(net, e, "park", 90, true, 0);
    expectStraightLane(net, w, "park", 270, false, 0);
    expect(e.points[0]!.y).toBeCloseTo(-LANE_W_M / 2, 6);
    expect(w.points[0]!.y).toBeCloseTo(LANE_W_M / 2, 6);
    expect(e.points[0]!.x).toBeLessThan(e.points[e.points.length - 1]!.x);
    expect(w.points[0]!.x).toBeGreaterThan(w.points[w.points.length - 1]!.x);
  });

  it("accepts a bearing within 90 degrees of the road's direction (headings are never exact)", () => {
    const p = lanePath(net, "main", 12, 0)!;
    expect(p).not.toBeNull();
    expectStraightLane(net, p, "main", 0, true, 0);
    expect(lanePath(net, "main", 348, 0)).not.toBeNull();
    expect(lanePath(net, "main", 175, 0)!.points[0]!.x).toBeCloseTo(-1.5 * LANE_W_M, 6); // lane 0 of 2 southbound lanes: the western one
  });

  it("handles unequal lane counts: forward lanes right of the line, backward lanes left of it", () => {
    const lab = lanesLabNet();
    const n1 = lanePath(lab, "elm", 0, 1)!;
    expectStraightLane(lab, n1, "elm", 0, true, 1);
    expect(n1.points[0]!.x).toBeCloseTo(0.5 * 3.2, 6); // leftmost of two northbound lanes, next to the line
    const s0 = lanePath(lab, "elm", 180, 0)!;
    expectStraightLane(lab, s0, "elm", 180, false, 0);
    expect(s0.points[0]!.x).toBeCloseTo(-0.5 * 3.2, 6);
    expect(lanePath(lab, "elm", 180, 1)).toBeNull(); // only one southbound lane
    expect(lanePath(lab, "elm", 0, 2)).toBeNull(); // only two northbound lanes
  });

  it("offsets to the right of travel on diagonal roads too", () => {
    const lab = lanesLabNet();
    const p = lanePath(lab, "diag", 45, 0)!;
    expectStraightLane(lab, p, "diag", 45, true, 0);
    const first = p.points[0]!;
    const right = rightOf(toRad(45));
    expect(first.x).toBeCloseTo(200 + right.x * 1.75, 6);
    expect(first.y).toBeCloseTo(0 + right.y * 1.75, 6);
    const back = lanePath(lab, "diag", 225, 0)!;
    expectStraightLane(lab, back, "diag", 225, false, 0);
  });
});

describe("lanePath: one-way roads use the full width", () => {
  it("centres a one-way road's lanes on the line: lane 0 rightmost, lane 1 in the middle, lane 2 leftmost", () => {
    const net = highwayNet();
    const xs = [0, 1, 2].map((i) => {
      const p = lanePath(net, "hwy", 0, i)!;
      expectStraightLane(net, p, "hwy", 0, true, i);
      return p.points[0]!.x;
    });
    expect(xs[0]!).toBeCloseTo(HWY_X_M + HWY_LANE_W_M, 6); // rightmost = east side for northbound
    expect(xs[1]!).toBeCloseTo(HWY_X_M, 6);
    expect(xs[2]!).toBeCloseTo(HWY_X_M - HWY_LANE_W_M, 6);
  });

  it("puts a single lane of a one-way street on the centerline", () => {
    const net = intersectionNet({ parkOneWay: true });
    const p = lanePath(net, "park", 270, 0)!;
    expectStraightLane(net, p, "park", 270, true, 0);
    for (const q of p.points) expect(q.y).toBeCloseTo(0, 6);
    expect(p.points[0]!.x).toBeGreaterThan(p.points[p.points.length - 1]!.x); // westbound: points run west
  });

  it("returns null for the direction a one-way road forbids", () => {
    expect(lanePath(intersectionNet({ parkOneWay: true }), "park", 90, 0)).toBeNull();
    expect(lanePath(highwayNet(), "hwy", 180, 0)).toBeNull();
    expect(lanePath(highwayNet(), "hwy", 178, 1)).toBeNull();
  });
});

describe("lanePath: bad input", () => {
  it("returns null for an unknown road", () => {
    expect(lanePath(intersectionNet(), "nope", 0, 0)).toBeNull();
  });
  it("returns null for a lane the road doesn't have", () => {
    expect(lanePath(intersectionNet(), "main", 0, 1)).toBeNull();
    expect(lanePath(highwayNet(), "hwy", 0, 3)).toBeNull();
  });
});
