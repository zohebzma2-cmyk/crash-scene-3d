// poseAt on a hand-made result: it only needs the contract data, not the model.
import { describe, expect, it } from "vitest";
import { poseAt } from "../src";
import type { Pose, SimulationResult, VehicleResult } from "../src";
import { angleDiffRad, toRad } from "./physics-helpers";

const track = (n: number, f: (i: number) => Pose): Pose[] => Array.from({ length: n }, (_, i) => f(i));

function fake(poses: Pose[]): { sim: SimulationResult; v: VehicleResult } {
  const v: VehicleResult = {
    id: "A", type: "car", massKg: 1600, lengthM: 4.8, widthM: 1.85, inertiaKgM2: 2900, path: null,
    speedAtImpactMps: { lo: 1, mid: 1, hi: 1 }, approachDistanceM: { lo: 0, mid: 0, hi: 0 }, postImpactDistanceM: { lo: 0, mid: 0, hi: 0 },
    impactPose: poses[2]!, restPose: poses[poses.length - 1]!, track: poses,
  };
  const sim: SimulationResult = {
    physicsVersion: "test", dtS: 0.25, startTimeS: -0.5, impactTimeS: 0, restTimeS: -0.5 + 0.25 * (poses.length - 1),
    frictionCoefficient: 0.7, restitution: 0.2, impactPointM: { x: 0, y: 0 }, vehicles: [v], gaps: [], assumptions: [], warnings: [],
  };
  return { sim, v };
}

function expectPose(p: Pose, q: Pose | undefined): void {
  expect(q).toBeDefined();
  expect(p.xM).toBeCloseTo(q!.xM, 12);
  expect(p.yM).toBeCloseTo(q!.yM, 12);
  expect(angleDiffRad(p.headingRad, q!.headingRad)).toBeLessThan(1e-12);
  expect(p.speedMps).toBeCloseTo(q!.speedMps, 12);
}

const line = track(7, (i) => ({ xM: i, yM: 2 * i, headingRad: 0.1 * i, speedMps: 10 - i }));

describe("poseAt", () => {
  const { sim, v } = fake(line);

  it("returns the stored sample exactly at sample times (t = start + k * dt)", () => {
    expectPose(poseAt(sim, v, -0.5), line[0]);
    expectPose(poseAt(sim, v, 0), line[2]);
    expectPose(poseAt(sim, v, 0.5), line[4]);
    expectPose(poseAt(sim, v, 1), line[6]);
  });

  it("interpolates linearly between samples", () => {
    const p = poseAt(sim, v, 0.125); // halfway between samples 2 and 3
    expect(p.xM).toBeCloseTo(2.5, 12);
    expect(p.yM).toBeCloseTo(5, 12);
    expect(p.headingRad).toBeCloseTo(0.25, 12);
    expect(p.speedMps).toBeCloseTo(7.5, 12);
    const q = poseAt(sim, v, -0.5 + 0.25 * 3.25);
    expect(q.xM).toBeCloseTo(3.25, 12);
    expect(q.speedMps).toBeCloseTo(6.75, 12);
  });

  it("clamps to the first sample before the window and to the last after rest", () => {
    expectPose(poseAt(sim, v, -100), line[0]);
    expectPose(poseAt(sim, v, -0.5001), line[0]);
    expectPose(poseAt(sim, v, 1.0001), line[6]);
    expectPose(poseAt(sim, v, 100), line[6]);
  });

  it("turns the short way round when the heading wraps past north", () => {
    const wrap = fake(track(7, (i) => ({ xM: i, yM: 0, headingRad: i === 3 ? toRad(350) : i === 4 ? toRad(10) : 0, speedMps: 1 })));
    const p = poseAt(wrap.sim, wrap.v, -0.5 + 0.25 * 3.5);
    expect(angleDiffRad(p.headingRad, 0)).toBeLessThan(1e-9); // halfway from 350 deg to 10 deg is 0 deg, not 180
    const q = poseAt(wrap.sim, wrap.v, -0.5 + 0.25 * 3.25);
    expect(angleDiffRad(q.headingRad, toRad(355))).toBeLessThan(1e-9);
  });

  it("works for a one-sample track", () => {
    const one = fake([{ xM: 1, yM: 2, headingRad: 3, speedMps: 0 }]);
    expectPose(poseAt(one.sim, one.v, 5), { xM: 1, yM: 2, headingRad: 3, speedMps: 0 });
  });
});
