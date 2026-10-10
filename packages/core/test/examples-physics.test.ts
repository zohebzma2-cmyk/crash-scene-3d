// The three example scenes are only used here to check that they parse and that the
// entered bearings make sense. No map parsing (that is the mapdata package's job).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { MPH_TO_MPS, PRESETS, checkScene, parseScene, simulate } from "../src";
import type { RoadNetwork, Scene } from "../src";
import { angleDiffDeg } from "./physics-helpers";

const load = (name: string): Scene => {
  const r = parseScene(JSON.parse(readFileSync(new URL(`../../../examples/${name}/scene.json`, import.meta.url), "utf8")));
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.value;
};
const bearing = (s: Scene, id: string) => s.vehicles.find((v) => v.id === id)!.travel.bearingDeg;

describe("example scenes: vehicles and bearings make sense for the physics", () => {
  it("t-bone-intersection: Main St northbound and Park St one-way westbound meet at about 90 degrees", () => {
    const s = load("t-bone-intersection");
    expect(angleDiffDeg(bearing(s, "A"), 0)).toBeLessThan(30);
    expect(angleDiffDeg(bearing(s, "B"), 270)).toBeLessThan(30);
    expect(Math.abs(angleDiffDeg(bearing(s, "A"), bearing(s, "B")) - 90)).toBeLessThan(25);
    expect(s.vehicles.every((v) => v.action === "straight")).toBe(true);
  });

  it("highway-rear-end: both go the same way in the same lane, with the leader hit in the rear", () => {
    const s = load("highway-rear-end");
    expect(angleDiffDeg(bearing(s, "A"), bearing(s, "B"))).toBeLessThan(5);
    expect(angleDiffDeg(bearing(s, "A"), 0)).toBeLessThan(10);
    const [a, b] = s.vehicles;
    expect(a!.travel.lane).toBe(b!.travel.lane);
    expect(a!.zone).toBe("rear");
    expect(b!.zone).toBe("front");
    expect(a!.speed.kind === "known" && b!.speed.kind === "known" && b!.speed.mph > a!.speed.mph).toBe(true);
  });

  it("parking-lot-backing: A drives along the aisle, B backs out facing across it", () => {
    const s = load("parking-lot-backing");
    const b = s.vehicles.find((v) => v.id === "B")!;
    expect(b.action).toBe("backing");
    expect(Math.abs(angleDiffDeg(bearing(s, "A"), bearing(s, "B")) - 90)).toBeLessThan(15);
    expect(s.location.place).toBe("parking");
  });

  it("every vehicle's class has a preset the physics can use", () => {
    for (const name of ["t-bone-intersection", "highway-rear-end", "parking-lot-backing"]) {
      for (const v of load(name).vehicles) {
        expect(PRESETS[v.type].mass.value).toBeGreaterThan(0);
        expect(v.travel.bearingDeg).toBeGreaterThanOrEqual(0);
        expect(v.travel.bearingDeg).toBeLessThan(360);
      }
    }
  });

  it("every example fits together: no checkScene messages, and the simulation runs with no warnings", () => {
    for (const name of ["t-bone-intersection", "highway-rear-end", "parking-lot-backing"]) {
      const scene = load(name);
      expect(checkScene(scene, null), name).toEqual([]);
      const r = simulate(scene, null);
      expect(r.ok, name).toBe(true);
      if (r.ok) {
        expect(r.result.warnings, name).toEqual([]);
        expect(r.result.vehicles.length).toBe(scene.vehicles.length);
      }
    }
  });

  // Mapdata's parse of each example's cached Overpass JSON (small RoadNetwork files in test/data). Zero messages and zero
  // warnings on the REAL map data, not just the flat template. The frame is centred on the scene's location; the parking lot
  // is also checked with the frame centred on the cached query centre (24 m off for that example), so a pin that doesn't
  // sit at the frame's origin is covered too.
  const REAL: Array<[string, string]> = [
    ["t-bone-intersection", "t-bone-intersection-roads.json"],
    ["highway-rear-end", "highway-rear-end-roads.json"],
    ["parking-lot-backing", "parking-lot-backing-roads.json"],
    ["parking-lot-backing", "parking-lot-backing-roads-center-frame.json"],
  ];
  for (const [name, file] of REAL) {
    it(`${name} on its real map (${file}) has no checkScene messages and no warnings`, () => {
      const real = JSON.parse(readFileSync(new URL(`./data/${file}`, import.meta.url), "utf8")) as RoadNetwork;
      const scene = load(name);
      expect(checkScene(scene, real)).toEqual([]);
      const r = simulate(scene, real);
      expect(r.ok, name).toBe(true);
      if (r.ok) {
        expect(r.result.warnings, name).toEqual([]);
        expect(r.result.vehicles).toHaveLength(scene.vehicles.length);
      }
    });
  }

  it("the parking-lot example's pin sits well inside the aisle A drives along: the approach has a street behind it", () => {
    const real = JSON.parse(readFileSync(new URL("./data/parking-lot-backing-roads.json", import.meta.url), "utf8")) as RoadNetwork;
    const r = simulate(load("parking-lot-backing"), real);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const a = r.result.vehicles.find((v) => v.id === "A")!;
      expect(a.path!.roadId).toMatch(/^w\d+$/); // a real way, not the free-line stand-in
      expect(r.result.warnings.map((w) => w.code)).not.toContain("path-past-street-end");
    }
  });

  it("highway-rear-end reads right under 'typed speed = speed at impact': 15 mph and 45 mph, braking, wet, B under 60 mph five seconds before", () => {
    const scene = load("highway-rear-end");
    const [a, b] = scene.vehicles;
    expect(a!.speed).toEqual({ kind: "known", mph: 15 });
    expect(b!.speed).toEqual({ kind: "known", mph: 45 });
    expect(a!.braking && b!.braking).toBe(true);
    expect(scene.road.condition).toBe("wet");
    const r = simulate(scene, null);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const bv = r.result.vehicles.find((v) => v.id === "B")!;
      expect(bv.track[0]!.speedMps / MPH_TO_MPS).toBeLessThan(60);
      expect(bv.track[0]!.speedMps / MPH_TO_MPS).toBeGreaterThan(45);
    }
  });
});
