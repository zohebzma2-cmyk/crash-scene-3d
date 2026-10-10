import { describe, expect, it } from "vitest";
import { Color, Group, Mesh, BoxGeometry } from "three";
import type { Pose, SimulationResult, VehicleResult } from "@csd/core";
import { ImpactFx } from "../../src/viewer/effects/controller";
import { applyDentProgress, morphParts } from "../../src/viewer/effects/damage";
import type { SceneColors } from "../../src/viewer/tokens";

const DT = 1 / 120;
const pose = (x: number, y: number, h: number, v: number): Pose => ({ xM: x, yM: y, headingRad: h, speedMps: v });
function vehicle(id: "A" | "B", heading: number): VehicleResult {
  const track: Pose[] = [];
  for (let i = 0; i <= 600; i++) track.push(pose(0, -10 + i * DT * 10, heading, 10));
  for (let i = 1; i <= 360; i++) track.push(pose(Math.sin(i * 0.004) * 3, 2 + i * 0.02, heading + i * 0.002, Math.max(0, 5 - i * 0.014)));
  return { id, type: "car", massKg: 1500, lengthM: 4.6, widthM: 1.9, inertiaKgM2: 3000, path: null, speedAtImpactMps: { lo: 10, mid: 10, hi: 10 }, approachDistanceM: { lo: 10, mid: 10, hi: 10 }, postImpactDistanceM: { lo: 7, mid: 7, hi: 7 }, impactPose: track[600]!, restPose: track[960]!, track };
}
const colors = new Proxy({ css: {} } as unknown as SceneColors, { get: (t, k) => (k === "css" ? {} : new Color(0.5, 0.5, 0.5)) });

describe("effects cost per frame", () => {
  it("setTime (48 shards, 4 skid ribbons, flash) and the dent update stay far under the 2 ms budget", () => {
    const sim = { dtS: DT, startTimeS: -5, impactTimeS: 0, restTimeS: -5 + 960 * DT, impactPointM: { x: 0, y: 2 }, vehicles: [vehicle("A", 0), vehicle("B", 1.5)], gaps: [], assumptions: [], warnings: [] } as unknown as SimulationResult;
    const fx = new ImpactFx({ sim, roads: null, colors, seed: 7, braking: new Set(["A", "B"]), strengthMps: 16 });
    const g = new Group(); g.add(new Mesh(morphParts({ body: new BoxGeometry(1.9, 1.2, 4.6) }, [{ zone: "front", severity: 1 }]).body));
    for (let i = 0; i < 200; i++) { fx.setTime(-0.5 + i * 0.01, false); applyDentProgress(g, 0.5); }       // warm up
    const n = 3000, t0 = performance.now();
    for (let i = 0; i < n; i++) { fx.setTime(((i % 800) / 800) * 3 - 0.5, false); applyDentProgress(g, (i % 10) / 10); }
    const ms = (performance.now() - t0) / n;
    console.log(`effects per frame: ${ms.toFixed(4)} ms (shards ${fx.shards.count}, ribbons ${fx.skids.length})`);
    expect(fx.shards.count).toBeGreaterThan(20);
    expect(fx.skids.length).toBe(4);
    expect(ms).toBeLessThan(1);
    fx.dispose();
  });
});
