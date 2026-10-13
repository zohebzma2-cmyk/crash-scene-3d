// Property-based physics tests over random valid scenes (fast-check, fixed seed; FC_RUNS raises the count).
// Registered by physics-1.property.test.ts and physics-2.property.test.ts (two files, so the halves run in parallel).
//
// For every scene simulate() accepts:
//  - MOMENTUM. The impulse model (impact.ts) applies +P to one body and -P to the other at the same contact point, for
//    every point of every contact and every pass, including the energy-guard blend. So total linear momentum (sum m v) and
//    total angular momentum about a fixed point (sum I w + m r x v) are conserved exactly in exact arithmetic. The only error
//    is floating-point rounding over at most 4 passes x 6 pairs x 3 points, so the tolerance is relative: 1e-9 of the momentum
//    scale (sum m |v| before, plus 1 kg m/s), and the same for angular momentum (scale sum m |r| |v| + I |w| + 1). Kinetic
//    energy never rises (restitution 0.2 < 1 and the guard), to the same relative tolerance.
//    The pre- and post-impact states are recomputed with the same internals simulate() uses (placeDetailed + impactInput +
//    resolveContacts at the picture speeds) and tied to the result through each vehicle's deltaVMps.mid and spinRadps.mid.
//  - TYPED SPEED = SPEED AT IMPACT (the rule in speed-at-impact.test.ts, on random scenes and real roads).
//  - NO PASS-THROUGH: over the 5 s approach no two oriented boxes overlap by more than OVERLAP_TOLERANCE_M (0.05 m) at any
//    sample; at t = 0 the touching pairs are in contact (penetration <= 5 mm, gap <= 2 cm, README "Touching at t = 0").
//  - SLIDES END: speeds never rise after the first post-impact sample, the spin decays without changing sign, the track
//    ends at rest, and a stopped vehicle stays put.
//  - FINITE + ORDERED: every number in the result is finite, every {lo, mid, hi} has lo <= mid <= hi, tracks stay within
//    MAX_TRACK_SAMPLES, and the same input gives byte-identical canonical JSON.
// For refused scenes: the errors are plain sentences with known codes.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { CONTACT_FRICTION, FRICTION, IMPACT_PASSES, MAX_TRACK_SAMPLES, OVERLAP_TOLERANCE_M, RESTITUTION, canonicalJson, simulate, toLocal } from "../../src";
import type { Pose, Scene, SimulationResult, RoadNetwork } from "../../src";
import { impactInput } from "../../src/physics/simulate";
import { placeDetailed } from "../../src/physics/placement";
import { cleanNet } from "../../src/physics/lanes";
import { resolveContacts, type Body2D } from "../../src/physics/impact";
import { assertAllFinite, cornersOf, overlapDepth } from "../physics-helpers";
import { expectSpeedAtImpact } from "../speed-helpers";
import { FC_SEED, fcParams, report, runs, sceneCaseArb } from "./arbitraries";

/** Every code simulate() may refuse a scene with. */
export const ERROR_CODES = new Set([
  "too-few-vehicles", "too-many-vehicles", "bad-location", "bad-road-condition", "bad-vehicle", "bad-direction", "bad-lane", "bad-speed",
  "bad-pin", "no-road", "no-such-lane", "wrong-way", "nothing-moving", "zones-cannot-touch", "zone-mismatch", "cannot-meet", "same-direction",
  "bodies-overlap", "moving-apart", "not-moving-toward", "too-slow", "passes-through", "on-building", "no-workable-speed", "too-long",
  // roads and paths (2026-10-11): a direction that follows no road, a turn with no road to turn from, paths that don't meet, a start too hard
  "off-road-direction", "no-road-to-turn-from", "paths-dont-meet", "start-too-short",
]);
/** Every code a warning may carry. */
export const WARNING_CODES = new Set([
  "off-road", "picture-speed", "range-start", "range-end", "range-gap", "stopped-at-building",
  "stopped-at-vehicle", "zone-used",
  // checkScene's findings, which simulate() passes on as warnings
  "cannot-meet", "moving-apart", "nothing-moving", "same-direction", "zone-mismatch", "zones-cannot-touch",
]);

