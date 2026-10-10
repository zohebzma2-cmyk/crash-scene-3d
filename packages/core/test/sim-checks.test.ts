// Road-aware checks in the simulation: free-line fallback, off-road, building walls for every run, turning offset, order, no display maths.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { simulate } from "../src";
import type { Scene, SimulationResult } from "../src";
import { impactInput } from "../src/physics/simulate";
import { placeDetailed } from "../src/physics/placement";
import { speedCases } from "../src/physics/model";
import { MAIN, PARK, distToPolyline, expectOk, known, parkingBackingScene, posOf, sceneOf, tBoneScene, unsure, veh } from "./physics-helpers";
import { intersectionNet, makeBuilding, parkingLotNet, rect } from "./roads-fixtures";

const run = (s: Scene, net: Parameters<typeof simulate>[1]): SimulationResult => expectOk(simulate(s, net)).result;
const codes = (r: SimulationResult) => r.warnings.map((w) => w.code);

describe("a vehicle that matches no road, and a path that leaves the road", () => {
  const net = intersectionNet({ corners: false });
  // Both headings are 45 degrees off every road at the pin, so neither vehicle matches a road.
  const diagonal = sceneOf([
    veh("A", { type: "car", bearingDeg: 45, speed: known(25), zone: "left" }),
    veh("B", { type: "suv", bearingDeg: 135, speed: known(25), zone: "front" }),
  ]);

  it("draws it straight and says so in plain words, naming the vehicle", () => {
    const sim = run(diagonal, net);
    const w = sim.warnings.filter((x) => x.code === "path-not-on-road");
    expect(w.map((x) => [...x.vehicleIds])).toEqual([["A"], ["B"]]);
    expect(w[0]!.text).toBe("Vehicle A's direction doesn't line up with a road near the pin, so its path is drawn straight.");
  });

  it("warns, but does not block, when that straight path crosses ground that isn't road", () => {
    const sim = run(diagonal, net);
    expect(codes(sim)).toContain("off-road");
    const w = sim.warnings.find((x) => x.code === "off-road")!;
    expect(w.text).toMatch(/off the road/);
    expect(sim.vehicles).toHaveLength(2);
  });

  it("stays quiet for a scene on its roads, in a lot, and with no road data at all", () => {
    for (const [scene, n] of [[tBoneScene(), intersectionNet({ mainLanes: 2 })], [parkingBackingScene(), parkingLotNet()], [diagonal, null]] as const) {
      const sim = run(scene, n);
      expect(codes(sim).filter((c) => c === "path-not-on-road" || c === "off-road")).toEqual([]);
    }
  });
});

describe("building walls stop every run, not just the picture", () => {
  const scene = tBoneScene({ bSpeed: unsure(30) });
  const base = intersectionNet({ mainLanes: 2, corners: false });
  const free = run(scene, base);
  const A = (r: SimulationResult) => r.vehicles.find((v) => v.id === "A")!;
  // Where A's front ends up in the middle run and in the high run, found by running those speeds on their own.
  const impact = posOf(A(free).impactPose);
  const restOf = (bMph: number) => A(run(tBoneScene({ bSpeed: known(bMph) }), base));
  const frontMid = restOf(30).restPose.yM + 2.4;
  const frontHi = restOf(35).restPose.yM + 2.4;
  const withWall = (southEdge: number) => intersectionNet({ mainLanes: 2, corners: false, extraBuildings: [makeBuilding("wall", rect(-20, southEdge, 60, southEdge + 10))] });

  it("the free run has a real spread to work with", () => {
    expect(frontHi - frontMid).toBeGreaterThan(0.5);
  });

  it("a wall only the high-speed run reaches shortens the high distance and gap, and leaves the picture alone", () => {
    const edge = (frontMid + frontHi) / 2;
    const sim = run(scene, withWall(edge));
    const a = A(sim);
    expect(a.postImpactDistanceM.mid).toBeCloseTo(A(free).postImpactDistanceM.mid, 9);
    expect(a.postImpactDistanceM.lo).toBeCloseTo(A(free).postImpactDistanceM.lo, 9);
    expect(a.postImpactDistanceM.hi).toBeLessThan(A(free).postImpactDistanceM.hi - 0.2);
    // The high run stopped with its front at the wall: not through it, and not much before it.
    const hiAlone = restOf(35);
    const northPerMetre = (hiAlone.restPose.yM - impact.y) / hiAlone.postImpactDistanceM.mid;
    const stopsAt = (edge - 2.4 - impact.y) / northPerMetre;
    expect(a.postImpactDistanceM.hi).toBeLessThanOrEqual(stopsAt + 0.15);
    expect(a.postImpactDistanceM.hi).toBeGreaterThan(stopsAt - 0.4);
    expect(sim.gaps[0]!.restGapM.hi).toBeLessThan(free.gaps[0]!.restGapM.hi - 0.1);
    expect(sim.gaps[0]!.restGapM.mid).toBeCloseTo(free.gaps[0]!.restGapM.mid, 9);
    expect(codes(sim)).not.toContain("stopped-at-building");
  });

  it("a wall the picture reaches stops the picture there, with a warning", () => {
    const edge = frontMid - 0.5;
    const sim = run(scene, withWall(edge));
    const a = A(sim);
    expect(a.restPose.yM + 2.4).toBeLessThanOrEqual(edge + 0.05);
    expect(a.restPose.yM + 2.4).toBeGreaterThan(edge - 0.4);
    expect(a.postImpactDistanceM.mid).toBeLessThan(A(free).postImpactDistanceM.mid - 0.2);
    const w = sim.warnings.find((x) => x.code === "stopped-at-building")!;
    expect(w.text).toBe("Vehicle A would have slid into a building after the crash. The picture stops it at the wall.");
    expect(a.speedAtImpactMps).toEqual(A(free).speedAtImpactMps);
  });
});

