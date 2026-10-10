import { describe, expect, it } from "vitest";
import { compassRotationDeg, northUpSpin, screenUpHeading, spunOffset, wrapAngle, MIN_ORBIT_RADIUS_M } from "../../src/viewer/math";

const deg = (d: number) => (d * Math.PI) / 180;
/** Camera at azimuth θ (0 = due south of the target) looking at the target from `elev`: its screen-up axis and forward axis, in three's frame. */
function axes(theta: number, elev: number) {
  const f: [number, number, number] = [-Math.sin(theta) * Math.cos(elev), -Math.sin(elev), -Math.cos(theta) * Math.cos(elev)];
  const hl = Math.hypot(f[0], f[2]);
  const up: [number, number, number] = [(f[0] * Math.sin(elev)) / hl, Math.cos(elev), (f[2] * Math.sin(elev)) / hl];
  return { up, f };
}

describe("screen-up heading", () => {
  it("is 0 looking north, 90° looking east, 180° south, 270° west (north is three's −z)", () => {
    expect(screenUpHeading(0, -1, 0, -1)).toBeCloseTo(0);
    expect(screenUpHeading(1, 0, 1, 0)).toBeCloseTo(deg(90));
    expect(Math.abs(screenUpHeading(0, 1, 0, 1))).toBeCloseTo(deg(180));
    expect(screenUpHeading(-1, 0, -1, 0)).toBeCloseTo(deg(-90));
  });
  it("follows the camera azimuth at any elevation: standing south of the target (θ = 0) looks north", () => {
    for (const elev of [deg(25), deg(50), deg(80)]) {
      const n = axes(0, elev);
      expect(screenUpHeading(n.up[0], n.up[2], n.f[0], n.f[2])).toBeCloseTo(0, 6);
      // standing west of the target (θ = −90°) looks east
      const e = axes(deg(-90), elev);
      expect(screenUpHeading(e.up[0], e.up[2], e.f[0], e.f[2])).toBeCloseTo(deg(90), 6);
    }
  });
  it("looking straight down uses the roll (screen-up); with no roll at all it falls back to the forward axis", () => {
    expect(screenUpHeading(0, -1, 0, 0)).toBeCloseTo(0);            // top view, north up
    expect(screenUpHeading(1e-6, 0, 0, -1)).toBeCloseTo(0);         // up has no ground part: forward says north
  });
});

describe("compass arrow turn", () => {
  it("points the arrow at north: the picture turned to look east puts north on the left (−90°)", () => {
    expect(compassRotationDeg(0)).toBeCloseTo(0);
    expect(compassRotationDeg(deg(90))).toBeCloseTo(-90);
    expect(compassRotationDeg(deg(-90))).toBeCloseTo(90);
    expect(Math.abs(compassRotationDeg(deg(180)))).toBeCloseTo(180);
  });
  it("stays within (−180, 180]", () => {
    for (let d = -720; d <= 720; d += 37) {
      const r = compassRotationDeg(deg(d));
      expect(r).toBeGreaterThan(-180 - 1e-9);
      expect(r).toBeLessThanOrEqual(180 + 1e-9);
    }
  });
});

describe("reset to north up", () => {
  it("wraps angles the short way", () => {
    expect(wrapAngle(deg(190))).toBeCloseTo(deg(-170));
    expect(wrapAngle(deg(-190))).toBeCloseTo(deg(170));
    expect(wrapAngle(0)).toBe(0);
  });
  it("ends due south of the target (looking north), keeping the distance and the height", () => {
    const off: [number, number, number] = [30, 22, -40];
    const s = northUpSpin(...off);
    const end = spunOffset(s, 1, [0, 0, 0]);
    expect(end[0]).toBeCloseTo(0, 9);
    expect(end[2]).toBeCloseTo(Math.hypot(30, 40), 9);
    expect(end[1]).toBe(22);
    expect(Math.hypot(end[0], end[2])).toBeCloseTo(Math.hypot(off[0], off[2]), 9);
  });
  it("starts where the camera is, and every step along the way keeps the distance", () => {
    const off: [number, number, number] = [-12, 9, 25];
    const s = northUpSpin(...off);
    const start = spunOffset(s, 0, [0, 0, 0]);
    expect(start[0]).toBeCloseTo(off[0], 9);
    expect(start[2]).toBeCloseTo(off[2], 9);
    for (let k = 0; k <= 1; k += 0.1) {
      const p = spunOffset(s, k, [0, 0, 0]);
      expect(Math.hypot(p[0], p[2])).toBeCloseTo(Math.hypot(off[0], off[2]), 9);
    }
  });
  it("turns the shorter way round (never more than a half turn), and not at all when already north up", () => {
    for (let a = -170; a <= 170; a += 20) {
      const s = northUpSpin(Math.sin(deg(a)) * 10, 5, Math.cos(deg(a)) * 10);
      expect(Math.abs(s.delta)).toBeLessThanOrEqual(Math.PI + 1e-9);
      expect(Math.abs(s.delta)).toBeCloseTo(Math.abs(deg(a)), 9);
    }
    expect(Math.abs(northUpSpin(0, 5, 10).delta)).toBeLessThan(1e-12);
  });
  it("the Top view's camera (straight above, a hair south) keeps a defined azimuth and a tiny radius", () => {
    const s = northUpSpin(0, 400, MIN_ORBIT_RADIUS_M);
    expect(s.radius).toBeCloseTo(MIN_ORBIT_RADIUS_M);
    // turned to the east by the user: still resets to the same tiny radius, north up
    const turned = northUpSpin(MIN_ORBIT_RADIUS_M, 400, 0);
    const end = spunOffset(turned, 1, [0, 0, 0]);
    expect(end[0]).toBeCloseTo(0, 9);
    expect(end[2]).toBeCloseTo(MIN_ORBIT_RADIUS_M, 9);
  });
  it("writes into the array it is given (no allocation per frame)", () => {
    const out: [number, number, number] = [0, 0, 0];
    expect(spunOffset(northUpSpin(3, 4, 5), 0.5, out)).toBe(out);
  });
});