const PLAIN = /^[^<>{}\\]*$/;
export function expectPlainMessages(msgs: ReadonlyArray<{ code: string; text: string; vehicleIds: readonly string[] }>, known: Set<string>, ids: readonly string[], label: string): void {
  for (const m of msgs) {
    expect(known.has(m.code), `${label}: unknown code ${m.code}`).toBe(true);
    expect(typeof m.text).toBe("string");
    expect(m.text.length, `${label}: empty text`).toBeGreaterThan(0);
    expect(m.text, `${label}: ${m.code}`).toMatch(PLAIN);
    expect(m.text, `${label}: ${m.code}`).not.toMatch(/undefined|NaN|Infinity|\[object|null/);
    for (const id of m.vehicleIds) expect(ids, `${label}: ${m.code} names ${id}`).toContain(id);
  }
}

/** Walk the whole result: every {lo, mid, hi} is ordered. */
function expectRangesOrdered(v: unknown, path: string): void {
  if (Array.isArray(v)) { v.forEach((x, i) => expectRangesOrdered(x, `${path}[${i}]`)); return; }
  if (!v || typeof v !== "object") return;
  const o = v as Record<string, unknown>;
  if (typeof o["lo"] === "number" && typeof o["mid"] === "number" && typeof o["hi"] === "number") {
    expect(o["lo"] as number, `${path}.lo <= mid`).toBeLessThanOrEqual(o["mid"] as number);
    expect(o["mid"] as number, `${path}.mid <= hi`).toBeLessThanOrEqual(o["hi"] as number);
  }
  for (const [k, x] of Object.entries(o)) expectRangesOrdered(x, `${path}.${k}`);
}

const cross = (r: { x: number; y: number }, v: { x: number; y: number }) => r.x * v.y - r.y * v.x;
function totals(bodies: readonly Body2D[]) {
  let px = 0, py = 0, L = 0, ke = 0, pScale = 1, lScale = 1;
  for (const b of bodies) {
    const v = b.velocityMps, c = b.centreM;
    px += b.massKg * v.x; py += b.massKg * v.y;
    L += b.inertiaKgM2 * b.spinRadPs + b.massKg * cross(c, v);
    ke += 0.5 * b.massKg * (v.x ** 2 + v.y ** 2) + 0.5 * b.inertiaKgM2 * b.spinRadPs ** 2;
    pScale += b.massKg * Math.hypot(v.x, v.y);
    lScale += b.massKg * Math.hypot(c.x, c.y) * Math.hypot(v.x, v.y) + b.inertiaKgM2 * Math.abs(b.spinRadPs);
  }
  return { px, py, L, ke, pScale, lScale };
}
const REL = 1e-9;
/** A hang fails in 2 minutes on the default run; deep runs (FC_RUNS) get about 50 ms per scene. */
const FC_RUNS_TIMEOUT_MS = Math.max(120_000, runs(0) * 50);

/** Recompute the impulse simulate() applied for the picture and check the conservation laws. */
function expectMomentum(scene: Scene, rawRoads: RoadNetwork | null, sim: SimulationResult, label: string): void {
  const roads = rawRoads ? cleanNet(rawRoads) : null;
  const frame = roads?.frame ?? { origin: { lat: scene.location.lat, lon: scene.location.lon } };
  const placed = placeDetailed(scene, roads, toLocal(frame, scene.location), { checkClosing: false });
  if (!placed.ok) throw new Error(`${label}: placement differs from simulate()`);
  const { bodies, contacts } = placed.value;
  const mu = FRICTION[scene.road.condition];
  const entered = sim.vehicles.map((v) => v.speedAtImpactMps.mid);
  const { before, specs } = impactInput(bodies, contacts, entered, mu);
  const after = resolveContacts(before, specs, RESTITUTION, IMPACT_PASSES, CONTACT_FRICTION);
  // Tie the recomputation to the result: the same velocity change and spin for every vehicle in a contact.
  sim.vehicles.forEach((v, i) => {
    if (!v.impact) return;
    const dv = Math.hypot(after[i]!.velocityMps.x - before[i]!.velocityMps.x, after[i]!.velocityMps.y - before[i]!.velocityMps.y);
    expect(Math.abs(dv - v.impact.deltaVMps.mid), `${label} ${v.id} deltaV`).toBeLessThan(1e-9);
    expect(Math.abs(-after[i]!.spinRadPs - v.impact.spinRadps.mid), `${label} ${v.id} spin`).toBeLessThan(1e-9);
  });
  const t0 = totals(before), t1 = totals(after);
  expect(Math.abs(t1.px - t0.px), `${label} momentum x`).toBeLessThanOrEqual(REL * t0.pScale);
  expect(Math.abs(t1.py - t0.py), `${label} momentum y`).toBeLessThanOrEqual(REL * t0.pScale);
  expect(Math.abs(t1.L - t0.L), `${label} angular momentum`).toBeLessThanOrEqual(REL * t0.lScale);
  expect(t1.ke, `${label} kinetic energy`).toBeLessThanOrEqual(t0.ke * (1 + REL) + 1e-9);
}

/** No pass-through before the impact, and the touching pairs just touch at it. */
function expectNoPassThrough(sim: SimulationResult, label: string): void {
  const i0 = Math.round(-sim.startTimeS / sim.dtS);
  const vs = sim.vehicles;
  const touching = new Set(sim.gaps.map((g) => `${g.a}${g.b}`));
  for (let a = 0; a < vs.length; a++) {
    for (let b = a + 1; b < vs.length; b++) {
      const A = vs[a]!, B = vs[b]!;
      for (let i = 0; i < i0; i++) {
        const d = overlapDepth(cornersOf(A.track[i]!, A.lengthM, A.widthM), cornersOf(B.track[i]!, B.lengthM, B.widthM));
        if (d > OVERLAP_TOLERANCE_M) throw new Error(`${label}: ${A.id} and ${B.id} overlap by ${d.toFixed(3)} m at t = ${(sim.startTimeS + i * sim.dtS).toFixed(3)} s`);
      }
      const d0 = overlapDepth(cornersOf(A.impactPose, A.lengthM, A.widthM), cornersOf(B.impactPose, B.lengthM, B.widthM));
      if (touching.has(`${A.id}${B.id}`)) {
        expect(d0, `${label}: ${A.id}-${B.id} penetration at impact`).toBeLessThanOrEqual(0.005);
        expect(d0, `${label}: ${A.id}-${B.id} gap at impact`).toBeGreaterThanOrEqual(-0.02);
      } else {
        expect(d0, `${label}: ${A.id}-${B.id} (not in contact) overlap at impact`).toBeLessThanOrEqual(OVERLAP_TOLERANCE_M);
      }
    }
  }
}

/**
 * Slides end: after the impact each speed falls (never rises) from the first post-impact sample, the heading turns ever more
 * slowly in one direction (the spin decays to 0), the last samples are at rest, and a vehicle that has stopped stays put.
 */
function expectSlidesEnd(sim: SimulationResult, label: string): void {
  const i0 = Math.round(-sim.startTimeS / sim.dtS);
  const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
  for (const v of sim.vehicles) {
    const tr = v.track, n = tr.length;
    expect(n, `${label} ${v.id}: two samples at rest after the impact`).toBeGreaterThanOrEqual(i0 + 3);
    const last = tr[n - 1]!;
    expect(last.speedMps, `${label} ${v.id} rest speed`).toBe(0);
    expect(tr[n - 2], `${label} ${v.id} at rest`).toEqual(last);
    // Plain comparisons in the per-sample loop (expect() per sample is slow over thousands of scenes).
    const fail = (k: number, what: string) => { throw new Error(`${label} ${v.id}: ${what} at sample ${k} (t = ${(sim.startTimeS + k * sim.dtS).toFixed(4)} s)`); };
    const same = (p: Pose, q: Pose) => p.xM === q.xM && p.yM === q.yM && p.headingRad === q.headingRad && p.speedMps === q.speedMps;
    let prevTurn = Infinity, sign = 0, stoppedAt = -1;
    for (let k = i0 + 2; k < n; k++) {
      const a = tr[k - 1]!, b = tr[k]!;
      if (b.speedMps > a.speedMps + 1e-12) fail(k, `speed rises ${a.speedMps} -> ${b.speedMps}`);
      const turn = wrapPi(b.headingRad - a.headingRad);
      if (Math.abs(turn) > prevTurn + 1e-12) fail(k, `spin grows ${prevTurn} -> ${Math.abs(turn)} rad per step`);
      if (Math.abs(turn) > 1e-12) {
        if (sign !== 0 && Math.sign(turn) !== sign) fail(k, "spin changes sign");
        sign = Math.sign(turn);
      }
      prevTurn = Math.abs(turn);
      if (stoppedAt < 0 && b.speedMps === 0 && b.xM === a.xM && b.yM === a.yM && Math.abs(turn) <= 1e-12) stoppedAt = k;
      if (stoppedAt >= 0 && !same(b, tr[stoppedAt]!)) fail(k, `moves again after stopping at sample ${stoppedAt}`);
    }
  }
}

function expectWellFormed(sim: SimulationResult, label: string): void {
  assertAllFinite(sim, label);
  expectRangesOrdered(sim, label);
  for (const v of sim.vehicles) {
    expect(v.track.length, `${label} ${v.id} track`).toBeLessThanOrEqual(MAX_TRACK_SAMPLES);
    expect(v.track.length).toBe(Math.round((sim.restTimeS - sim.startTimeS) / sim.dtS) + 1);
  }
}

/** Total scenes over the parts (1,000 by default, FC_RUNS to change). */
const TOTAL = runs(1000);

/**
 * Register the property test for one part of the scenes: the suite runs in PARTS test files so vitest can run them in
 * parallel. Each part has its own seed (FC_SEED + part), so together they cover TOTAL different scenes.
 */
export function physicsProperties(part: number, parts: number): void {
const N = Math.ceil(TOTAL / parts);
describe(`physics properties over random valid scenes (part ${part + 1} of ${parts})`, () => {
  it(`hold for ${N} random scenes (2-4 vehicles, every type/action/zone/condition, known and "not sure" speeds, braking, real and synthetic roads, no roads)`, () => {
    const stats = { ok: 0, refused: 0, byEnv: new Map<string, number>(), multi: 0, unsure: 0, braking: 0, refusedCodes: new Map<string, number>() };
    fc.assert(fc.property(sceneCaseArb, ({ env, scene }) => {
      const label = `${env.name} ${JSON.stringify(scene.vehicles.map((v) => [v.type, v.action, v.travel.bearingDeg, v.travel.roadId, v.travel.lane, v.speed, v.braking, v.zone]))} ${scene.road.condition}`;
      const out = simulate(scene, env.roads);
      if (!out.ok) {
        stats.refused++;
        for (const e of out.errors) stats.refusedCodes.set(e.code, (stats.refusedCodes.get(e.code) ?? 0) + 1);
        expect(out.errors.length).toBeGreaterThan(0);
        expectPlainMessages(out.errors, ERROR_CODES, scene.vehicles.map((v) => v.id), label);
        // A valid scene is never refused because something threw inside the physics.
        expect(out.errors.map((e) => e.code), label).not.toContain("cannot-work-out");
        return;
      }
      stats.ok++;
      stats.byEnv.set(env.name, (stats.byEnv.get(env.name) ?? 0) + 1);
      if (scene.vehicles.length > 2) stats.multi++;
      if (scene.vehicles.some((v) => v.speed.kind === "unsure" && v.action !== "parked")) stats.unsure++;
      if (scene.vehicles.some((v) => v.braking && v.action !== "parked")) stats.braking++;
      const sim = out.result;
      expectPlainMessages(sim.warnings, WARNING_CODES, scene.vehicles.map((v) => v.id), label);
      expectWellFormed(sim, label);
      expectSpeedAtImpact(scene, sim, label);
      expectNoPassThrough(sim, label);
      expectSlidesEnd(sim, label);
      expectMomentum(scene, env.roads, sim, label);
      // Deterministic: the same input gives byte-identical canonical JSON.
      const again = simulate(scene, env.roads);
      expect(again.ok && canonicalJson(again.result) === canonicalJson(sim), `${label} deterministic`).toBe(true);
    }), { ...fcParams(N), seed: FC_SEED + part });
    report(`[physics properties, part ${part + 1}/${parts}] ${N} scenes: ${stats.ok} simulated, ${stats.refused} refused; by road data ${JSON.stringify([...stats.byEnv])}; ` +
      `3-4 vehicles ${stats.multi}, "not sure" ${stats.unsure}, braking ${stats.braking}; refusals ${JSON.stringify([...stats.refusedCodes])}`);
    // The generator must reach real coverage, not just refusals.
    expect(stats.ok).toBeGreaterThanOrEqual(N * 0.3);
    expect(stats.multi).toBeGreaterThan(0);
    expect(stats.unsure).toBeGreaterThan(0);
  }, FC_RUNS_TIMEOUT_MS);
});
}
