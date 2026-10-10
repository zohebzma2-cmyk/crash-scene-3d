// Hand-made, realistic SimulationResult fixtures for the exports tests (the
// physics package isn't merged yet). Built from the example scenes with simple
// kinematics: constant-speed approach, one planar impulse along the contact
// normal (restitution 0.2), then a friction slide at mu*g with a little spin.
// Every number the exports print comes out of these results, never from the tests.
import { readFileSync } from "node:fs";
import { FRICTION, MPH_TO_MPS, PHYSICS_VERSION, PRESETS, RESTITUTION, G_MPS2, DEFAULT_LIMIT_MPH, RANGE_HALF_MPH, parseScene } from "@csd/core";
import type { Pose, Range, Scene, SceneVehicle, SimulationResult, Vec2, VehicleId, VehicleResult } from "@csd/core";

export function loadExample(name: string): Scene {
  const raw = JSON.parse(readFileSync(new URL(`../../../examples/${name}/scene.json`, import.meta.url), "utf8"));
  const r = parseScene(raw);
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.value;
}

const DT_S = 0.05;
const APPROACH_S = 2;
const deg = (d: number) => (d * Math.PI) / 180;
const fwd = (h: number): Vec2 => ({ x: Math.sin(h), y: Math.cos(h) });
const right = (h: number): Vec2 => ({ x: Math.cos(h), y: -Math.sin(h) });
const add = (a: Vec2, b: Vec2, k = 1): Vec2 => ({ x: a.x + b.x * k, y: a.y + b.y * k });
const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;
const len = (a: Vec2) => Math.hypot(a.x, a.y);

interface Dim { massKg: number; lengthM: number; widthM: number }
const dims = (v: SceneVehicle): Dim => ({ massKg: PRESETS[v.type].mass.value, lengthM: PRESETS[v.type].length.value, widthM: PRESETS[v.type].width.value });

/** Speed range at impact (m/s) from what the scene says. */
function speedRange(v: SceneVehicle): Range {
  if (v.action === "parked") return { lo: 0, mid: 0, hi: 0 };
  if (v.speed.kind === "known") { const s = v.speed.mph * MPH_TO_MPS; return { lo: s, mid: s, hi: s }; }
  const lim = v.speed.limitMph ?? DEFAULT_LIMIT_MPH;
  return { lo: (lim - RANGE_HALF_MPH) * MPH_TO_MPS, mid: lim * MPH_TO_MPS, hi: (lim + RANGE_HALF_MPH) * MPH_TO_MPS };
}
const range = (xs: number[], mid: number): Range => ({ lo: Math.min(...xs), mid, hi: Math.max(...xs) });

interface Impact { readonly c: Vec2; readonly headingRad: number }
interface Post { readonly v: Vec2; readonly yawRad: number }

/** Planar impulse along n (pointing from `b` into `a`), restitution RESTITUTION. */
function impulse(ma: number, va: Vec2, mb: number, vb: Vec2, n: Vec2): { a: Vec2; b: Vec2 } {
  const vrel = dot(add(va, vb, -1), n);
  const j = (-(1 + RESTITUTION) * Math.min(vrel, 0)) / (1 / ma + 1 / mb);
  return { a: add(va, n, j / ma), b: add(vb, n, -j / mb) };
}

