// fast-check arbitraries for the property tests: valid Scene v3 objects on real and synthetic road networks.
//
// Runs: a fixed seed so every run is repeatable. `FC_RUNS` raises the number of scenes per property
// (default below keeps the whole core suite well under a minute), e.g.
//   FC_RUNS=5000 npx vitest run packages/core/test/property
// `FC_SEED` replays another seed.
import fc from "fast-check";
import { appendFileSync, readFileSync } from "node:fs";
import { streetsAtPin, toLatLon } from "../../src";
import type { RoadNetwork, Scene, SceneSpeed, SceneVehicle, Vec2, VehicleId } from "../../src";
import { ACTIONS, ROAD_CONDITIONS, VEHICLE_IDS, VEHICLE_TYPES, ZONES } from "../../src";
import { FRAME, ORIGIN, makeWay } from "../roads-fixtures";

export const FC_SEED = Number(process.env["FC_SEED"] ?? 20261010);
/** Scenes per property. The default is 1,000 random scenes over the physics properties (see physics-properties.ts, run as physics-1 and physics-2.property.test.ts). */
export const runs = (dflt: number): number => {
  const env = Number(process.env["FC_RUNS"]);
  return Number.isFinite(env) && env > 0 ? Math.floor(env) : dflt;
};
/** Coverage numbers for a run: appended to the file named by PROP_STATS (vitest hides the console of passing tests). */
export const report = (line: string): void => {
  const file = process.env["PROP_STATS"];
  if (file) appendFileSync(file, `${line}\n`);
};
export const fcParams =(numRuns: number): fc.Parameters<unknown> => ({ seed: FC_SEED, numRuns, endOnFailure: false });

const loadNet = (name: string): RoadNetwork =>
  JSON.parse(readFileSync(new URL(`../data/${name}-roads.json`, import.meta.url), "utf8")) as RoadNetwork;

export const REAL_NETS = {
  "t-bone-intersection": loadNet("t-bone-intersection"),
  "highway-rear-end": loadNet("highway-rear-end"),
  "parking-lot-backing": loadNet("parking-lot-backing"),
} as const;

/** The world a scene sits in: road data (or none) and the pin in that data's local frame. */
export interface Env {
  readonly name: string;
  readonly roads: RoadNetwork | null;
  readonly pin: Vec2;
  /** Travel bearings (degrees) of the roads at the pin, with their ids and names. Empty for no road data. */
  readonly directions: ReadonlyArray<{ roadId: string; roadName: string | null; bearingDeg: number }>;
}

const synthetic = (ways: RoadNetwork["ways"]): RoadNetwork => ({
  frame: FRAME, radiusM: 250, ways, buildings: [], parking: [], terrain: null, attribution: ["© OpenStreetMap contributors (ODbL)"], fetchedAt: "2026-10-09T12:00:00Z",
});

/** A straight road through the pin at a random angle. */
const straightNet = fc.record({ angle: fc.integer({ min: 0, max: 179 }), lanes: fc.integer({ min: 1, max: 3 }), oneway: fc.boolean() }).map(({ angle, lanes, oneway }) => {
  const r = (angle * Math.PI) / 180, d = { x: Math.sin(r) * 240, y: Math.cos(r) * 240 };
  return synthetic([makeWay({ id: "s1", name: "First Street", oneway, lanesForward: lanes, lanesBackward: oneway ? 0 : lanes, centerline: [{ x: -d.x, y: -d.y }, d] })]);
});

/** Two straight roads crossing at the pin at a random angle (30 to 150 degrees). */
const crossingNet = fc.record({ angle: fc.integer({ min: 0, max: 179 }), cross: fc.integer({ min: 30, max: 150 }), l1: fc.integer({ min: 1, max: 2 }), l2: fc.integer({ min: 1, max: 2 }) })
  .map(({ angle, cross, l1, l2 }) => {
    const line = (deg: number) => { const r = (deg * Math.PI) / 180, d = { x: Math.sin(r) * 240, y: Math.cos(r) * 240 }; return [{ x: -d.x, y: -d.y }, d]; };
    return synthetic([
      makeWay({ id: "c1", name: "Oak Street", lanesForward: l1, lanesBackward: l1, centerline: line(angle) }),
      makeWay({ id: "c2", name: "Elm Street", lanesForward: l2, lanesBackward: l2, centerline: line(angle + cross) }),
    ]);
  });

