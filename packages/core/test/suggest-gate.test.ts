// suggestFixes({ gate: true }): the Vehicles step's warnings offer the same one-tap fixes as the Review refusal
// (DESIGN.md section 18), including for a scene that only draws with another hit side swapped in. Every fix offered there
// draws as entered and leaves the plain checks with nothing to say, so tapping it clears the warning.
import { describe, expect, it } from "vitest";
import type { RoadNetwork, Scene } from "../src";
import { MAX_FIXES, checkScene, simulate, streetsAtPin, suggestFixes, toLocal } from "../src";
import { MAIN, PARK, known, sceneOf, veh } from "./physics-helpers";
import { intersectionNet } from "./roads-fixtures";
import { loadRoads, loadScene } from "./suggest-sweep";

/** The app's default claim: A northbound on Main, marked hit on the left; B westbound on Park. It draws only with A's right side. */
const defaultClaim = (): Scene => sceneOf([
  veh("A", { type: "car", bearingDeg: 0, ...MAIN, speed: known(25), zone: "left" }),
  veh("B", { type: "suv", bearingDeg: 270, ...PARK, speed: known(25), zone: "front" }),
]);

function expectClears(scene: Scene, roads: RoadNetwork | null) {
  const s = suggestFixes(scene, roads, { gate: true });
  expect(s.fixes.length).toBeGreaterThanOrEqual(1);
  expect(s.fixes.length).toBeLessThanOrEqual(MAX_FIXES);
  for (const f of s.fixes) {
    const r = simulate(f.scene, roads);
    expect(r.ok, f.label).toBe(true);
    if (r.ok) expect(r.result.warnings.some((w) => w.code === "zone-used"), f.label).toBe(false);
    expect(checkScene(f.scene, roads), f.label).toEqual([]);
    expect(f.notes).toBe(false);
  }
  // Smallest first, the same every time.
  expect(s.fixes.map((f) => f.size)).toEqual([...s.fixes.map((f) => f.size)].sort((a, b) => a - b));
  expect(suggestFixes(scene, roads, { gate: true }).fixes.map((f) => f.id)).toEqual(s.fixes.map((f) => f.id));
  return s;
}

describe("the Vehicles step's fixes (gate)", () => {
  for (const [label, net] of [["flat", null], ["with roads", intersectionNet()]] as const) {
    it(`${label}: the default claim draws, so Review has no refusal and no fixes`, () => {
      expect(simulate(defaultClaim(), net).ok).toBe(true);
      expect(suggestFixes(defaultClaim(), net).fixes).toEqual([]);
    });

    it(`${label}: the default claim's warning offers "Change A's hit side to Right side" first, and every fix clears it`, () => {
      expect(checkScene(defaultClaim(), net).map((m) => m.code)).toEqual(["zone-mismatch"]);
      const s = expectClears(defaultClaim(), net);
      expect(s.fixes[0]!.label).toBe("Change A's hit side to Right side");
      expect(s.why).toMatch(/^[A-Z].*\.$/);
    });
  }

  it("a refused scene (both hit on the rear, head-on) gets only fixes that leave no note", () => {
    const roads = loadRoads("t-bone-intersection-roads.json");
    const base = loadScene("t-bone-intersection");
    const st = streetsAtPin(roads, toLocal(roads.frame, base.location));
    const nb = st.directions.find((d) => d.label === "northbound on Main Street")!;
    const sb = st.directions.find((d) => d.label === "southbound on Main Street")!;
    const scene: Scene = {
      ...base,
      vehicles: [
        { ...base.vehicles[0]!, travel: { bearingDeg: nb.bearingDeg, roadId: nb.roadId, roadName: nb.roadName, lane: null }, zone: "rear", speed: { kind: "known", mph: 25 } },
        { ...base.vehicles[1]!, travel: { bearingDeg: sb.bearingDeg, roadId: sb.roadId, roadName: sb.roadName, lane: null }, zone: "rear", speed: { kind: "known", mph: 30 } },
      ],
    };
    expect(simulate(scene, roads).ok).toBe(false);
    expectClears(scene, roads);
  });

  it("a scene that draws as entered with nothing to say gets no fixes", () => {
    const fine = sceneOf([
      veh("A", { type: "car", bearingDeg: 0, ...MAIN, speed: known(25), zone: "right" }),
      veh("B", { type: "suv", bearingDeg: 270, ...PARK, speed: known(25), zone: "front" }),
    ]);
    expect(checkScene(fine, null)).toEqual([]);
    const s = suggestFixes(fine, null, { gate: true });
    expect(s.fixes).toEqual([]);
    expect(s.why).toBe("");
  });

  it("details the physics can't read get no fixes, as on Review", () => {
    const bad = defaultClaim();
    const s = suggestFixes({ ...bad, vehicles: [bad.vehicles[0]!] }, null, { gate: true });
    expect(s.fixes).toEqual([]);
  });
});
