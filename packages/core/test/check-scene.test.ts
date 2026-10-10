// checkScene: DESIGN.md section 18, in plain words. Codes are part of what these tests pin down:
//   nothing-moving, same-direction, zone-mismatch, cannot-meet.
// A vehicle's approach is the relative motion of another vehicle (backing travels opposite to its facing);
// a hit "faces" a zone when the approach comes from within one zone of it. Any of the low, middle and high
// speed cases may explain a hit.
import { describe, expect, it } from "vitest";
import { checkScene } from "../src";
import type { Scene } from "../src";
import { MAIN, PARK, known, sceneOf, tBoneScene, unsure, veh } from "./physics-helpers";
import { intersectionNet } from "./roads-fixtures";

const codes = (s: Scene, net = null as Parameters<typeof checkScene>[1]) => checkScene(s, net).map((m) => m.code);

describe("checkScene: scenes that fit", () => {
  it("accepts a T-bone where B hits A's left side from the west, with or without road data", () => {
    expect(checkScene(tBoneScene(), null)).toEqual([]);
    expect(checkScene(tBoneScene(), intersectionNet({ mainLanes: 2 }))).toEqual([]);
  });

  it("accepts B hitting A's right side from the east", () => {
    const s = sceneOf([
      veh("A", { bearingDeg: 0, ...MAIN, zone: "right" }),
      veh("B", { bearingDeg: 270, ...PARK, zone: "front" }),
    ]);
    expect(checkScene(s, null)).toEqual([]);
  });

  it("accepts a rear-end: the faster follower hits the leader's rear", () => {
    const s = sceneOf([
      veh("A", { bearingDeg: 0, speed: known(30), zone: "rear" }),
      veh("B", { bearingDeg: 0, speed: known(40), zone: "front" }),
    ]);
    expect(checkScene(s, null)).toEqual([]);
  });

  it("counts rear-left and rear-right as hits in the rear", () => {
    const s = sceneOf([
      veh("A", { bearingDeg: 0, speed: known(30), zone: "rear-left" }),
      veh("B", { bearingDeg: 0, speed: known(40), zone: "front" }),
    ]);
    expect(checkScene(s, null)).toEqual([]);
  });

  it("treats backing as travelling opposite to the way the vehicle faces", () => {
    // A backs south (facing north); B drives north into A's rear.
    const s = sceneOf([
      veh("A", { action: "backing", bearingDeg: 0, speed: known(5), zone: "rear" }),
      veh("B", { bearingDeg: 0, speed: known(15), zone: "front" }),
    ]);
    expect(checkScene(s, null)).toEqual([]);
  });
});

describe("checkScene: nothing moving", () => {
  it("says so when every speed is 0 or the vehicles are parked", () => {
    const s = sceneOf([
      veh("A", { bearingDeg: 0, speed: known(0), zone: "rear" }),
      veh("B", { action: "parked", bearingDeg: 0, speed: known(0), zone: "front" }),
    ]);
    const r = checkScene(s, null);
    expect(r.map((m) => m.code)).toEqual(["nothing-moving"]);
    expect([...r[0]!.vehicleIds].sort()).toEqual(["A", "B"]);
    expect(r[0]!.text).toMatch(/moving/i);
  });

  it("does not say it when one vehicle moves, or when a 'not sure' speed could be above 0", () => {
    expect(codes(sceneOf([
      veh("A", { bearingDeg: 0, speed: known(20), zone: "front" }),
      veh("B", { action: "parked", bearingDeg: 0, speed: known(0), zone: "rear" }),
    ]))).not.toContain("nothing-moving");
    expect(codes(sceneOf([
      veh("A", { bearingDeg: 0, speed: unsure(5), zone: "front" }),
      veh("B", { action: "parked", bearingDeg: 0, speed: known(0), zone: "rear" }),
    ]))).not.toContain("nothing-moving");
  });
});

