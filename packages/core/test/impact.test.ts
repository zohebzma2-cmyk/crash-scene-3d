// The two pure building blocks of the collision model: the planar impulse and the friction slide.
// Math frame here: x east, y north, spin counter-clockwise positive (see physics/impact.ts).
import { describe, expect, it } from "vitest";
import { CONTACT_FRICTION, FRICTION, G_MPS2, PRESETS, RESTITUTION, resolveImpact, slideToRest } from "../src";
import type { Body2D, SlideState, Vec2 } from "../src";
import { dist, dot, sub } from "./physics-helpers";

const cross = (a: Vec2, b: Vec2) => a.x * b.y - a.y * b.x;
const speed = (v: Vec2) => Math.hypot(v.x, v.y);

/** Impulse formula written out independently, from the plan. */
function expectedJ(a: Body2D, b: Body2D, point: Vec2, n: Vec2, e: number): number {
  const ra = sub(point, a.centreM), rb = sub(point, b.centreM);
  // r is measured from the centre of mass to the contact point.
  const va = { x: a.velocityMps.x - a.spinRadPs * ra.y, y: a.velocityMps.y + a.spinRadPs * ra.x };
  const vb = { x: b.velocityMps.x - b.spinRadPs * rb.y, y: b.velocityMps.y + b.spinRadPs * rb.x };
  const vRelN = dot(sub(va, vb), n);
  const den = 1 / a.massKg + 1 / b.massKg + cross(ra, n) ** 2 / a.inertiaKgM2 + cross(rb, n) ** 2 / b.inertiaKgM2;
  return -(1 + e) * vRelN / den;
}

const linearMomentum = (...bs: Body2D[]): Vec2 => ({ x: bs.reduce((s, b) => s + b.massKg * b.velocityMps.x, 0), y: bs.reduce((s, b) => s + b.massKg * b.velocityMps.y, 0) });
/** Angular momentum about `point`: spin part plus orbital part. */
const angularMomentum = (point: Vec2, ...bs: Body2D[]): number =>
  bs.reduce((s, b) => s + b.inertiaKgM2 * b.spinRadPs + b.massKg * cross(sub(b.centreM, point), b.velocityMps), 0);
const kinetic = (...bs: Body2D[]): number => bs.reduce((s, b) => s + 0.5 * b.massKg * speed(b.velocityMps) ** 2 + 0.5 * b.inertiaKgM2 * b.spinRadPs ** 2, 0);

// A car (heading east, hit on its left... any numbers will do) and an SUV, off-centre contact, both spinning a little.
const carA: Body2D = { massKg: 1610, inertiaKgM2: (1610 * (4.8 ** 2 + 1.85 ** 2)) / 12, centreM: { x: 0.9, y: 0.4 }, velocityMps: { x: 1.5, y: 11.2 }, spinRadPs: 0.3 };
const suvB: Body2D = { massKg: 2064, inertiaKgM2: (2064 * (4.85 ** 2 + 1.95 ** 2)) / 12, centreM: { x: -2.4, y: -0.3 }, velocityMps: { x: 8.9, y: 0.7 }, spinRadPs: -0.1 };
const POINT: Vec2 = { x: 0, y: 0 };
const NORMAL: Vec2 = { x: 1, y: 0 }; // from b into a: a is east of b

