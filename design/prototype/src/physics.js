// Prototype physics: a deliberately simple, deterministic model so every
// number on screen and in the exports comes from the scene, not the design.
// SI units throughout. World frame: x east, y north, meters. Compass heading
// in degrees (0 = north, clockwise). The impact point is the origin.
// The real app replaces this module; the result shape is the data contract
// in DESIGN.md section 14.
import { PRESETS } from "./presets.js";

export const G = 9.81;
export const FRICTION = Object.freeze({ dry: 0.7, wet: 0.5, snow: 0.25, ice: 0.1 });
export const RESTITUTION = 0.2;          // simplified collision response
export const APPROACH_S = 2;             // window shown before impact
export const PHYSICS_VERSION = "0.1.0-prototype";   // stamped into every saved scene file
export const SCHEMA_VERSION = 2;
export const MPH_TO_MPS = 0.44704;
export const TURN_RADIUS_M = { left: 10, right: 6 };
export const DEFAULT_LIMIT_MPH = 25;     // used when the claimant doesn't know the limit
export const RANGE_HALF_MPH = 5;
const MPH = MPH_TO_MPS;

export const ZONES = ["front", "front-right", "right", "rear-right", "rear", "rear-left", "left", "front-left"];
export const ZONE_ANGLE = Object.freeze({ front: 0, "front-right": 45, right: 90, "rear-right": 135, rear: 180, "rear-left": 225, left: 270, "front-left": 315 });

const rad = (d) => (d * Math.PI) / 180;
const facing = (h) => ({ x: Math.sin(rad(h)), y: Math.cos(rad(h)) });
const rightOf = (f) => ({ x: f.y, y: -f.x });
const leftOf = (f) => ({ x: -f.y, y: f.x });
const add = (a, b, k = 1) => ({ x: a.x + b.x * k, y: a.y + b.y * k });
const len = (a) => Math.hypot(a.x, a.y);
const rot = (v, a) => ({ x: v.x * Math.cos(a) - v.y * Math.sin(a), y: v.x * Math.sin(a) + v.y * Math.cos(a) });

/** Speeds (mph) a vehicle is run at: one value, or low/middle/high for "not sure". */
export function speedCases(v) {
  if (v.action === "parked") return { lo: 0, mid: 0, hi: 0, unsure: false, limit: null };
  if (!v.unsure) return { lo: v.speedMph, mid: v.speedMph, hi: v.speedMph, unsure: false, limit: null };
  const limit = v.limitKnown ? v.limitMph : DEFAULT_LIMIT_MPH;
  return { lo: Math.max(0, limit - RANGE_HALF_MPH), mid: limit, hi: limit + RANGE_HALF_MPH, unsure: true, limit, limitAssumed: !v.limitKnown };
}

/** Travel direction unit vector (backing = opposite of facing). */
export function travelDir(v) {
  const f = facing(v.heading);
  return v.action === "backing" ? { x: -f.x, y: -f.y } : f;
}

function impactCenter(v, p) {
  const f = facing(v.heading), r = rightOf(f);
  const a = rad(ZONE_ANGLE[v.zone] ?? 0);
  // zone point on the body outline: middle of a side, or exactly a corner
  const c = Math.cos(a), sn = Math.sin(a);
  const fwd = Math.abs(c) < 0.3 ? 0 : Math.sign(c) * p.length.value / 2;
  const side = Math.abs(sn) < 0.3 ? 0 : Math.sign(sn) * p.width.value / 2;
  const offset = add({ x: f.x * fwd, y: f.y * fwd }, r, side);
  return { x: -offset.x, y: -offset.y };
}

/** Position and heading at s meters before impact along the approach path. */
function approachPose(v, center, s) {
  const f = facing(v.heading);
  if (v.action === "parked" || s <= 0) return { x: center.x, y: center.y, h: v.heading };
  if (v.action === "turn-left" || v.action === "turn-right") {
    const left = v.action === "turn-left";
    const R = left ? TURN_RADIUS_M.left : TURN_RADIUS_M.right;
    const c = add(center, left ? leftOf(f) : rightOf(f), R);
    const phi = Math.min(s / R, Math.PI / 2);
    const rel = rot({ x: center.x - c.x, y: center.y - c.y }, left ? -phi : phi);
    const pos = add(c, rel);
    const h = v.heading + (left ? 1 : -1) * (phi * 180) / Math.PI;
    const rest = s - phi * R;
    if (rest <= 0) return { x: pos.x, y: pos.y, h };
    const fs = facing(h);
    return { x: pos.x - fs.x * rest, y: pos.y - fs.y * rest, h };
  }
  const u = travelDir(v);
  return { x: center.x - u.x * s, y: center.y - u.y * s, h: v.heading };
}