function buildResult(scene: Scene, impacts: Record<string, Impact>, posts: (speeds: Record<string, number>) => Record<string, Post>, touched: ReadonlyArray<readonly [VehicleId, VehicleId]>, extra: { warnings?: SimulationResult["warnings"] } = {}): SimulationResult {
  const mu = FRICTION[scene.road.condition];
  const decel = mu * G_MPS2;
  const cases = ["lo", "mid", "hi"] as const;
  const per = scene.vehicles.map((v) => ({ v, d: dims(v), speeds: speedRange(v) }));
  const run = (key: (typeof cases)[number]) => {
    const speeds = Object.fromEntries(per.map((p) => [p.v.id, p.speeds[key]]));
    const post = posts(speeds);
    return Object.fromEntries(per.map((p) => {
      const imp = impacts[p.v.id]!;
      const ps = post[p.v.id]!;
      const s = len(ps.v);
      const dist = (s * s) / (2 * decel);
      const dir = s > 1e-9 ? { x: ps.v.x / s, y: ps.v.y / s } : { x: 0, y: 0 };
      return [p.v.id, { dist, restC: add(imp.c, dir, dist), restH: imp.headingRad + ps.yawRad, s, dir, tRest: s / decel, yaw: ps.yawRad }];
    }));
  };
  const results = { lo: run("lo"), mid: run("mid"), hi: run("hi") };
  const mid = results.mid;
  const restTimeS = Math.max(...per.map((p) => mid[p.v.id]!.tRest)) + 0.5;
  const startTimeS = -APPROACH_S;

  const vehicles: VehicleResult[] = per.map((p) => {
    const id = p.v.id;
    const imp = impacts[id]!;
    const m = mid[id]!;
    const f = fwd(imp.headingRad);
    const v0 = p.speeds.mid;
    const track: Pose[] = [];
    const n = Math.round((restTimeS - startTimeS) / DT_S);
    for (let i = 0; i <= n; i++) {
      const t = startTimeS + i * DT_S;
      if (t < 0) {
        track.push({ xM: imp.c.x + f.x * v0 * t, yM: imp.c.y + f.y * v0 * t, headingRad: imp.headingRad, speedMps: v0 });
      } else {
        const ts = Math.min(t, m.tRest);
        const sdist = m.s * ts - 0.5 * decel * ts * ts;
        const frac = m.tRest > 0 ? ts / m.tRest : 1;
        track.push({ xM: imp.c.x + m.dir.x * sdist, yM: imp.c.y + m.dir.y * sdist, headingRad: imp.headingRad + m.yaw * frac, speedMps: Math.max(0, m.s - decel * ts) });
      }
    }
    const impactPose: Pose = { xM: imp.c.x, yM: imp.c.y, headingRad: imp.headingRad, speedMps: v0 };
    const restPose: Pose = { xM: m.restC.x, yM: m.restC.y, headingRad: m.restH, speedMps: 0 };
    return {
      id, type: p.v.type, massKg: p.d.massKg, lengthM: p.d.lengthM, widthM: p.d.widthM,
      inertiaKgM2: (p.d.massKg * (p.d.lengthM ** 2 + p.d.widthM ** 2)) / 12,
      path: null,
      speedAtImpactMps: p.speeds,
      approachDistanceM: { lo: p.speeds.lo * APPROACH_S, mid: p.speeds.mid * APPROACH_S, hi: p.speeds.hi * APPROACH_S },
      postImpactDistanceM: range(cases.map((c) => results[c][id]!.dist), m.dist),
      impactPose, restPose, track,
    };
  });

  const gaps: SimulationResult["gaps"][number][] = [];
  // Only pairs that touched at impact get a gap, as the physics will report them.
  for (const [a, b] of touched) {
    const d = (c: (typeof cases)[number]) => len(add(results[c][a]!.restC, results[c][b]!.restC, -1));
    gaps.push({ a, b, restGapM: range(cases.map(d), d("mid")) });
  }
  const unsure = scene.vehicles.filter((v) => v.speed.kind === "unsure").map((v) => v.id);
  const fr = FRICTION;
  return {
    physicsVersion: PHYSICS_VERSION,
    dtS: DT_S, startTimeS, impactTimeS: 0, restTimeS,
    frictionCoefficient: mu, restitution: RESTITUTION,
    impactPointM: { x: 0, y: 0 },
    vehicles, gaps,
    assumptions: [
      { id: "friction", text: `Road ${scene.road.condition}, as entered: friction ${mu} for the whole road (dry ${fr.dry} · wet ${fr.wet} · snow ${fr.snow} · ice ${fr.ice}). Flat surface.`, value: mu },
      { id: "rigid", text: "Vehicles are rigid bodies with class-average weights (EPA 2025 Trends Report where available).", source: "EPA" },
      { id: "speeds", text: unsure.length ? `Not sure of ${unsure.join(", ")}'s speed: run at the limit ±${RANGE_HALF_MPH} mph (${DEFAULT_LIMIT_MPH} mph if unknown); the picture uses the middle, distances show the range.` : "Speeds and directions as entered." },
      { id: "collision", text: `No braking or steering unless entered. Simplified collision (restitution ${RESTITUTION}) with a fixed time step.` },
    ],
    warnings: extra.warnings ?? [],
  };
}

/** T-bone at the pin: B's front into A's right side. Returns scene + result. */
export function twoVehicle(): { scene: Scene; sim: SimulationResult } {
  const scene = loadExample("t-bone-intersection");
  const [A, B] = scene.vehicles as [SceneVehicle, SceneVehicle];
  const dA = dims(A); const dB = dims(B);
  const hA = deg(A.travel.bearingDeg); const hB = deg(B.travel.bearingDeg);
  const P = { x: 0, y: 0 };
  const cA = add(P, right(hA), -dA.widthM / 2);
  const cB = add(P, fwd(hB), -dB.lengthM / 2);
  const impacts = { A: { c: cA, headingRad: hA }, B: { c: cB, headingRad: hB } };
  const sim = buildResult(scene, impacts, (s) => {
    const r = impulse(dA.massKg, { x: fwd(hA).x * s.A!, y: fwd(hA).y * s.A! }, dB.massKg, { x: fwd(hB).x * s.B!, y: fwd(hB).y * s.B! }, fwd(hB));
    return { A: { v: r.a, yawRad: deg(18) }, B: { v: r.b, yawRad: deg(-12) } };
  }, [["A", "B"]]);
  return { scene, sim };
}