describe("resolveImpact: normal impulse (contact friction 0), the 1-D and central cases", () => {
  it("applies J = -(1+e)(v_rel . n) / (1/m1 + 1/m2 + (r1 x n)^2/I1 + (r2 x n)^2/I2)", () => {
    const r = resolveImpact(carA, suvB, POINT, NORMAL, RESTITUTION, 0);
    const J = expectedJ(carA, suvB, POINT, NORMAL, RESTITUTION);
    expect(J).toBeGreaterThan(0);
    expect(r.impulseNs).toBeCloseTo(J, 6);
    // Linear velocity changes by J n / m (a gains it, b loses it): nothing along the tangent.
    expect(r.a.velocityMps.x - carA.velocityMps.x).toBeCloseTo(J / carA.massKg, 9);
    expect(r.a.velocityMps.y - carA.velocityMps.y).toBeCloseTo(0, 9);
    expect(r.b.velocityMps.x - suvB.velocityMps.x).toBeCloseTo(-J / suvB.massKg, 9);
    expect(r.b.velocityMps.y - suvB.velocityMps.y).toBeCloseTo(0, 9);
  });

  it("changes spin by (r x J n) / I", () => {
    const r = resolveImpact(carA, suvB, POINT, NORMAL, RESTITUTION, 0);
    const J = expectedJ(carA, suvB, POINT, NORMAL, RESTITUTION);
    const ra = sub(POINT, carA.centreM), rb = sub(POINT, suvB.centreM);
    expect(r.a.spinRadPs - carA.spinRadPs).toBeCloseTo(cross(ra, { x: J, y: 0 }) / carA.inertiaKgM2, 9);
    expect(r.b.spinRadPs - suvB.spinRadPs).toBeCloseTo(-cross(rb, { x: J, y: 0 }) / suvB.inertiaKgM2, 9);
  });

  it("conserves total linear momentum and angular momentum about the impact point (1e-6 relative)", () => {
    const r = resolveImpact(carA, suvB, POINT, NORMAL, RESTITUTION);
    const p0 = linearMomentum(carA, suvB), p1 = linearMomentum(r.a, r.b);
    const pScale = carA.massKg * speed(carA.velocityMps) + suvB.massKg * speed(suvB.velocityMps);
    expect(Math.abs(p1.x - p0.x) / pScale).toBeLessThan(1e-6);
    expect(Math.abs(p1.y - p0.y) / pScale).toBeLessThan(1e-6);
    const l0 = angularMomentum(POINT, carA, suvB), l1 = angularMomentum(POINT, r.a, r.b);
    const lScale = [carA, suvB].reduce((s, b) => s + Math.abs(b.inertiaKgM2 * b.spinRadPs) + Math.abs(b.massKg * cross(sub(b.centreM, POINT), b.velocityMps)), 0);
    expect(lScale).toBeGreaterThan(0);
    expect(Math.abs(l1 - l0) / lScale).toBeLessThan(1e-6);
  });

  it("gives the contact points a normal separation speed of e times their closing speed", () => {
    const r = resolveImpact(carA, suvB, POINT, NORMAL, RESTITUTION);
    const contactV = (b: Body2D): Vec2 => {
      const rr = sub(POINT, b.centreM);
      return { x: b.velocityMps.x - b.spinRadPs * rr.y, y: b.velocityMps.y + b.spinRadPs * rr.x };
    };
    const before = dot(sub(contactV(carA), contactV(suvB)), NORMAL);
    const after = dot(sub(contactV(r.a), contactV(r.b)), NORMAL);
    expect(before).toBeLessThan(0);
    expect(after).toBeCloseTo(-RESTITUTION * before, 9);
  });

  it("never adds kinetic energy", () => {
    const r = resolveImpact(carA, suvB, POINT, NORMAL, RESTITUTION);
    expect(kinetic(r.a, r.b)).toBeLessThan(kinetic(carA, suvB));
  });

  it("reduces to the 1-D formula when the line of impact passes through both centres", () => {
    const a: Body2D = { massKg: 1600, inertiaKgM2: 2500, centreM: { x: 1, y: 0 }, velocityMps: { x: 0, y: 0 }, spinRadPs: 0 };
    const b: Body2D = { massKg: 2000, inertiaKgM2: 3500, centreM: { x: -1, y: 0 }, velocityMps: { x: 9, y: 0 }, spinRadPs: 0 };
    const r = resolveImpact(a, b, POINT, NORMAL, RESTITUTION);
    const e = RESTITUTION, m1 = a.massKg, m2 = b.massKg;
    expect(r.a.velocityMps.x).toBeCloseTo((m1 * 0 + m2 * 9 + m2 * e * (9 - 0)) / (m1 + m2), 9);
    expect(r.b.velocityMps.x).toBeCloseTo((m1 * 0 + m2 * 9 + m1 * e * (0 - 9)) / (m1 + m2), 9);
    expect(r.a.spinRadPs).toBeCloseTo(0, 12);
    expect(r.b.spinRadPs).toBeCloseTo(0, 12);
  });

  it("does nothing to bodies that are already separating", () => {
    const apart: Body2D = { ...suvB, velocityMps: { x: -3, y: 0 }, spinRadPs: 0 };
    const a: Body2D = { ...carA, velocityMps: { x: 3, y: 0 }, spinRadPs: 0, centreM: { x: 1, y: 0 } };
    const r = resolveImpact(a, { ...apart, centreM: { x: -1, y: 0 } }, POINT, NORMAL, RESTITUTION);
    expect(r.impulseNs).toBe(0);
    expect(r.a).toEqual(a);
    expect(r.b.velocityMps).toEqual({ x: -3, y: 0 });
  });

  it("is deterministic", () => {
    expect(resolveImpact(carA, suvB, POINT, NORMAL, RESTITUTION)).toEqual(resolveImpact(carA, suvB, POINT, NORMAL, RESTITUTION));
  });
});

