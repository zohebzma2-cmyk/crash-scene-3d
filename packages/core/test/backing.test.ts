// A backing vehicle travels opposite to the way it faces, and every part of the physics has to agree: the checks (checkScene),
// the placement (zones are relative to the way it FACES) and the closing test. The app once warned "head-on, from the front"
// for the backing van in the parking-lot example. The logic is right: that sentence appears when the van is entered facing
// the way the other car comes from. These tests pin down both.
import { describe, expect, it } from "vitest";
import { checkScene, placeVehicles, simulate } from "../src";
import type { RoadNetwork, Scene } from "../src";
import { readFileSync } from "node:fs";
import { angleDiffDeg, expectOk, known, sceneOf, veh } from "./physics-helpers";

const PIN = { x: 0, y: 0 };
const compass = (v: { x: number; y: number }) => ((Math.atan2(v.x, v.y) * 180) / Math.PI + 360) % 360;

/** B backs while facing `facing`, travelling `facing + 180`; its REAR hits A's side. A crosses its path. */
function backingScene(facing: number, aSide: "left" | "right", extra: { aMph?: number; bMph?: number } = {}): Scene {
  // B arrives from the direction it faces (it moves away from there... backing: it moves toward its rear, so B is on the `facing` side of the pin).
  // A's left side faces (bearing - 90), its right side faces (bearing + 90): turn A so that side faces `facing`.
  const aBearing = aSide === "left" ? (facing + 90) % 360 : (facing + 270) % 360;
  return sceneOf([
    veh("A", { type: "car", bearingDeg: aBearing, speed: known(extra.aMph ?? 8), zone: aSide }),
    veh("B", { type: "van", action: "backing", bearingDeg: facing, speed: known(extra.bMph ?? 3), zone: "rear" }),
  ], { place: "parking" });
}

describe("backing: every part agrees when the entry is consistent", () => {
  for (const facing of [0, 90, 180, 270]) for (const side of ["left", "right"] as const) {
    it(`facing ${facing}, rear into A's ${side} side: no checkScene message, placement and simulation work, the van's rear is what touches`, () => {
      const scene = backingScene(facing, side);
      expect(checkScene(scene, null)).toEqual([]);
      const placed = expectOk(placeVehicles(scene, null, PIN));
      const sim = expectOk(simulate(scene, null)).result;
      expect(sim.warnings).toEqual([]);
      // The van faces `facing` and moves the opposite way.
      const b = sim.vehicles.find((v) => v.id === "B")!;
      expect(angleDiffDeg((b.impactPose.headingRad * 180) / Math.PI, facing)).toBeLessThan(1e-6);
      const i0 = Math.round(-sim.startTimeS / sim.dtS);
      const move = { x: b.track[i0]!.xM - b.track[i0 - 60]!.xM, y: b.track[i0]!.yM - b.track[i0 - 60]!.yM };
      expect(angleDiffDeg(compass(move), (facing + 180) % 360)).toBeLessThan(1);
      // The zone that touched on the van is its rear.
      expect(b.impact!.leadingZone).toBe("rear");
      expect(b.impact!.zoneHit).toBe("rear");
      expect(placed.ok).toBe(true);
    });
  }

  it("the same crash with the van's direction entered as its TRAVEL direction (facing flipped) is flagged, not drawn as if fine", () => {
    const wrong = backingScene(180, "left"); // right: B faces 180. flip to 0.
    const flipped: Scene = { ...wrong, vehicles: wrong.vehicles.map((v) => (v.id === "B" ? { ...v, travel: { ...v.travel, bearingDeg: 0 } } : v)) };
    const messages = checkScene(flipped, null);
    const o = simulate(flipped, null);
    // Either the checks say it does not fit, or the placement refuses it. Never a silent clean run.
    const flagged = messages.length > 0 || !o.ok || o.result.warnings.length > 0;
    expect(flagged).toBe(true);
  });
});

