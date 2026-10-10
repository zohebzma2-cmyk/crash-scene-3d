// A warning never blocks (DESIGN section 18). When checkScene only warns that the marked zone does not fit, placeVehicles and
// simulate still draw a picture, using the nearest zone that does touch, and say which zone they used.
// (The e2e flow "See it anyway" used to end in "We can't draw this yet" on the app's default claim.)
import { describe, expect, it } from "vitest";
import { checkScene, placeVehicles, simulate } from "../src";
import type { SceneVehicle, VehicleType, Zone } from "../src";
import { placeDetailed } from "../src/physics/placement";
import { MAIN, PARK, cornersOf, expectOk, known, overlapDepth, sceneOf, veh } from "./physics-helpers";
import { intersectionNet } from "./roads-fixtures";

const ZONES: Zone[] = ["front", "front-right", "right", "rear-right", "rear", "rear-left", "left", "front-left"];
const PIN = { x: 0, y: 0 };

describe("the app's default claim: A northbound on Main (marked hit on the left), B westbound on Park", () => {
  const scene = () => sceneOf([
    veh("A", { type: "car", bearingDeg: 0, ...MAIN, speed: known(25), zone: "left" }),
    veh("B", { type: "suv", bearingDeg: 270, ...PARK, speed: known(25), zone: "front" }),
  ]);

  for (const [label, net] of [["flat", null], ["with roads", intersectionNet()]] as const) {
    it(`${label}: checkScene only warns, and placeVehicles and simulate both draw it`, () => {
      const msgs = checkScene(scene(), net);
      expect(msgs.map((m) => m.code)).toEqual(["zone-mismatch"]);
      expect(placeVehicles(scene(), net, PIN).ok).toBe(true);
      const sim = expectOk(simulate(scene(), net)).result;
      expect(sim.vehicles).toHaveLength(2);
    });

    it(`${label}: the picture uses the right side of A (the face B actually meets), says so, and records it in the impact data`, () => {
      const sim = expectOk(simulate(scene(), net)).result;
      const w = sim.warnings.filter((x) => x.code === "zone-used");
      expect(w).toHaveLength(1);
      expect(w[0]!.vehicleIds).toEqual(["A"]);
      expect(w[0]!.text).toMatch(/is marked hit on the left side, but that did not fit with the way each vehicle was going, so the picture uses the right side instead\./);
      const a = sim.vehicles.find((v) => v.id === "A")!, b = sim.vehicles.find((v) => v.id === "B")!;
      expect(a.impact!.zoneHit).toBe("left"); // what was entered
      expect(a.impact!.leadingZone).toBe("right"); // what touched
      expect(b.impact!.zoneHit).toBe("front");
      expect(b.impact!.leadingZone).toBe("front");
      const d = overlapDepth(cornersOf(a.impactPose, a.lengthM, a.widthM), cornersOf(b.impactPose, b.lengthM, b.widthM));
      expect(d).toBeLessThanOrEqual(0.005);
      expect(d).toBeGreaterThanOrEqual(-0.02);
    });
  }

  it("the strict placement the checks use (exactZones) still refuses these zones, and says why", () => {
    const r = placeDetailed(scene(), intersectionNet(), PIN, { exactZones: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.code).toBe("zones-cannot-touch");
  });

  it("a scene whose zones fit is unchanged: no zone-used warning", () => {
    const fits = sceneOf([
      veh("A", { type: "car", bearingDeg: 0, ...MAIN, speed: known(25), zone: "right" }),
      veh("B", { type: "suv", bearingDeg: 270, ...PARK, speed: known(25), zone: "front" }),
    ]);
    expect(checkScene(fits, intersectionNet())).toEqual([]);
    expect(expectOk(simulate(fits, intersectionNet())).result.warnings.filter((x) => x.code === "zone-used")).toEqual([]);
  });
});

describe("a vehicle backed off into a third one: another zone often places them clear", () => {
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("in seeded 3 and 4 vehicle scenes, bodies-overlap is a refusal only when the strict placement overlaps AND no other zone fixes it", () => {
    const rnd = mulberry32(7);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const TYPES: VehicleType[] = ["car", "suv", "pickup", "van", "truck", "motorcycle"];
    let drawnAfterOverlap = 0, refused = 0;
    for (let i = 0; i < 1500; i++) {
      const n = pick([3, 4]);
      const vs: SceneVehicle[] = ["A", "B", "C", "D"].slice(0, n).map((id) => veh(id as "A", {
        type: pick(TYPES), bearingDeg: pick([0, 45, 90, 135, 180, 225, 270, 315, 80, 100, 10]), speed: known(10 + Math.floor(rnd() * 40)), zone: pick(ZONES),
      }));
      const scene = sceneOf(vs);
      const strict = placeDetailed(scene, null, PIN, { exactZones: true });
      const o = simulate(scene, null);
      const strictOverlap = !strict.ok && strict.errors.some((e) => e.code === "bodies-overlap");
      if (strictOverlap && o.ok) {
        drawnAfterOverlap++;
        expect(o.result.warnings.some((w) => w.code === "zone-used")).toBe(true); // drawn with a different zone, and says so
      }
      if (!o.ok && o.errors.some((e) => e.code === "bodies-overlap")) {
        refused++;
        expect(strictOverlap).toBe(true);
      }
    }
    expect(drawnAfterOverlap).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
  }, 60000);
});

describe("what still refuses", () => {
  it("a new vehicle backed off to touch its partner into a third one: an honest 'inside each other' refusal, no zone swap", () => {
    const o = simulate(sceneOf([
      veh("A", { type: "pickup", bearingDeg: 80, speed: known(34), zone: "front-right" }),
      veh("B", { type: "truck", bearingDeg: 135, speed: known(40), zone: "rear-right" }),
      veh("C", { type: "van", bearingDeg: 315, speed: known(49), zone: "rear-left" }),
      veh("D", { type: "suv", bearingDeg: 180, speed: known(23), zone: "front-right" }),
    ]), null);
    expect(o.ok).toBe(false);
    if (!o.ok) {
      expect(o.errors.map((e) => e.code)).toContain("bodies-overlap");
      expect(o.errors.map((e) => e.code)).not.toContain("zones-cannot-touch");
    }
  });

  it("a pin with no road near it", () => {
    const o = simulate(sceneOf([
      veh("A", { type: "car", bearingDeg: 0, speed: known(25), zone: "left" }),
      veh("B", { type: "suv", bearingDeg: 90, speed: known(25), zone: "front" }),
    ]), { ...intersectionNet(), ways: [], parking: [] });
    expect(o.ok).toBe(false);
  });

  it("vehicles that can never meet: same direction, same speed, nothing closing at any zone", () => {
    const o = simulate(sceneOf([
      veh("A", { type: "car", bearingDeg: 0, speed: known(25), zone: "rear" }),
      veh("B", { type: "car", bearingDeg: 0, speed: known(25), zone: "front" }),
    ]), null);
    expect(o.ok).toBe(false);
  });
});

describe("every scene that checkScene only warns about can be drawn (grid over zones, directions and actions)", () => {
  // Refusals that remain are about the speeds and directions, not the zones: vehicles moving apart, not moving toward each other, passing
  // through each other or through a building. They name the cause in plain words. A zone problem ("zones-cannot-touch") is never one of them.
  const PHYSICS_REFUSALS = new Set(["moving-apart", "not-moving-toward", "too-slow", "passes-through", "on-building", "no-workable-speed", "nothing-moving", "cannot-meet", "off-road"]);

  it("never refuses with zones-cannot-touch, and every refusal is one of the physics causes", () => {
    let warnedOnly = 0, drawn = 0, usedZone = 0;
    const refusals = new Map<string, number>();
    for (const net of [null, intersectionNet()] as const) {
      for (const [ba, bb] of [[0, 90], [0, 270], [0, 180], [0, 45], [90, 270]] as const) for (const za of ZONES) for (const zb of ZONES) {
        for (const act of ["straight", "backing", "turn-left", "turn-right"] as const) for (const [sa, sb] of [[30, 20]] as const) {
          const a: SceneVehicle = veh("A", { type: "car", bearingDeg: ba, speed: known(sa), zone: za, ...(net ? MAIN : {}) });
          const b: SceneVehicle = veh("B", { type: "suv", action: act, bearingDeg: bb, speed: known(sb), zone: zb, ...(net ? PARK : {}) });
          const scene = sceneOf([a, b]);
          const msgs = checkScene(scene, net);
          if (!msgs.every((m) => m.code === "zone-mismatch" || m.code === "same-direction")) continue;
          warnedOnly++;
          const o = simulate(scene, net);
          if (o.ok) {
            drawn++;
            expect(placeVehicles(scene, net, PIN).ok, "placeVehicles agrees with simulate").toBe(true);
            for (const w of o.result.warnings.filter((x) => x.code === "zone-used")) {
              usedZone++;
              const u = o.result.vehicles.find((v) => v.id === w.vehicleIds[0])!;
              expect(u.impact!.zoneHit).toBe(scene.vehicles.find((v) => v.id === u.id)!.zone); // the entered zone is kept
              expect(w.text).toContain("so the picture uses the");
            }
          } else {
            for (const e of o.errors) {
              refusals.set(e.code, (refusals.get(e.code) ?? 0) + 1);
              expect(e.code, `${net ? "roads" : "flat"} A ${ba} ${za}; B ${act} ${bb} ${zb}: ${e.text}`).not.toBe("zones-cannot-touch");
              expect(PHYSICS_REFUSALS.has(e.code), e.code).toBe(true);
            }
          }
        }
      }
    }
    expect(warnedOnly).toBeGreaterThan(2000);
    expect(drawn).toBeGreaterThan(800);
    expect(usedZone).toBeGreaterThan(200);
  }, 120000);
});
