// THE TYPED SPEED IS THE SPEED AT IMPACT (Zoheb's rule).
// For every vehicle in every scene below, speedAtImpactMps is the typed speed, exactly (lo/mid/hi for "not sure"
// are limit -5 / limit / limit +5 mph, narrowed only to the part of the range where the crash works), however the
// vehicle moves, whether or not it brakes, and on every road. A moving vehicle's speed before the impact is never
// below its speed at the impact, so it can't be shown stopped before the crash.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseScene, simulate } from "../src";
import type { RoadCondition, RoadNetwork, Scene, SceneSpeed, SceneVehicle, VehicleType, Zone } from "../src";
import { expectSpeedAtImpact } from "./speed-helpers";
import { HWY, MAIN, PARK, expectOk, flatRearEndScene, flatTBoneScene, highwayRearEndScene, known, parkingBackingScene, sceneOf, tBoneScene, unsure, veh } from "./physics-helpers";
import { highwayNet, intersectionNet, parkingLotNet } from "./roads-fixtures";

const real = JSON.parse(readFileSync(new URL("./data/t-bone-intersection-roads.json", import.meta.url), "utf8")) as RoadNetwork;
const example = (name: string): Scene => {
  const r = parseScene(JSON.parse(readFileSync(new URL(`../../../examples/${name}/scene.json`, import.meta.url), "utf8")));
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.value;
};

const chain = (): Scene => sceneOf([
  veh("A", { type: "suv", bearingDeg: 0, ...HWY, lane: 1, speed: known(20), zone: "rear", braking: true }),
  veh("B", { type: "car", bearingDeg: 0, ...HWY, lane: 1, speed: known(35), zone: "rear", braking: true }),
  veh("C", { type: "pickup", bearingDeg: 0, ...HWY, lane: 1, speed: unsure(50), zone: "front" }),
], { place: "road" });
const fourWay = (): Scene => sceneOf([
  veh("A", { type: "car", bearingDeg: 0, ...MAIN, speed: known(25), zone: "left", braking: true }),
  veh("B", { type: "suv", bearingDeg: 90, ...PARK, speed: known(25), zone: "front" }),
  veh("C", { type: "car", bearingDeg: 180, ...MAIN, speed: known(25), zone: "left" }),
  veh("D", { type: "suv", bearingDeg: 270, ...PARK, speed: known(25), zone: "front", braking: true }),
]);
const leftTurn = (): Scene => sceneOf([
  veh("A", { type: "car", action: "turn-left", bearingDeg: 0, ...MAIN, speed: known(15), zone: "right", braking: true }),
  veh("B", { type: "suv", bearingDeg: 270, ...PARK, speed: known(25), zone: "front" }),
]);

describe("the typed speed is the speed at impact", () => {
  it("holds for the three examples (flat template) and the t-bone on the real map", () => {
    for (const name of ["t-bone-intersection", "highway-rear-end", "parking-lot-backing"]) {
      const scene = example(name);
      expectSpeedAtImpact(scene, expectOk(simulate(scene, null)).result, name);
    }
    const scene = example("t-bone-intersection");
    expectSpeedAtImpact(scene, expectOk(simulate(scene, real)).result, "t-bone on the real map");
  });

  it("holds for the multi-vehicle and turning fixtures, braking or not, on every road condition", () => {
    const conditions: RoadCondition[] = ["dry", "wet", "snow", "ice"];
    for (const condition of conditions) {
      const cases: Array<[string, Scene, RoadNetwork | null]> = [
        ["chain", { ...chain(), road: { condition } }, highwayNet()],
        ["four-way", { ...fourWay(), road: { condition } }, intersectionNet({ corners: false })],
        ["left turn", { ...leftTurn(), road: { condition } }, intersectionNet({ parkLanes: 2 })],
        ["left turn, flat", { ...leftTurn(), road: { condition } }, null],
        ["t-bone", tBoneScene({ condition, bSpeed: unsure(30) }), intersectionNet({ mainLanes: 2 })],
        ["highway rear-end", highwayRearEndScene({ braking: true, condition }), highwayNet()],
        ["flat rear-end", flatRearEndScene({ braking: true, condition }), null],
        ["flat t-bone", flatTBoneScene({ condition, bSpeed: unsure(null) }), null],
      ];
      for (const [name, scene, net] of cases) expectSpeedAtImpact(scene, expectOk(simulate(scene, net)).result, `${name} ${condition}`);
    }
    const lot = parkingBackingScene();
    expectSpeedAtImpact(lot, expectOk(simulate(lot, parkingLotNet())).result, "parking lot");
  });
});

// ---------------------------------------------------------------- a seeded property test

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Kind = "t-bone" | "rear-end" | "turn-left" | "turn-right" | "backing" | "parked";
const KINDS: Kind[] = ["t-bone", "rear-end", "turn-left", "turn-right", "backing", "parked"];
const TYPES: VehicleType[] = ["car", "suv", "pickup", "van", "motorcycle", "truck"];
const CONDITIONS: RoadCondition[] = ["dry", "wet", "snow", "ice"];