describe("backing: the 'head-on, from the front' sentence", () => {
  // A drives east at 8 mph; the van, facing WEST, backs east at 3 mph, so A comes up from the direction the van faces: A meets its FRONT.
  const aEast = (zoneB: "front" | "rear", aBearing = 90) => sceneOf([
    veh("A", { type: "car", bearingDeg: aBearing, speed: known(8), zone: "front" }),
    veh("B", { type: "van", action: "backing", bearingDeg: 270, speed: known(3), zone: zoneB }),
  ], { place: "parking" });

  it("is true there: marked as hit on the front, nothing is flagged", () => {
    expect(checkScene(aEast("front"), null)).toEqual([]);
    expect(expectOk(simulate(aEast("front"), null)).result.warnings).toEqual([]);
  });

  it("marked as hit on the rear, the van is told A comes at it head-on from the front, and that it was backing up", () => {
    const msgs = checkScene(aEast("rear", 80), null).filter((m) => m.code === "zone-mismatch");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.text).toMatch(/head-on, from the front/);
    expect(msgs[0]!.text).toMatch(/Vehicle B was backing up, so its front is the way it was facing\./);
    expect(msgs[0]!.vehicleIds).toEqual(["B", "A"]);
  });

  it("both going east with the van marked hit on its rear: said as 'same direction' (the van's trailing side is its front), once", () => {
    const msgs = checkScene(aEast("rear"), null);
    expect(msgs.map((m) => m.code)).toEqual(["same-direction"]);
    expect(msgs[0]!.text).toMatch(/both going east/);
  });

  it("is not said about the van in the consistent crossing (van faces north and backs south into A's side)", () => {
    const scene = backingScene(0, "left");
    expect(checkScene(scene, null).map((m) => m.text).join(" ")).not.toMatch(/head-on/);
  });

  it("is not said for a van that is NOT backing, facing the same way", () => {
    const forward: Scene = { ...aEast("rear"), vehicles: aEast("rear").vehicles.map((v) => (v.id === "B" ? { ...v, action: "straight" as const } : v)) };
    const m = checkScene(forward, null).find((x) => x.code === "zone-mismatch");
    // facing west and driving west, A (faster, east-bound) approaches head-on from the front: also from the front, but no backing note
    if (m) expect(m.text).not.toMatch(/was backing up/);
  });
});

describe("backing: the parking-lot example on its real map", () => {
  const load = (f: string) => JSON.parse(readFileSync(new URL(`./data/${f}`, import.meta.url), "utf8")) as RoadNetwork;
  const example = () => {
    const r = JSON.parse(readFileSync(new URL("../../../examples/parking-lot-backing/scene.json", import.meta.url), "utf8")) as unknown;
    return r as Scene;
  };

  it("has no 'head-on' sentence and no warning: the van backs across the aisle with its rear toward A", () => {
    for (const f of ["parking-lot-backing-roads.json", "parking-lot-backing-roads-center-frame.json"]) {
      const roads = load(f);
      const scene = example();
      expect(checkScene(scene, roads)).toEqual([]);
      const sim = expectOk(simulate(scene, roads)).result;
      expect(sim.warnings).toEqual([]);
      const b = sim.vehicles.find((v) => v.id === "B")!;
      expect(b.impact!.leadingZone).toBe(scene.vehicles.find((v) => v.id === "B")!.zone);
    }
  });

  it("the van's entered facing is the way it points (heading), and it moves the opposite way", () => {
    const scene = example();
    const sim = expectOk(simulate(scene, load("parking-lot-backing-roads.json"))).result;
    const bScene = scene.vehicles.find((v) => v.id === "B")!;
    const b = sim.vehicles.find((v) => v.id === "B")!;
    expect(bScene.action).toBe("backing");
    expect(angleDiffDeg((b.impactPose.headingRad * 180) / Math.PI, bScene.travel.bearingDeg)).toBeLessThan(1);
    const i0 = Math.round(-sim.startTimeS / sim.dtS);
    const move = { x: b.track[i0]!.xM - b.track[i0 - 30]!.xM, y: b.track[i0]!.yM - b.track[i0 - 30]!.yM };
    expect(angleDiffDeg(compass(move), (bScene.travel.bearingDeg + 180) % 360)).toBeLessThan(5);
  });
});
