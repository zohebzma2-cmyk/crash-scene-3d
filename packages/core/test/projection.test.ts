import { describe, expect, it } from "vitest";
import { toLatLon, toLocal } from "../src";
import type { LocalFrame } from "../src";
import { FRAME, ORIGIN } from "./roads-fixtures";

const KM_PER_DEG = 111.32;
const frameAt = (lat: number, lon: number): LocalFrame => ({ origin: { lat, lon } });

describe("projection: WGS84 <-> local East-North meters", () => {
  it("puts the origin at (0, 0)", () => {
    const v = toLocal(FRAME, ORIGIN);
    expect(v.x).toBeCloseTo(0, 9);
    expect(v.y).toBeCloseTo(0, 9);
  });

  it("round-trips local -> lat/lon -> local within 1 cm anywhere inside 500 m", () => {
    for (const frame of [FRAME, frameAt(-33.8688, 151.2093), frameAt(60.17, 24.94)]) {
      for (const x of [-500, -250, 0, 250, 500]) {
        for (const y of [-500, -250, 0, 250, 500]) {
          if (Math.hypot(x, y) > 500) continue;
          const back = toLocal(frame, toLatLon(frame, { x, y }));
          expect(Math.abs(back.x - x)).toBeLessThan(0.01);
          expect(Math.abs(back.y - y)).toBeLessThan(0.01);
        }
      }
    }
  });

  it("round-trips lat/lon -> local -> lat/lon within 1 cm (about 1e-7 degrees)", () => {
    const pts = [{ lat: ORIGIN.lat + 0.004, lon: ORIGIN.lon - 0.003 }, { lat: ORIGIN.lat - 0.0045, lon: ORIGIN.lon + 0.002 }];
    for (const p of pts) {
      const back = toLatLon(FRAME, toLocal(FRAME, p));
      expect(Math.abs(back.lat - p.lat)).toBeLessThan(1e-7);
      expect(Math.abs(back.lon - p.lon)).toBeLessThan(1e-7);
    }
  });

  it("is east-positive in x and north-positive in y", () => {
    expect(toLocal(FRAME, { lat: ORIGIN.lat, lon: ORIGIN.lon + 0.001 }).x).toBeGreaterThan(0);
    expect(toLocal(FRAME, { lat: ORIGIN.lat, lon: ORIGIN.lon - 0.001 }).x).toBeLessThan(0);
    expect(toLocal(FRAME, { lat: ORIGIN.lat + 0.001, lon: ORIGIN.lon }).y).toBeGreaterThan(0);
    expect(toLocal(FRAME, { lat: ORIGIN.lat - 0.001, lon: ORIGIN.lon }).y).toBeLessThan(0);
  });

  it("is about 111.32 km per degree of latitude (within 0.5%) at mid latitudes", () => {
    for (const lat of [30, ORIGIN.lat, 45, 60]) {
      const north = toLocal(frameAt(lat, -71), { lat: lat + 0.001, lon: -71 });
      expect(north.y).toBeGreaterThan(KM_PER_DEG * 1000 * 0.001 * 0.995);
      expect(north.y).toBeLessThan(KM_PER_DEG * 1000 * 0.001 * 1.005);
      expect(Math.abs(north.x)).toBeLessThan(1e-6);
    }
  });

  it("shrinks east-west distances with cos(latitude), within 0.5%", () => {
    const xs = [0, 30, ORIGIN.lat, 60].map((lat) => {
      const x = toLocal(frameAt(lat, -71), { lat, lon: -71 + 0.001 }).x;
      expect(x).toBeGreaterThan(KM_PER_DEG * 1000 * 0.001 * Math.cos((lat * Math.PI) / 180) * 0.995);
      expect(x).toBeLessThan(KM_PER_DEG * 1000 * 0.001 * Math.cos((lat * Math.PI) / 180) * 1.005);
      return x;
    });
    expect(xs[0]!).toBeGreaterThan(xs[1]!);
    expect(xs[1]!).toBeGreaterThan(xs[2]!);
    expect(xs[2]!).toBeGreaterThan(xs[3]!);
    expect(xs[3]! / xs[0]!).toBeCloseTo(0.5, 2);
  });

  it("is the same formula as mapdata's (equirectangular about the origin, WGS84 series): pinned numbers for one known point", () => {
    // 0.0016 deg north and 0.0024 deg east of a Nashua origin: roughly 265 m north-east.
    const frame = frameAt(42.7627323, -71.4661324);
    const v = toLocal(frame, { lat: 42.7627323 + 0.0016, lon: -71.4661324 + 0.0024 });
    expect(v.x).toBeCloseTo(196.449563, 4);
    expect(v.y).toBeCloseTo(177.740936, 4);
    const back = toLatLon(frame, v);
    expect(back.lat).toBeCloseTo(42.7627323 + 0.0016, 12);
    expect(back.lon).toBeCloseTo(-71.4661324 + 0.0024, 12);
    // And the length of a degree at that latitude, as the series gives it.
    expect(toLocal(frame, { lat: 42.7627323 + 1, lon: -71.4661324 }).y).toBeCloseTo(111088.0849, 2);
    expect(toLocal(frame, { lat: 42.7627323, lon: -71.4661324 + 1 }).x).toBeCloseTo(81853.9845, 2);
  });
});