/** Four vehicles: D rear-ends B, B hits A, A pushes parked C. Three warnings. */
export function fourVehicle(): { scene: Scene; sim: SimulationResult } {
  const base = loadExample("t-bone-intersection");
  const [A, B] = base.vehicles as [SceneVehicle, SceneVehicle];
  const C: SceneVehicle = { id: "C", role: "other", year: 2016, make: "Subaru", model: "Impreza", type: "car", typeSource: "manual", action: "parked",
    travel: { bearingDeg: A.travel.bearingDeg, roadId: null, roadName: A.travel.roadName, lane: null }, speed: { kind: "known", mph: 0 }, braking: false, zone: "rear" };
  const D: SceneVehicle = { id: "D", role: "other", year: 2020, make: "Ram", model: "1500", type: "pickup", typeSource: "manual", action: "straight",
    travel: { bearingDeg: B.travel.bearingDeg, roadId: null, roadName: B.travel.roadName, lane: null }, speed: { kind: "known", mph: 20 }, braking: false, zone: "front" };
  const scene: Scene = { ...base, vehicles: [A, B, C, D] };
  const dA = dims(A); const dB = dims(B); const dC = dims(C); const dD = dims(D);
  const hA = deg(A.travel.bearingDeg); const hB = deg(B.travel.bearingDeg);
  const P = { x: 0, y: 0 };
  const cA = add(P, right(hA), -dA.widthM / 2);
  const cB = add(P, fwd(hB), -dB.lengthM / 2);
  const cC = add(add(cA, fwd(hA), dA.lengthM / 2 + dC.lengthM / 2 + 0.6), right(hA), -2.2);
  const cD = add(cB, fwd(hB), -(dB.lengthM / 2 + dD.lengthM / 2 + 1.4));
  const impacts = { A: { c: cA, headingRad: hA }, B: { c: cB, headingRad: hB }, C: { c: cC, headingRad: hA }, D: { c: cD, headingRad: hB } };
  const sim = buildResult(scene, impacts, (s) => {
    const vA = { x: fwd(hA).x * s.A!, y: fwd(hA).y * s.A! };
    const vB = { x: fwd(hB).x * s.B!, y: fwd(hB).y * s.B! };
    const vD = { x: fwd(hB).x * s.D!, y: fwd(hB).y * s.D! };
    const ab = impulse(dA.massKg, vA, dB.massKg, vB, fwd(hB));
    const db = impulse(dB.massKg, ab.b, dD.massKg, vD, fwd(hB));
    const ac = impulse(dC.massKg, { x: 0, y: 0 }, dA.massKg, ab.a, fwd(hA));
    return { A: { v: ac.b, yawRad: deg(18) }, B: { v: db.a, yawRad: deg(-12) }, C: { v: ac.a, yawRad: deg(4) }, D: { v: db.b, yawRad: deg(8) } };
  }, [["A", "B"], ["B", "D"], ["A", "C"]], {
    warnings: [
      { code: "zone-vs-direction", text: "Vehicle B is marked as hit on the front, but vehicle D came from behind it. Check where each vehicle was hit.", vehicleIds: ["B", "D"] },
      { code: "parked-moved", text: "Vehicle C is parked and was pushed by A. Check that C was really parked.", vehicleIds: ["A", "C"] },
      { code: "limit-unknown", text: "B's speed is not sure and the limit isn't known, so the picture uses a typical city limit.", vehicleIds: ["B"] },
    ],
  });
  return { scene, sim };
}

/** Four vehicles with n short warnings (one line each) and the normal assumptions: an oversized set that fits on two pages. */
export function manyShortWarnings(n: number): { scene: Scene; sim: SimulationResult } {
  const { scene, sim } = fourVehicle();
  const warnings = Array.from({ length: n }, (_, i) => ({
    code: `s${i}`,
    text: `Check ${i + 1}: the speed and where the vehicle was hit don't quite fit together.`,
    vehicleIds: ["A"] as VehicleId[],
  }));
  return { scene, sim: { ...sim, warnings } };
}

/** Same as fourVehicle but with many long warnings and assumptions, to stress the page fit. */
export function stress(n: number): { scene: Scene; sim: SimulationResult } {
  const { scene, sim } = fourVehicle();
  const warnings = Array.from({ length: n }, (_, i) => ({
    code: `w${i}`,
    text: `Check ${i + 1}: the entered speed for this vehicle and the way it was hit don't quite fit together, so the picture may show a bigger or smaller slide than you remember. Look at the speed, the direction and where the vehicle was hit.`,
    vehicleIds: ["A"] as VehicleId[],
  }));
  const assumptions = [...sim.assumptions, ...Array.from({ length: n }, (_, i) => ({ id: `x${i}`, text: `Extra assumption ${i + 1}: the model treats this part of the scene in a simplified way, and real vehicle movement may have been different.` }))];
  return { scene, sim: { ...sim, warnings, assumptions } };
}