describe("slideToRest: friction slide at mu * g with the yaw rate decaying to zero", () => {
  const DT = 1 / 120;
  const start = (v: number, spin = 0): SlideState => ({ positionM: { x: 3, y: -2 }, velocityMps: { x: 0.6 * v, y: 0.8 * v }, headingRad: 0.5, spinRadPs: spin });

  it("stops a vehicle alone at v on dry in v^2 / (2 * 0.7 * g)", () => {
    const v = 13.4112;
    const run = slideToRest(start(v), FRICTION.dry, DT);
    const want = (v * v) / (2 * 0.7 * G_MPS2);
    expect(Math.abs(run.distanceM - want) / want).toBeLessThan(0.01);
    const last = run.samples[run.samples.length - 1]!;
    expect(dist(last.positionM, run.samples[0]!.positionM)).toBeCloseTo(run.distanceM, 6);
    expect(Math.abs(run.restTimeS - v / (0.7 * G_MPS2))).toBeLessThan(2 * DT);
  });

  it("slides farther on slick roads, by exactly mu: wet 0.5, snow 0.25, ice 0.1", () => {
    const v = 10;
    for (const [cond, mu] of [["dry", 0.7], ["wet", 0.5], ["snow", 0.25], ["ice", 0.1]] as const) {
      expect(FRICTION[cond]).toBe(mu);
      const run = slideToRest(start(v), mu, DT);
      const want = (v * v) / (2 * mu * G_MPS2);
      expect(Math.abs(run.distanceM - want) / want, cond).toBeLessThan(0.01);
    }
  });

  it("slides along the direction of the initial velocity, never backwards, ending at rest", () => {
    const v = 12;
    const run = slideToRest(start(v), FRICTION.wet, DT);
    const dir = { x: 0.6, y: 0.8 };
    let lastAlong = -Infinity, lastSpeed = Infinity;
    for (const s of run.samples) {
      const along = dot(sub(s.positionM, run.samples[0]!.positionM), dir);
      expect(along).toBeGreaterThanOrEqual(lastAlong - 1e-9);
      const perp = Math.abs(cross(sub(s.positionM, run.samples[0]!.positionM), dir));
      expect(perp).toBeLessThan(1e-6);
      const sp = speed(s.velocityMps);
      expect(sp).toBeLessThanOrEqual(lastSpeed + 1e-9);
      lastAlong = along; lastSpeed = sp;
    }
    const end = run.samples[run.samples.length - 1]!;
    expect(speed(end.velocityMps)).toBe(0);
    expect(end.spinRadPs).toBe(0);
  });

  it("starts from the given state at t = 0", () => {
    const s0 = start(9, 1.2);
    const run = slideToRest(s0, FRICTION.dry, DT);
    expect(run.samples[0]!.positionM).toEqual(s0.positionM);
    expect(run.samples[0]!.velocityMps).toEqual(s0.velocityMps);
    expect(run.samples[0]!.headingRad).toBe(s0.headingRad);
    expect(run.samples[0]!.spinRadPs).toBe(s0.spinRadPs);
  });

  it("decays the yaw rate to zero without reversing it, and turns the vehicle the way it was spinning", () => {
    for (const spin of [2.5, -2.5]) {
      const run = slideToRest(start(14, spin), FRICTION.dry, DT);
      let prev = Math.abs(spin);
      for (const s of run.samples) {
        expect(Math.abs(s.spinRadPs)).toBeLessThanOrEqual(prev + 1e-12);
        expect(Math.sign(s.spinRadPs) * Math.sign(spin)).toBeGreaterThanOrEqual(0);
        prev = Math.abs(s.spinRadPs);
      }
      const end = run.samples[run.samples.length - 1]!;
      expect(end.spinRadPs).toBe(0);
      // Counter-clockwise spin lowers the compass heading; clockwise raises it.
      let turn = 0;
      for (let i = 1; i < run.samples.length; i++) {
        turn += Math.atan2(Math.sin(run.samples[i]!.headingRad - run.samples[i - 1]!.headingRad), Math.cos(run.samples[i]!.headingRad - run.samples[i - 1]!.headingRad));
      }
      expect(Math.sign(turn)).toBe(-Math.sign(spin));
      expect(Math.abs(turn)).toBeGreaterThan(0.05);
      // And it stops turning no later than it stops moving (one step of slack).
      const firstZero = run.samples.findIndex((s) => s.spinRadPs === 0);
      expect(firstZero).toBeGreaterThanOrEqual(0);
      expect(firstZero * DT).toBeLessThanOrEqual(run.restTimeS + DT);
    }
  });

  it("does not move a body that starts at rest", () => {
    const run = slideToRest({ positionM: { x: 1, y: 2 }, velocityMps: { x: 0, y: 0 }, headingRad: 1, spinRadPs: 0 }, FRICTION.dry, DT);
    expect(run.distanceM).toBe(0);
    expect(run.restTimeS).toBe(0);
    expect(run.samples[run.samples.length - 1]!.positionM).toEqual({ x: 1, y: 2 });
  });

  it("is deterministic", () => {
    expect(slideToRest(start(11, 1), FRICTION.snow, DT)).toEqual(slideToRest(start(11, 1), FRICTION.snow, DT));
  });
});