describe("a turning vehicle hit on its side keeps its offset in its own frame", () => {
  it("stays the same distance from its lane all the way round the turn", () => {
    const net = intersectionNet({ parkLanes: 2 });
    const scene = sceneOf([
      veh("A", { type: "car", action: "turn-left", bearingDeg: 0, ...MAIN, speed: known(15), zone: "right" }),
      veh("B", { type: "suv", bearingDeg: 270, ...PARK, speed: known(25), zone: "front" }),
    ]);
    const sim = run(scene, net);
    const A = sim.vehicles.find((v) => v.id === "A")!;
    const i0 = Math.round(-sim.startTimeS / sim.dtS);
    const at = (i: number) => distToPolyline(posOf(A.track[i]!), A.path!.points);
    const offset = at(i0);
    expect(offset).toBeGreaterThan(0.3); // hit on its side, so it sits off the lane line
    for (let i = 0; i < i0; i += 10) expect(Math.abs(at(i) - offset), `step ${i}`).toBeLessThan(0.05);
  });
});

describe("contacts are resolved in the order of the pair's letters", () => {
  it("sorts by (lower letter, higher letter), not by which vehicle attached", () => {
    const scene = sceneOf([
      veh("A", { type: "car", bearingDeg: 0, ...MAIN, speed: known(25), zone: "left" }),
      veh("B", { type: "suv", bearingDeg: 90, ...PARK, speed: known(25), zone: "front" }),
      veh("C", { type: "car", bearingDeg: 180, ...MAIN, speed: known(25), zone: "left" }),
      veh("D", { type: "suv", bearingDeg: 270, ...PARK, speed: known(25), zone: "front" }),
    ]);
    const placed = expectOk(placeDetailed(scene, intersectionNet(), { x: 0, y: 0 })).value;
    const p = placed.contacts[0]!.pointM, n = placed.contacts[0]!.normal;
    // Pairs C-A and B-D listed with the attaching vehicle first: by attacher order B-D would come first, by pair letters C-A (A, C) does.
    const contacts = [{ a: "C" as const, b: "A" as const, pointM: p, normal: n, patchM: [p] }, { a: "B" as const, b: "D" as const, pointM: p, normal: n, patchM: [p] }];
    const specs = impactInput(placed.bodies, contacts, placed.bodies.map((b) => speedCases(b.veh).mid), 0.7).specs;
    expect(specs.map((s) => [s.ia, s.ib])).toEqual([[2, 0], [1, 3]]);
  });
});

describe("no display maths inside the physics", () => {
  it("uses no toFixed or toLocaleString in physics sources (format.ts does the number formatting)", () => {
    const dir = new URL("../src/physics/", import.meta.url);
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
      const text = readFileSync(new URL(f, dir), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(text, f).not.toMatch(/\.toFixed\(|toLocaleString/);
    }
  });
});
