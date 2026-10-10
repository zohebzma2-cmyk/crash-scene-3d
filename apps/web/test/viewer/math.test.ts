import { describe, expect, it } from "vitest";
import { toThree, headingToYaw, heightAt, cameraFor, framingBounds } from "../../src/viewer/math";
import type { SimulationResult, TerrainGrid, VehicleResult } from "@csd/core";

const pose = (x: number, y: number, h = 0) => ({ xM: x, yM: y, headingRad: h, speedMps: 0 });
const veh = (id: "A" | "B", x: number, y: number): VehicleResult => ({
  id, type: "car", massKg: 1600, lengthM: 4.8, widthM: 1.85, inertiaKgM2: 3000, path: null,
  speedAtImpactMps: { lo: 10, mid: 10, hi: 10 }, approachDistanceM: { lo: 20, mid: 20, hi: 20 }, postImpactDistanceM: { lo: 3, mid: 3, hi: 3 },
  impactPose: pose(x, y), restPose: pose(x + 3, y + 1), track: [pose(x, y - 20), pose(x, y)],
});
const sim = { startTimeS: -0.5, dtS: 0.5, impactPointM: { x: 0, y: 0 }, vehicles: [veh("A", 0, -2), veh("B", -3, 0)] } as unknown as SimulationResult;

describe("viewer coordinate boundary", () => {
  it("maps east/north to three's x and −z, height to y", () => {
    expect(toThree({ x: 3, y: 5 }, 2)).toEqual([3, 2, -5]);
  });
  it("turns compass headings (clockwise) into three yaw (counter-clockwise)", () => {
    expect(headingToYaw(Math.PI / 2)).toBeCloseTo(-Math.PI / 2);
    // a model facing −z rotated by yaw(east) must face +x
    const yaw = headingToYaw(Math.PI / 2);
    const fwd = { x: -Math.sin(yaw), z: -Math.cos(yaw) };
    expect(fwd.x).toBeCloseTo(1); expect(fwd.z).toBeCloseTo(0);
  });
});

describe("terrain sampling", () => {
  const t: TerrainGrid = { originM: { x: -10, y: -10 }, cellM: 10, cols: 3, rows: 3, heightsM: [0, 0, 0, 0, 4, 0, 0, 0, 0], source: "test" };
  it("is bilinear inside the grid and 0 outside", () => {
    expect(heightAt(t, { x: 0, y: 0 })).toBeCloseTo(4);
    expect(heightAt(t, { x: 5, y: 0 })).toBeCloseTo(2);
    expect(heightAt(t, { x: 500, y: 0 })).toBe(0);
    expect(heightAt(null, { x: 0, y: 0 })).toBe(0);
  });
});

describe("camera presets", () => {
  it("top looks straight down over the framed area", () => {
    const c = cameraFor("top", sim, () => null, { w: 1440, h: 810 }, null);
    expect(c.kind).toBe("orthographic");
    expect(c.position[1]).toBeGreaterThan(17);
    expect(c.position[0]).toBeCloseTo(c.target[0]);
  });
  it("wide frames the approach too", () => {
    const b = framingBounds(sim, true), n = framingBounds(sim, false);
    expect(b.minY).toBeLessThan(n.minY);
  });
  it("wide frames only the last 2 s of a long 5 s approach, capped at 25 m back, not where the vehicle started", () => {
    // 25 m/s for 5 s at dt 0.5: track from y = −125 (t = −5) to y = 0 (t = 0).
    const track = Array.from({ length: 11 }, (_, k) => pose(0, -125 + k * 12.5));
    const long = { ...sim, startTimeS: -5, dtS: 0.5, vehicles: [{ ...veh("A", 0, 0), track }, veh("B", -3, 0)] } as unknown as SimulationResult;
    const b = framingBounds(long, true);
    expect(b.minY).toBeLessThan(-25);      // includes the approach, 25 m back (plus the car and the 6 m margin) …
    expect(b.minY).toBeGreaterThan(-45);   // … but not t = −2 at −50 m, and not the start of the window at −125 m
  });
  it("driver view sits behind the vehicle along its heading", () => {
    const c = cameraFor("driver-a", sim, () => pose(0, 0, 0), { w: 800, h: 800 }, null);
    expect(c.position[2]).toBeGreaterThan(0); // behind a north-facing car = south = +z
    expect(c.target[2]).toBeLessThan(0);
  });
});