// ---------------------------------------------------------------- contact friction (Brach planar impact, impulse ratio capped at CONTACT_FRICTION)

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Case { readonly a: Body2D; readonly b: Body2D; readonly point: Vec2; readonly n: Vec2; readonly e: number }

/** Random closing contacts: masses, sizes, positions, spins and the normal all random; the contact point is on a's boundary-ish. */
function randomCases(count: number, seed: number): Case[] {
  const rnd = mulberry32(seed);
  const between = (lo: number, hi: number) => lo + (hi - lo) * rnd();
  const out: Case[] = [];
  while (out.length < count) {
    const body = (cx: number, cy: number): Body2D => {
      const m = between(300, 9000), L = between(1.8, 8), W = between(0.7, 2.6);
      return { massKg: m, inertiaKgM2: (m * (L * L + W * W)) / 12, centreM: { x: cx + between(-2.5, 2.5), y: cy + between(-2.5, 2.5) }, velocityMps: { x: between(-20, 20), y: between(-20, 20) }, spinRadPs: between(-1.5, 1.5) };
    };
    const a = body(2, 0), b = body(-2, 0);
    const ang = between(0, 2 * Math.PI);
    const n = { x: Math.cos(ang), y: Math.sin(ang) };
    const point = { x: between(-1.5, 1.5), y: between(-1.5, 1.5) };
    const r = resolveImpact(a, b, point, n, 0.2, 0);
    if (r.impulseNs > 0) out.push({ a, b, point, n, e: between(0, 1) });
  }
  return out;
}