describe("checkScene: same direction, neither hit in the rear", () => {
  const s = sceneOf([
    veh("A", { bearingDeg: 0, speed: known(30), zone: "front" }),
    veh("B", { bearingDeg: 0, speed: known(40), zone: "left" }),
  ]);

  it("flags two vehicles going the same way when neither is marked hit in the rear", () => {
    const r = checkScene(s, null).filter((m) => m.code === "same-direction");
    expect(r).toHaveLength(1);
    expect([...r[0]!.vehicleIds].sort()).toEqual(["A", "B"]);
    expect(r[0]!.text).toMatch(/rear/i);
    expect(r[0]!.text).toMatch(/\bA\b/);
    expect(r[0]!.text).toMatch(/\bB\b/);
  });

  it("is quiet once one of them is marked hit in the rear", () => {
    expect(codes({ ...s, vehicles: [{ ...s.vehicles[0]!, zone: "rear" }, s.vehicles[1]!] })).not.toContain("same-direction");
  });
});

describe("checkScene: the marked zone has to face where the other vehicle came from", () => {
  it("flags a head-on where A is marked hit in the rear, naming the approach and the zone", () => {
    const s = sceneOf([
      veh("A", { bearingDeg: 0, speed: known(30), zone: "rear" }),
      veh("B", { bearingDeg: 180, speed: known(30), zone: "front" }),
    ]);
    const r = checkScene(s, null).filter((m) => m.code === "zone-mismatch");
    expect(r).toHaveLength(1);
    expect([...r[0]!.vehicleIds].sort()).toEqual(["A", "B"]);
    expect(r[0]!.text).toMatch(/\bB\b/);
    expect(r[0]!.text).toMatch(/\bA\b/);
    expect(r[0]!.text).toMatch(/front/i);
    expect(r[0]!.text).toMatch(/rear/i);
    expect(r[0]!.text).not.toMatch(/undefined|NaN/);
  });

  it("flags a T-bone where A is marked hit on its right but B came from its left", () => {
    const s = sceneOf([
      veh("A", { bearingDeg: 0, speed: known(25), zone: "right" }),
      veh("B", { bearingDeg: 90, speed: known(25), zone: "front" }),
    ]);
    const r = checkScene(s, null).filter((m) => m.code === "zone-mismatch");
    expect(r).toHaveLength(1);
    expect(r[0]!.vehicleIds).toContain("A");
    expect(r[0]!.text).toMatch(/left/i);
    expect(r[0]!.text).toMatch(/right/i);
  });

  it("lets any of the low, middle and high speed cases explain the hit", () => {
    // A (marked hit in the rear) is "not sure" around a 30 mph limit; B goes 28 mph the same way.
    // At 30 or 35 A pulls away from B, but at the low case (25 mph) B catches A from behind.
    const unsureA = sceneOf([
      veh("A", { bearingDeg: 0, speed: unsure(30), zone: "rear" }),
      veh("B", { bearingDeg: 0, speed: known(28), zone: "front" }),
    ]);
    expect(checkScene(unsureA, null)).toEqual([]);
    // With A known at 30 mph, B can never catch it, and the rear hit doesn't fit.
    const knownA = sceneOf([
      veh("A", { bearingDeg: 0, speed: known(30), zone: "rear" }),
      veh("B", { bearingDeg: 0, speed: known(28), zone: "front" }),
    ]);
    expect(codes(knownA)).toContain("zone-mismatch");
  });
});

describe("checkScene: vehicles that can't meet", () => {
  it("says nothing could have reached a vehicle when no one moves relative to it", () => {
    // Same direction, same speed: the gap between them never closes.
    const s = sceneOf([
      veh("A", { bearingDeg: 0, speed: known(30), zone: "rear" }),
      veh("B", { bearingDeg: 0, speed: known(30), zone: "front" }),
    ]);
    const r = checkScene(s, null);
    const cm = r.filter((m) => m.code === "cannot-meet");
    expect(cm.length).toBeGreaterThan(0);
    expect(cm.some((m) => m.vehicleIds.includes("A"))).toBe(true);
    expect(r.some((m) => m.code === "zone-mismatch")).toBe(false);
    for (const m of cm) expect(m.text).toMatch(/reach|meet|hit/i);
  });

  it("returns plain text only, with no HTML and no placeholders", () => {
    const s = sceneOf([
      veh("A", { bearingDeg: 0, speed: known(30), zone: "rear" }),
      veh("B", { bearingDeg: 180, speed: known(30), zone: "front" }),
    ]);
    for (const m of checkScene(s, null)) {
      expect(m.text).not.toMatch(/[<>]|undefined|NaN|null/);
      expect(m.text.length).toBeGreaterThan(20);
      expect(m.vehicleIds.length).toBeGreaterThan(0);
    }
  });
});