const envOf = (name: string, roads: RoadNetwork | null, pin: Vec2): Env => ({
  name, roads, pin,
  directions: roads ? streetsAtPin(roads, pin).directions.map((d) => ({ roadId: d.roadId, roadName: d.roadName, bearingDeg: d.bearingDeg })) : [],
});

const offset = fc.record({ x: fc.integer({ min: -150, max: 150 }), y: fc.integer({ min: -150, max: 150 }) }).map((p) => ({ x: p.x / 10, y: p.y / 10 }));

export const envArb: fc.Arbitrary<Env> = fc.oneof(
  { weight: 2, arbitrary: fc.constant(envOf("flat", null, { x: 0, y: 0 })) },
  ...Object.entries(REAL_NETS).map(([name, net]) => ({ weight: 2, arbitrary: offset.map((p) => envOf(name, net, p)) })),
  { weight: 1, arbitrary: straightNet.map((n) => envOf("straight", n, { x: 0, y: 0 })) },
  { weight: 1, arbitrary: crossingNet.map((n) => envOf("crossing", n, { x: 0, y: 0 })) },
);

const tenths = (lo: number, hi: number) => fc.integer({ min: lo * 10, max: hi * 10 }).map((x) => x / 10);
const speedArb: fc.Arbitrary<SceneSpeed> = fc.oneof(
  { weight: 3, arbitrary: tenths(0, 80).map((mph): SceneSpeed => ({ kind: "known", mph })) },
  { weight: 1, arbitrary: tenths(80, 150).map((mph): SceneSpeed => ({ kind: "known", mph })) },
  { weight: 2, arbitrary: fc.oneof(fc.constant(null), fc.integer({ min: 5, max: 85 }), tenths(5, 85)).map((limitMph): SceneSpeed => ({ kind: "unsure", limitMph })) },
);

const wrap360 = (d: number) => (((d % 360) + 360) % 360);

function vehicleArb(id: VehicleId, env: Env): fc.Arbitrary<SceneVehicle> {
  const travel = env.directions.length
    ? fc.oneof(
      { weight: 4, arbitrary: fc.record({ d: fc.constantFrom(...env.directions), jitter: fc.integer({ min: -30, max: 30 }), useId: fc.boolean(), useName: fc.boolean(), lane: fc.option(fc.integer({ min: 0, max: 2 }), { nil: null, freq: 4 }) })
        .map(({ d, jitter, useId, useName, lane }) => ({ bearingDeg: wrap360(Math.round(d.bearingDeg * 10 + jitter) / 10), roadId: useId ? d.roadId : null, roadName: useName ? d.roadName : null, lane })) },
      { weight: 1, arbitrary: fc.integer({ min: 0, max: 3599 }).map((b) => ({ bearingDeg: b / 10, roadId: null, roadName: null, lane: null })) },
    )
    : fc.integer({ min: 0, max: 359 }).map((b) => ({ bearingDeg: b, roadId: null, roadName: null, lane: null }));
  return fc.record({
    type: fc.constantFrom(...VEHICLE_TYPES),
    action: fc.oneof({ weight: 6, arbitrary: fc.constant("straight" as const) }, { weight: 4, arbitrary: fc.constantFrom(...ACTIONS) }),
    travel,
    speed: speedArb,
    braking: fc.boolean(),
    zone: fc.constantFrom(...ZONES),
  }).map((v): SceneVehicle => ({
    id, role: id === "A" ? "claimant" : "other", year: null, make: "", model: "", typeSource: "manual", ...v,
    speed: v.action === "parked" ? { kind: "known", mph: 0 } : v.speed,
  }));
}

export interface SceneCase { readonly env: Env; readonly scene: Scene }