const contactVel = (b: Body2D, p: Vec2): Vec2 => {
  const r = sub(p, b.centreM);
  return { x: b.velocityMps.x - b.spinRadPs * r.y, y: b.velocityMps.y + b.spinRadPs * r.x };
};

describe("resolveImpact: with contact friction (Brach planar impact)", () => {
  const FRICTIONS = [0, 0.3, CONTACT_FRICTION, 2];

  it("CONTACT_FRICTION is 0.5", () => {
    expect(CONTACT_FRICTION).toBe(0.5);
  });

  it("with friction 0 it is exactly the normal-only impulse, for random off-centre hits", () => {
    for (const c of randomCases(200, 11)) {
      const r = resolveImpact(c.a, c.b, c.point, c.n, c.e, 0);
      const J = expectedJ(c.a, c.b, c.point, c.n, c.e);
      expect(r.impulseNs).toBeCloseTo(J, 6);
      expect(r.tangentialImpulseNs).toBe(0);
      expect(r.a.velocityMps.x - c.a.velocityMps.x).toBeCloseTo((J * c.n.x) / c.a.massKg, 9);
      expect(r.a.velocityMps.y - c.a.velocityMps.y).toBeCloseTo((J * c.n.y) / c.a.massKg, 9);
      expect(r.b.velocityMps.x - c.b.velocityMps.x).toBeCloseTo((-J * c.n.x) / c.b.massKg, 9);
    }
  });

  it("a central hit with no slip needs no tangential impulse, whatever the friction", () => {
    const a: Body2D = { massKg: 1600, inertiaKgM2: 2500, centreM: { x: 1, y: 0 }, velocityMps: { x: 0, y: 0 }, spinRadPs: 0 };
    const b: Body2D = { massKg: 2000, inertiaKgM2: 3500, centreM: { x: -1, y: 0 }, velocityMps: { x: 9, y: 0 }, spinRadPs: 0 };
    const none = resolveImpact(a, b, POINT, NORMAL, RESTITUTION, 0);
    const some = resolveImpact(a, b, POINT, NORMAL, RESTITUTION, CONTACT_FRICTION);
    expect(some.tangentialImpulseNs).toBeCloseTo(0, 9);
    expect(some.impulseNs).toBeCloseTo(none.impulseNs, 9);
    expect(some.a.velocityMps.x).toBeCloseTo(none.a.velocityMps.x, 9);
    expect(some.b.spinRadPs).toBeCloseTo(0, 12);
  });

  it("keeps linear and angular momentum (about any point) and never adds kinetic energy, at every friction", () => {
    const rnd = mulberry32(5);
    for (const mu of FRICTIONS) {
      for (const c of randomCases(250, 100 + Math.round(mu * 10))) {
        const r = resolveImpact(c.a, c.b, c.point, c.n, c.e, mu);
        const about = { x: (rnd() - 0.5) * 20, y: (rnd() - 0.5) * 20 };
        const p0 = linearMomentum(c.a, c.b), p1 = linearMomentum(r.a, r.b);
        const pScale = c.a.massKg * speed(c.a.velocityMps) + c.b.massKg * speed(c.b.velocityMps);
        expect(Math.abs(p1.x - p0.x) / pScale).toBeLessThan(1e-9);
        expect(Math.abs(p1.y - p0.y) / pScale).toBeLessThan(1e-9);
        const l0 = angularMomentum(about, c.a, c.b), l1 = angularMomentum(about, r.a, r.b);
        const lScale = [c.a, c.b].reduce((s, b) => s + Math.abs(b.inertiaKgM2 * b.spinRadPs) + Math.abs(b.massKg * cross(sub(b.centreM, about), b.velocityMps)), 0);
        expect(Math.abs(l1 - l0) / lScale).toBeLessThan(1e-9);
        expect(kinetic(r.a, r.b)).toBeLessThanOrEqual(kinetic(c.a, c.b) * (1 + 1e-12));
      }
    }
  });

  it("never lets the contact points close faster than they separate: v_n after >= -e * v_n before... or exactly that when the energy guard is idle", () => {
    for (const mu of FRICTIONS) {
      for (const c of randomCases(250, 300 + Math.round(mu * 10))) {
        const r = resolveImpact(c.a, c.b, c.point, c.n, c.e, mu);
        const before = dot(sub(contactVel(c.a, c.point), contactVel(c.b, c.point)), c.n);
        const after = dot(sub(contactVel(r.a, c.point), contactVel(r.b, c.point)), c.n);
        expect(after).toBeGreaterThan(-1e-9); // always separating
        if (kinetic(r.a, r.b) < kinetic(c.a, c.b) * (1 - 1e-6)) expect(after).toBeCloseTo(-c.e * before, 6); // guard idle: exact Newton restitution
      }
    }
  });

  it("cap: the tangential impulse never exceeds friction x the normal impulse, and it opposes the slip", () => {
    for (const mu of FRICTIONS) {
      for (const c of randomCases(250, 500 + Math.round(mu * 10))) {
        const r = resolveImpact(c.a, c.b, c.point, c.n, c.e, mu);
        expect(Math.abs(r.tangentialImpulseNs)).toBeLessThanOrEqual(mu * r.impulseNs * (1 + 1e-9) + 1e-9);
        const t = { x: -c.n.y, y: c.n.x };
        const vt = dot(sub(contactVel(c.a, c.point), contactVel(c.b, c.point)), t);
        if (r.mode === "slide" && Math.abs(vt) > 1e-9) expect(r.tangentialImpulseNs * vt).toBeLessThanOrEqual(1e-9); // sliding friction pulls against the slip
      }
    }
  });

  it("stick: when the cap is not reached, the contact points leave with no relative slip", () => {
    let stuck = 0, slid = 0;
    for (const c of randomCases(400, 700)) {
      const r = resolveImpact(c.a, c.b, c.point, c.n, c.e, 2);
      if (r.mode !== "stick") continue;
      const t = { x: -c.n.y, y: c.n.x };
      const after = dot(sub(contactVel(r.a, c.point), contactVel(r.b, c.point)), t);
      // exact unless the energy guard scaled the impulse back; then the energy sits right at its starting value
      if (Math.abs(after) > 1e-6) expect(Math.abs(kinetic(r.a, r.b) / kinetic(c.a, c.b) - 1)).toBeLessThan(1e-6);
      else stuck++;
      expect(Math.abs(r.tangentialImpulseNs)).toBeLessThanOrEqual(2 * r.impulseNs * (1 + 1e-9));
    }
    for (const c of randomCases(400, 701)) if (resolveImpact(c.a, c.b, c.point, c.n, c.e, 0.05).mode === "slide") slid++;
    expect(stuck).toBeGreaterThan(100); // most hits grip when the cap is loose
    expect(slid).toBeGreaterThan(50); // and most hits with a tiny cap slide at the cap
  });

  it("slide: when the cap binds, the impulse is exactly friction x the normal impulse and pulls against the slip", () => {
    let checked = 0;
    for (const c of randomCases(400, 800)) {
      const mu = 0.05;
      const r = resolveImpact(c.a, c.b, c.point, c.n, c.e, mu);
      if (r.mode !== "slide" || kinetic(r.a, r.b) > kinetic(c.a, c.b) * (1 - 1e-6)) continue; // (skip the rare hits where the energy guard scaled the impulse back)
      const t = { x: -c.n.y, y: c.n.x };
      const vt0 = dot(sub(contactVel(c.a, c.point), contactVel(c.b, c.point)), t);
      if (Math.abs(r.tangentialImpulseNs) > 0) expect(Math.abs(Math.abs(r.tangentialImpulseNs) - mu * r.impulseNs)).toBeLessThan(1e-6 * r.impulseNs);
      expect(r.tangentialImpulseNs * vt0).toBeLessThanOrEqual(0); // the friction pulls against the slip
      checked++;
    }
    expect(checked).toBeGreaterThan(50);
  });

  it("the energy guard: a strongly coupled hit (a spinning-dominated body against a wall) ends with no more energy than it started with", () => {
    // Light-in-yaw car hitting a near-immovable wall at an off-centre point: normal and tangential responses are almost the same direction.
    const a0: Body2D = { massKg: 1500, inertiaKgM2: 15, centreM: { x: 0, y: 0 }, velocityMps: { x: 0, y: 0 }, spinRadPs: 0 };
    const wall: Body2D = { massKg: 1e12, inertiaKgM2: 1e15, centreM: { x: 10, y: 0 }, velocityMps: { x: 0, y: 0 }, spinRadPs: 0 };
    const point = { x: 1.2, y: 1.1 };
    const n = { x: -1, y: 0 }; // from the wall into a
    const t = { x: 0, y: -1 };
    const pa = { x: -(point.y - a0.centreM.y), y: point.x - a0.centreM.x };
    const knn = 1 / a0.massKg + dot(pa, n) ** 2 / a0.inertiaKgM2, ktt = 1 / a0.massKg + dot(pa, t) ** 2 / a0.inertiaKgM2, knt = (dot(pa, n) * dot(pa, t)) / a0.inertiaKgM2;
    expect(knt ** 2 / (knn * ktt)).toBeGreaterThan(0.96);
    // The closing velocity that makes gripping add the most energy: the slip is K_nt / K_nn times the closing speed. Closing speed 5 m/s.
    const vn = -5, vt = (knt / knn) * vn;
    const a: Body2D = { ...a0, velocityMps: { x: vn * n.x + vt * t.x, y: vn * n.y + vt * t.y } };
    const r = resolveImpact(a, wall, point, n, 0.2, 5);
    expect(r.impulseNs).toBeGreaterThan(0);
    expect(kinetic(r.a, r.b)).toBeLessThanOrEqual(kinetic(a, wall) * (1 + 1e-12));
    expect(kinetic(r.a, r.b) / kinetic(a, wall)).toBeGreaterThan(0.999999); // the guard is what held the energy level (an unguarded grip would add energy)
    const unguarded = resolveImpact(a, wall, point, n, 0.2, 0);
    expect(Number.isFinite(r.a.spinRadPs) && Number.isFinite(unguarded.a.spinRadPs)).toBe(true);
  });

  it("is deterministic, and returns the tangential impulse and mode", () => {
    const r = resolveImpact(carA, suvB, POINT, NORMAL, RESTITUTION);
    expect(r).toEqual(resolveImpact(carA, suvB, POINT, NORMAL, RESTITUTION));
    expect(["stick", "slide"]).toContain(r.mode);
    expect(resolveImpact(carA, { ...suvB, velocityMps: { x: -9, y: 0 }, spinRadPs: 0 }, POINT, NORMAL, RESTITUTION).mode).toBe("none");
  });

  it("T-bone numbers by hand: the sticking tangential impulse is v_t / K_tt, A's forward speed drops and both vehicles turn", () => {
    // A (car) heading north with the contact at the middle of its left side; B (SUV) heading east, hitting with its nose.
    const car = PRESETS.car, suv = PRESETS.suv;
    const W_A = 1.85, L_B = 4.85;
    const a: Body2D = { massKg: car.mass.value, inertiaKgM2: (car.mass.value * (4.8 ** 2 + W_A ** 2)) / 12, centreM: { x: 0.925, y: 0 }, velocityMps: { x: 0, y: 11.176 }, spinRadPs: 0 };
    const b: Body2D = { massKg: suv.mass.value, inertiaKgM2: (suv.mass.value * (L_B ** 2 + 1.95 ** 2)) / 12, centreM: { x: -2.425, y: 0 }, velocityMps: { x: 11.176, y: 0 }, spinRadPs: 0 };
    const r = resolveImpact(a, b, { x: 0, y: 0 }, { x: 1, y: 0 }, RESTITUTION);
    const ktt = 1 / a.massKg + 1 / b.massKg + (W_A / 2) ** 2 / a.inertiaKgM2 + (L_B / 2) ** 2 / b.inertiaKgM2;
    expect(r.mode).toBe("stick");
    expect(Math.abs(r.tangentialImpulseNs)).toBeCloseTo(11.176 / ktt, 3);
    expect(r.a.velocityMps.y).toBeLessThan(11.176); // A's own forward speed is cut
    expect(r.b.velocityMps.y).toBeGreaterThan(0); // B is dragged along A's way (north)
    expect(r.b.velocityMps.y).toBeCloseTo(-r.tangentialImpulseNs / b.massKg, 6);
    expect(r.a.spinRadPs).not.toBe(0);
    expect(r.b.spinRadPs).not.toBe(0);
  });
});

