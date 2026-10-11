// drawsAsEntered() gives simulate()'s own answer, faster: the scene draws, with no hit side swapped in (no "zone-used").
// The one-tap fixer trusts it to judge every change it tries, so it is checked here over the fixer benchmark's refused
// scenes and nearby variants (other hit sides), plus every drawing example.
import { describe, expect, it } from "vitest";
import type { Scene, Zone } from "../src";
import { ZONES, drawsAsEntered, simulate, suggestFixes } from "../src";
import type { WorkMeter } from "../src";
import { loadBench, roadsOf } from "./fixer/bench";
import { NETWORKS, loadRoads, loadScene } from "./suggest-sweep";

const drawsExactly = (scene: Scene, roads: Parameters<typeof simulate>[1]): boolean => {
  const r = simulate(scene, roads);
  return r.ok && !r.result.warnings.some((w) => w.code === "zone-used");
};

describe("drawsAsEntered", () => {
  it("agrees with simulate() on every example, the benchmark's refused scenes and their other hit sides", () => {
    const cases = loadBench().filter((_, i) => i % 3 === 0);
    let n = 0, drawn = 0;
    for (const c of cases) {
      const roads = roadsOf(c.net);
      // The refused scene, two other hit sides for B, the fixes the fixer found (they draw) and those with A's side turned.
      const fixes = suggestFixes(c.scene, roads).fixes.map((f) => f.scene);
      const turn = (s: Scene, who: number, z: Zone): Scene => ({ ...s, vehicles: s.vehicles.map((v, i) => (i === who ? { ...v, zone: z } : v)) });
      const k = c.scene.vehicles.length;
      const variants = [c.scene, turn(c.scene, 1, ZONES[(k * 3) % 8]!), turn(c.scene, 1, ZONES[(k * 5 + 1) % 8]!), ...fixes, ...fixes.map((f) => turn(f, 0, ZONES[(ZONES.indexOf(f.vehicles[0]!.zone) + 1) % 8]!))];
      for (const [vi, scene] of variants.entries()) {
        const want = drawsExactly(scene, roads);
        const got = drawsAsEntered(scene, roads);
        expect(got.ok, `${c.id} variant ${vi}`).toBe(want);
        if (!got.ok) expect(got.errors.length).toBeGreaterThan(0);
        n++; if (want) drawn++;
      }
    }
    for (const [example, file] of NETWORKS) {
      expect(drawsAsEntered(loadScene(example), loadRoads(file)).ok).toBe(true);
      n++; drawn++;
    }
    expect(n).toBeGreaterThan(700);
    expect(drawn).toBeGreaterThan(150);
  }, 120_000);

  it("counts its work in units that grow with the vehicles and the speeds scanned", () => {
    const [example, file] = NETWORKS[0]!;
    const roads = loadRoads(file), scene = loadScene(example);
    const known: WorkMeter = { units: 0 }, unsure: WorkMeter = { units: 0 };
    drawsAsEntered(scene, roads, known);
    drawsAsEntered({ ...scene, vehicles: scene.vehicles.map((v) => ({ ...v, speed: { kind: "unsure" as const, limitMph: 30 } })) }, roads, unsure);
    expect(known.units).toBeGreaterThan(0);
    expect(unsure.units).toBeGreaterThanOrEqual(known.units);
    // The same scene always costs the same.
    const again: WorkMeter = { units: 0 };
    drawsAsEntered(scene, roads, again);
    expect(again.units).toBe(known.units);
  });
});