type Layout = "free" | "t-bone" | "rear-end" | "head-on";
const angleDiff = (a: number, b: number) => Math.abs((((a - b) % 360) + 540) % 360 - 180);
/** The road direction at the pin nearest to a wanted bearing (the bearing itself with no road data). */
const nearestDir = (env: Env, want: number): { bearingDeg: number; roadId: string | null; roadName: string | null } => {
  if (!env.directions.length) return { bearingDeg: Math.round(wrap360(want)), roadId: null, roadName: null };
  const best = [...env.directions].sort((p, q) => angleDiff(p.bearingDeg, want) - angleDiff(q.bearingDeg, want))[0]!;
  return { bearingDeg: Math.round(best.bearingDeg * 10) / 10 % 360, roadId: best.roadId, roadName: best.roadName };
};

/**
 * Most purely random scenes are refused (zones that can't touch, lanes that don't exist), so a share of scenes is laid out
 * like real crashes: a side hit, a rear-end chain or a head-on, on the road directions at the pin. Types, speeds, braking
 * and the road condition stay random.
 */
function laidOut(layout: Layout, env: Env, vs: SceneVehicle[], baseDeg: number, side: boolean): SceneVehicle[] {
  if (layout === "free") return vs;
  const d0 = nearestDir(env, baseDeg);
  const set = (v: SceneVehicle, t: { bearingDeg: number; roadId: string | null; roadName: string | null }, zone: SceneVehicle["zone"]): SceneVehicle =>
    ({ ...v, action: v.action === "parked" || v.action === "backing" ? "straight" : v.action, travel: { ...v.travel, ...t, lane: null }, zone,
      speed: v.action === "parked" ? { kind: "known", mph: 20 } : v.speed });
  if (layout === "t-bone") {
    const b = nearestDir(env, d0.bearingDeg + (side ? 90 : -90));
    return [set(vs[0]!, d0, side ? "left" : "right"), set(vs[1]!, b, "front"), ...vs.slice(2)];
  }
  if (layout === "head-on") {
    return [set(vs[0]!, d0, "front"), set(vs[1]!, nearestDir(env, d0.bearingDeg + 180), "front"), ...vs.slice(2)];
  }
  // A rear-end chain: A in front (slowest), each one behind faster; the last is hit only on its front.
  return vs.map((v, i) => {
    const s = set({ ...v, action: "straight" }, d0, i === vs.length - 1 ? "front" : "rear");
    return { ...s, speed: { kind: "known", mph: Math.min(150, 5 + 15 * i + (s.speed.kind === "known" ? Math.round(s.speed.mph * 2) / 10 : 3)) } };
  });
}

export const sceneCaseArb: fc.Arbitrary<SceneCase> = envArb.chain((env) =>
  fc.record({
    n: fc.oneof({ weight: 3, arbitrary: fc.constant(2) }, { weight: 1, arbitrary: fc.integer({ min: 3, max: 4 }) }),
    condition: fc.constantFrom(...ROAD_CONDITIONS),
    layout: fc.constantFrom<Layout>("free", "free", "t-bone", "t-bone", "rear-end", "head-on"),
    baseDeg: env.directions.length ? fc.constantFrom(...env.directions.map((d) => d.bearingDeg)) : fc.integer({ min: 0, max: 359 }),
    side: fc.boolean(),
  }).chain(({ n, condition, layout, baseDeg, side }) =>
    fc.tuple(...VEHICLE_IDS.slice(0, n).map((id) => vehicleArb(id, env))).map((raw): SceneCase => {
      const vehicles = laidOut(layout, env, raw, baseDeg, side);
      // At least one vehicle has to be moving (a schema rule): un-park A if needed.
      const vs = vehicles.some((v) => v.action !== "parked") ? vehicles : [{ ...vehicles[0]!, action: "straight" as const, speed: { kind: "known" as const, mph: 20 } }, ...vehicles.slice(1)];
      const at = env.roads ? toLatLon(env.roads.frame, env.pin) : ORIGIN;
      const place = env.name === "parking-lot-backing" ? "parking" : env.name === "highway-rear-end" || env.name === "straight" ? "road" : "intersection";
      const scene: Scene = {
        schemaVersion: 3,
        claim: { number: "CLM-PROP", vehicle: { year: null, make: "", model: "" } },
        location: { lat: at.lat, lon: at.lon, label: "Synthetic test location", nearLabel: "", source: "pin", place },
        occurred: { date: "2026-10-02", time: "17:15" },
        road: { condition },
        vehicles: vs,
      };
      return { env, scene };
    })));