describe("resolveImpact: the sliding branch, Coulomb check", () => {
  it("when the normal passes through both centres (no coupling) a capped slide never reverses the slip, and friction opposes it", () => {
    let checked = 0;
    for (const c of randomCases(300, 900)) {
      // Put the contact point on the line through both centres along the normal: the lever arms are parallel to n.
      const n = c.n;
      const a: Body2D = { ...c.a, centreM: { x: n.x * 1.2, y: n.y * 1.2 }, spinRadPs: 0 };
      const b: Body2D = { ...c.b, centreM: { x: -n.x * 1.5, y: -n.y * 1.5 }, spinRadPs: 0 };
      const point = { x: 0, y: 0 };
      const mu = 0.05;
      const r = resolveImpact(a, b, point, n, c.e, mu);
      if (r.impulseNs === 0 || r.mode !== "slide") continue;
      const t = { x: -n.y, y: n.x };
      const vt0 = dot(sub(contactVel(a, point), contactVel(b, point)), t);
      const vt1 = dot(sub(contactVel(r.a, point), contactVel(r.b, point)), t);
      expect(vt1 * vt0).toBeGreaterThanOrEqual(-1e-9); // the slip is slowed, never reversed
      expect(r.tangentialImpulseNs * vt0).toBeLessThanOrEqual(1e-9);
      checked++;
    }
    expect(checked).toBeGreaterThan(40);
  });

  it("in coupled corner hits the slip can pass through zero because of the normal impulse; it stays energy-safe and conserves momentum", () => {
    let reversed = 0, total = 0;
    for (const c of randomCases(600, 910)) {
      const r = resolveImpact(c.a, c.b, c.point, c.n, c.e, 0.05);
      if (r.mode !== "slide") continue;
      total++;
      const t = { x: -c.n.y, y: c.n.x };
      const vt0 = dot(sub(contactVel(c.a, c.point), contactVel(c.b, c.point)), t);
      const vt1 = dot(sub(contactVel(r.a, c.point), contactVel(r.b, c.point)), t);
      if (vt0 * vt1 < 0) reversed++;
      expect(kinetic(r.a, r.b)).toBeLessThanOrEqual(kinetic(c.a, c.b) * (1 + 1e-12));
    }
    expect(total).toBeGreaterThan(100);
    // The same hits with no friction at all reverse the slip about as often: the reversal is the normal impulse's, not the friction's.
    let reversedFrictionless = 0;
    for (const c of randomCases(600, 910)) {
      const r = resolveImpact(c.a, c.b, c.point, c.n, c.e, 0);
      const t = { x: -c.n.y, y: c.n.x };
      const vt0 = dot(sub(contactVel(c.a, c.point), contactVel(c.b, c.point)), t);
      const vt1 = dot(sub(contactVel(r.a, c.point), contactVel(r.b, c.point)), t);
      if (vt0 * vt1 < 0) reversedFrictionless++;
    }
    expect(reversed).toBeGreaterThan(0);
    expect(reversedFrictionless).toBeGreaterThan(0);
  });
});
