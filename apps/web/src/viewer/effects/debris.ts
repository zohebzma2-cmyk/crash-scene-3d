// The debris burst: a few dozen small glass and plastic shards thrown from the contact point. Pure and
// deterministic: the shards are a function of a seed (a hash of the scene) and the impact, never of
// Math.random, and a shard's pose is a closed-form function of time since impact (ballistic arc, short
// tumble, then it lies on the ground). So scrubbing, stills and playback all agree, and nothing is simulated
// frame to frame. Illustrative: small grey and white shards, nothing else.
import type { Vec2 } from "@csd/core";

/** Shards per kind at full strength. "A few dozen" in total. */
export const GLASS_COUNT = 30;
export const PLASTIC_COUNT = 18;
const G = 9.80665;
/** Height the burst starts at, m (bumper height). */
const LAUNCH_HEIGHT_M = 0.55;
/** Time over which a landed shard stops tumbling and lies flat, s. */
const SETTLE_S = 0.12;

/** FNV-1a over a string: the seed from the scene's canonical JSON. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** Small fast seeded generator (mulberry32). Returns a function giving [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface DebrisInput {
  readonly seed: number;
  /** Where it starts, local ENU meters. */
  readonly originM: Vec2;
  /** Directions the pieces tend to fly (compass headings of the vehicles at impact), radians. */
  readonly headingsRad: readonly number[];
  /** Sum of the vehicles' delta-v, m/s: how hard the hit was. 0 means no burst. */
  readonly strengthMps: number;
}

export interface Shards {
  readonly count: number;
  /** 0 = glass, 1 = plastic. */
  readonly kind: Uint8Array;
  /** East / north / up start, and the launch velocity (m/s). */
  readonly x0: Float32Array; readonly y0: Float32Array; readonly z0: Float32Array;
  readonly vx: Float32Array; readonly vy: Float32Array; readonly vz: Float32Array;
  /** Flight time until it reaches the ground, s. */
  readonly flightS: Float32Array;
  /** Tumble rates (rad/s) about the three axes, and the final yaw it lies at. */
  readonly wx: Float32Array; readonly wy: Float32Array; readonly wz: Float32Array;
  /** Size in meters (longest edge). */
  readonly size: Float32Array;
}

export const NO_SHARDS: Shards = {
  count: 0, kind: new Uint8Array(0),
  x0: new Float32Array(0), y0: new Float32Array(0), z0: new Float32Array(0),
  vx: new Float32Array(0), vy: new Float32Array(0), vz: new Float32Array(0),
  flightS: new Float32Array(0), wx: new Float32Array(0), wy: new Float32Array(0), wz: new Float32Array(0), size: new Float32Array(0),
};

/** How many of each kind for a hit strength (a light tap still sheds a few pieces; below ~1.3 m/s, none). */
export function shardCounts(strengthMps: number): { glass: number; plastic: number } {
  if (!(strengthMps > 1.3)) return { glass: 0, plastic: 0 };
  const k = 0.3 + 0.7 * Math.min(1, strengthMps / 18);
  return { glass: Math.round(GLASS_COUNT * k), plastic: Math.round(PLASTIC_COUNT * k) };
}

export function buildShards(input: DebrisInput): Shards {
  const { glass, plastic } = shardCounts(input.strengthMps);
  const n = glass + plastic;
  if (n === 0) return NO_SHARDS;
  const r = rng(input.seed ^ 0x9e3779b9);
  const out: { -readonly [K in keyof Shards]: Shards[K] } = {
    count: n, kind: new Uint8Array(n),
    x0: new Float32Array(n), y0: new Float32Array(n), z0: new Float32Array(n),
    vx: new Float32Array(n), vy: new Float32Array(n), vz: new Float32Array(n),
    flightS: new Float32Array(n), wx: new Float32Array(n), wy: new Float32Array(n), wz: new Float32Array(n), size: new Float32Array(n),
  };
  const heads = input.headingsRad.length ? input.headingsRad : [0];
  const strength = Math.min(1, input.strengthMps / 18);
  for (let i = 0; i < n; i++) {
    const isGlass = i < glass;
    out.kind[i] = isGlass ? 0 : 1;
    // Direction: along one of the vehicles' travel lines, spread about +-70 degrees, with some thrown anywhere.
    const scattered = r() < 0.25;
    const base = heads[Math.floor(r() * heads.length)]!;
    const ang = scattered ? r() * Math.PI * 2 : base + (r() + r() - 1) * 1.22;
    const speed = (1.2 + 3.8 * strength * r() + 1.0 * r()) * (isGlass ? 1.0 : 0.85);
    const vh = speed, vyUp = 1.4 + 2.6 * r() * (0.5 + 0.5 * strength);
    out.vx[i] = Math.sin(ang) * vh;
    out.vy[i] = Math.cos(ang) * vh;
    out.vz[i] = vyUp;
    const jitter = 0.25;
    out.x0[i] = input.originM.x + (r() - 0.5) * jitter;
    out.y0[i] = input.originM.y + (r() - 0.5) * jitter;
    out.z0[i] = LAUNCH_HEIGHT_M + r() * 0.25;
    // Time to fall from z0 back to the ground: z0 + vz t - g t^2 / 2 = 0
    out.flightS[i] = (vyUp + Math.sqrt(vyUp * vyUp + 2 * G * out.z0[i]!)) / G;
    out.wx[i] = (r() - 0.5) * 18; out.wy[i] = (r() - 0.5) * 18; out.wz[i] = (r() - 0.5) * 18;
    out.size[i] = isGlass ? 0.1 + 0.12 * r() : 0.14 + 0.2 * r();
  }
  return out;
}

export interface ShardPose {
  /** East, north, up (meters above the ground) and the tumble angles about x, y(up) and z. */
  x: number; y: number; z: number; rx: number; ry: number; rz: number;
  /** False before the impact. */
  visible: boolean;
}

/** Where a shard is `sinceImpactS` after the impact (Infinity = settled). Writes into `out`. */
export function shardPoseAt(s: Shards, i: number, sinceImpactS: number, out: ShardPose): ShardPose {
  if (sinceImpactS < 0) { out.visible = false; return out; }
  out.visible = true;
  const T = s.flightS[i]!;
  const tau = Math.min(sinceImpactS, T);
  out.x = s.x0[i]! + s.vx[i]! * tau;
  out.y = s.y0[i]! + s.vy[i]! * tau;
  out.z = sinceImpactS >= T ? 0 : Math.max(0, s.z0[i]! + s.vz[i]! * tau - 0.5 * G * tau * tau);
  // Tumbling in the air; on the ground it eases flat, keeping the heading it landed with.
  const k = sinceImpactS <= T ? 0 : Math.min(1, (sinceImpactS - T) / SETTLE_S);
  const ease = k * k * (3 - 2 * k);
  out.rx = s.wx[i]! * tau * (1 - ease);
  out.rz = s.wz[i]! * tau * (1 - ease);
  out.ry = s.wy[i]! * tau;
  return out;
}

/** Where every shard ends up (the debris field), for framing the Aftermath view. */
export function settledPositions(s: Shards): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i < s.count; i++) pts.push({ x: s.x0[i]! + s.vx[i]! * s.flightS[i]!, y: s.y0[i]! + s.vy[i]! * s.flightS[i]! });
  return pts;
}