/** One deterministic run at the given speeds (mph per vehicle id). */
function run(scene, mphById) {
  const mu = FRICTION[scene.road.condition] ?? FRICTION.dry;
  const decel = mu * G;
  const vs = scene.vehicles.map((v) => {
    const p = PRESETS[v.type] || PRESETS.car;
    const speed = (mphById[v.id] || 0) * MPH;
    const u = travelDir(v);
    const center = impactCenter(v, p);
    return { v, p, mass: p.mass.value, speed, vel: { x: u.x * speed, y: u.y * speed }, center };
  });
  const M = vs.reduce((s, o) => s + o.mass, 0);
  const vcm = vs.reduce((acc, o) => add(acc, o.vel, o.mass / M), { x: 0, y: 0 });
  let restTime = 0;
  const out = vs.map((o) => {
    const post = { x: vcm.x - RESTITUTION * (o.vel.x - vcm.x), y: vcm.y - RESTITUTION * (o.vel.y - vcm.y) };
    const sp = len(post);
    const tStop = sp / decel;
    const dist = (sp * sp) / (2 * decel);
    const dir = sp > 1e-6 ? { x: post.x / sp, y: post.y / sp } : { x: 0, y: 0 };
    const dv = { x: post.x - o.vel.x, y: post.y - o.vel.y };
    const lever = { x: -o.center.x, y: -o.center.y };
    const cross = lever.x * dv.y - lever.y * dv.x;
    const yaw = -Math.max(-40, Math.min(40, cross * 2.5));
    restTime = Math.max(restTime, tStop);
    const restPose = { x: o.center.x + dir.x * dist, y: o.center.y + dir.y * dist, h: o.v.heading + yaw };
    return {
      id: o.v.id, type: o.v.type, mass_kg: o.mass, length_m: o.p.length.value, width_m: o.p.width.value,
      speedAtImpact_mps: o.speed, approachDistance_m: o.speed * APPROACH_S,
      postImpactSpeed_mps: sp, postImpactDistance_m: dist, slideTime_s: tStop,
      impactPose: { x: o.center.x, y: o.center.y, h: o.v.heading }, restPose, dir, yaw, decel,
      vehicle: o.v,
    };
  });
  const gaps = [];
  for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) {
    gaps.push({ a: out[i].id, b: out[j].id, restGap_m: len({ x: out[i].restPose.x - out[j].restPose.x, y: out[i].restPose.y - out[j].restPose.y }) });
  }
  return { friction: mu, vehicles: out, gaps, impactTime_s: 0, restTime_s: Math.max(restTime, 0.6) };
}

/** Pose of one vehicle at time t (s, 0 = impact) in a run. */
export function poseAt(rv, t) {
  if (t <= 0) {
    const p = approachPose(rv.vehicle, rv.impactPose, rv.speedAtImpact_mps * -t);
    return { ...p, speed_mps: rv.speedAtImpact_mps };
  }
  const tt = Math.min(t, rv.slideTime_s);
  const sp = rv.postImpactSpeed_mps;
  const s = sp * tt - 0.5 * rv.decel * tt * tt;
  const frac = rv.postImpactDistance_m > 1e-6 ? s / rv.postImpactDistance_m : 1;
  return {
    x: rv.impactPose.x + rv.dir.x * s, y: rv.impactPose.y + rv.dir.y * s,
    h: rv.impactPose.h + rv.yaw * frac, speed_mps: Math.max(0, sp - rv.decel * tt),
  };
}

/**
 * Simulate the scene. With any "not sure" speed, runs low, middle and high
 * (all uncertain vehicles together) and reports min–max ranges; the picture
 * plays the middle run.
 */
export function simulate(scene) {
  const cases = Object.fromEntries(scene.vehicles.map((v) => [v.id, speedCases(v)]));
  const anyUnsure = Object.values(cases).some((c) => c.unsure);
  const pick = (k) => Object.fromEntries(Object.entries(cases).map(([id, c]) => [id, c[k]]));
  const mid = run(scene, pick("mid"));
  const runs = anyUnsure ? [run(scene, pick("lo")), mid, run(scene, pick("hi"))] : [mid];
  const range = (get) => { const xs = runs.map(get); return { lo: Math.min(...xs), mid: get(mid), hi: Math.max(...xs) }; };
  return {
    friction: mid.friction,
    restitution: RESTITUTION,
    approach_s: APPROACH_S,
    impactTime_s: 0,
    restTime_s: mid.restTime_s,
    cases,
    middle: mid,
    vehicles: mid.vehicles.map((rv, i) => ({
      id: rv.id,
      speedAtImpact_mps: range((r) => r.vehicles[i].speedAtImpact_mps),
      approachDistance_m: range((r) => r.vehicles[i].approachDistance_m),
      postImpactDistance_m: range((r) => r.vehicles[i].postImpactDistance_m),
      restPose: rv.restPose,
      impactPose: rv.impactPose,
      mass_kg: rv.mass_kg,
    })),
    gaps: mid.gaps.map((g, i) => ({ a: g.a, b: g.b, restGap_m: range((r) => r.gaps[i].restGap_m) })),
  };
}