function randomScene(rnd: () => number): { kind: Kind; scene: Scene } {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const range = (a: number, b: number) => a + rnd() * (b - a);
  const tenth = (a: number, b: number) => Math.round(range(a, b) * 10) / 10;
  const speed = (lo: number, hi: number): SceneSpeed => (rnd() < 0.35 ? unsure(rnd() < 0.3 ? null : Math.round(range(15, 55))) : known(tenth(lo, hi)));
  const kind = pick(KINDS);
  const th = Math.round(range(0, 359));
  const wrap = (d: number) => (((d % 360) + 360) % 360);
  const brk = () => rnd() < 0.5;
  const t = () => pick(TYPES);
  const z = (zone: Zone): Zone => zone;
  let vs: SceneVehicle[];
  switch (kind) {
    case "t-bone":
      vs = [veh("A", { type: t(), bearingDeg: th, speed: speed(4, 60), zone: z("left"), braking: brk() }), veh("B", { type: t(), bearingDeg: wrap(th + 90), speed: speed(4, 60), zone: z("front"), braking: brk() })];
      break;
    case "rear-end": {
      const lead = tenth(4, 40);
      vs = [
        veh("A", { type: t(), bearingDeg: th, speed: rnd() < 0.3 ? unsure(Math.round(lead)) : known(lead), zone: z("rear"), braking: brk() }),
        veh("B", { type: t(), bearingDeg: th, speed: known(tenth(lead + 4, lead + 35)), zone: z("front"), braking: brk() }),
      ];
      break;
    }
    case "turn-left":
      vs = [veh("A", { type: t(), action: "turn-left", bearingDeg: th, speed: speed(5, 25), zone: z("right"), braking: brk() }), veh("B", { type: t(), bearingDeg: wrap(th - 90), speed: speed(8, 45), zone: z("front"), braking: brk() })];
      break;
    case "turn-right":
      vs = [veh("A", { type: t(), action: "turn-right", bearingDeg: th, speed: speed(4, 15), zone: z("left"), braking: brk() }), veh("B", { type: t(), bearingDeg: wrap(th + 90), speed: speed(8, 45), zone: z("front"), braking: brk() })];
      break;
    case "backing":
      vs = [
        veh("A", { type: t(), bearingDeg: wrap(th + 90), speed: speed(4, 20), zone: z("left"), braking: brk() }),
        veh("B", { type: t(), action: "backing", bearingDeg: th, speed: rnd() < 0.35 ? unsure(Math.round(range(5, 10))) : known(tenth(1, 8)), zone: z("rear"), braking: brk() }),
      ];
      break;
    default:
      vs = [veh("A", { type: t(), bearingDeg: th, speed: speed(5, 60), zone: z("front"), braking: brk() }), veh("B", { type: t(), action: "parked", bearingDeg: th, speed: known(0), zone: z("rear") })];
  }
  return { kind, scene: sceneOf(vs, { condition: pick(CONDITIONS), place: "road" }) };
}

describe("the typed speed is the speed at impact: seeded property test", () => {
  it("holds for at least 200 random valid scenes (every action, braking or not, every road condition, not-sure lo/mid/hi)", () => {
    const rnd = mulberry32(20261009);
    const counts = new Map<Kind, number>();
    let ok = 0, tried = 0, unsureSeen = 0, brakingSeen = 0, backingUnsure = 0;
    const conditions = new Set<RoadCondition>();
    while (ok < 240 && tried < 6000) {
      tried++;
      const { kind, scene } = randomScene(rnd);
      const out = simulate(scene, null);
      if (!out.ok) continue;
      ok++;
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
      conditions.add(scene.road.condition);
      if (scene.vehicles.some((v) => v.speed.kind === "unsure")) unsureSeen++;
      if (scene.vehicles.some((v) => v.action === "backing" && v.speed.kind === "unsure")) backingUnsure++;
      if (scene.vehicles.some((v) => v.braking && v.action !== "parked")) brakingSeen++;
      expectSpeedAtImpact(scene, out.result, `${kind} #${tried}`);
    }
    expect(ok).toBe(240);
    for (const k of KINDS) expect(counts.get(k) ?? 0, `valid ${k} scenes`).toBeGreaterThanOrEqual(10);
    expect(backingUnsure, "valid scenes with a 'not sure' backing vehicle").toBeGreaterThanOrEqual(3);
    expect(conditions.size).toBe(4);
    expect(unsureSeen).toBeGreaterThanOrEqual(20);
    expect(brakingSeen).toBeGreaterThanOrEqual(40);
  });

  it("is repeatable: the same seed gives the same scenes", () => {
    const a = mulberry32(7), b = mulberry32(7);
    for (let i = 0; i < 5; i++) expect(randomScene(a)).toEqual(randomScene(b));
  });
});
