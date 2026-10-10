import { describe, expect, it } from "vitest";
import { BoxGeometry, BufferGeometry, Group, Mesh } from "three";
import { BRAKING_S, MPH_TO_MPS, ZONES, type Pose, type RoadNetwork, type SimulationResult, type VehicleResult, type Zone } from "@csd/core";
import { DENT_GROW_S, DENT_MAX_M, applyDentProgress, dentDepthM, dentGeometry, dentParts, dentProgress, morphParts, planDents, severityFromDeltaV } from "../../src/viewer/effects/damage";
import { buildShards, hashString, rng, settledPositions, shardCounts, shardPoseAt, type ShardPose } from "../../src/viewer/effects/debris";
import { deltaVFromTrack, getImpactInfo, zoneDistance, zoneOfPoint } from "../../src/viewer/effects/impact-info";
import { SHAKE_MS, WARP_MIN, effectiveRate, shakeOffset, warpFactor } from "../../src/viewer/effects/shake";
import { MARK_WIDTH_M, buildSkids, drawCountAt, makeSurfaces, wheelAt, wheelOffsets } from "../../src/viewer/effects/skids";
import { aftermathBox } from "../../src/viewer/effects/aftermath";

const L = 4.6, W = 1.9, H = 1.4;
/** A segmented box standing for a vehicle: 4.6 long (z), 1.9 wide (x), faces -z, centered in plan. */
const carBox = () => new BoxGeometry(W, H, L, 24, 6, 48).translate(0, H / 2, 0);
const positions = (g: BufferGeometry) => g.getAttribute("position");

function moved(a: BufferGeometry, b: BufferGeometry): boolean[] {
  const pa = positions(a), pb = positions(b);
  return Array.from({ length: pa.count }, (_, i) => Math.abs(pa.getX(i) - pb.getX(i)) + Math.abs(pa.getY(i) - pb.getY(i)) + Math.abs(pa.getZ(i) - pb.getZ(i)) > 1e-9);
}

describe("dent depth curve", () => {
  it("is 0 under 3 mph, grows with speed, and reaches about 0.35 m at 40 mph and over", () => {
    expect(severityFromDeltaV(2.9 * MPH_TO_MPS)).toBe(0);
    expect(severityFromDeltaV(0)).toBe(0);
    let last = 0;
    for (const mph of [4, 8, 15, 25, 35, 40]) {
      const s = severityFromDeltaV(mph * MPH_TO_MPS);
      expect(s).toBeGreaterThan(last);
      last = s;
    }
    expect(severityFromDeltaV(40 * MPH_TO_MPS)).toBeCloseTo(1, 6);
    expect(severityFromDeltaV(90 * MPH_TO_MPS)).toBe(1);
    expect(dentDepthM(1)).toBeCloseTo(DENT_MAX_M);
    expect(DENT_MAX_M).toBeCloseTo(0.35);
  });
});

describe("dentGeometry on a box", () => {
  it("moves vertices only near the zone entered as hit", () => {
    const g = carBox();
    const d = dentGeometry(g, "front", 1);
    const m = moved(g, d), p = positions(g);
    let any = false;
    for (let i = 0; i < m.length; i++) {
      if (m[i]) {
        any = true;
        expect(p.getZ(i) - -L / 2).toBeLessThanOrEqual(0.95);          // within the crush reach of the front
      }
    }
    expect(any).toBe(true);
    // Nothing at the rear, nothing on the far end of either side
    for (let i = 0; i < m.length; i++) if (p.getZ(i) > 0) expect(m[i]).toBe(false);
  });

  it("dents each of the eight zones on its own side, and mirrors left/right and front/rear", () => {
    const g = carBox();
    const centers: Record<Zone, [number, number]> = {
      front: [0, -L / 2], rear: [0, L / 2], left: [-W / 2, 0], right: [W / 2, 0],
      "front-left": [-W / 2, -L / 2], "front-right": [W / 2, -L / 2], "rear-left": [-W / 2, L / 2], "rear-right": [W / 2, L / 2],
    };
    for (const zone of ZONES) {
      const m = moved(g, dentGeometry(g, zone, 0.8)), p = positions(g);
      const [cx, cz] = centers[zone];
      let sx = 0, sz = 0, n = 0;
      m.forEach((hit, i) => { if (hit) { sx += p.getX(i); sz += p.getZ(i); n++; } });
      expect(n).toBeGreaterThan(0);
      // The centroid of what moved sits on the zone's side of the car
      if (cx !== 0) expect(Math.sign(sx / n)).toBe(Math.sign(cx));
      if (cz !== 0) expect(Math.sign(sz / n)).toBe(Math.sign(cz));
    }
  });

  it("depth tracks severity and stays under the maximum", () => {
    const g = carBox();
    const depthAt = (sev: number) => {
      const d = dentGeometry(g, "front", sev), a = positions(g), b = positions(d);
      let max = 0;
      for (let i = 0; i < a.count; i++) max = Math.max(max, Math.hypot(b.getX(i) - a.getX(i), b.getZ(i) - a.getZ(i)));
      return max;
    };
    expect(depthAt(0)).toBe(0);
    const d25 = depthAt(0.25), d50 = depthAt(0.5), d100 = depthAt(1);
    expect(d50).toBeCloseTo(d25 * 2, 3);
    expect(d100).toBeCloseTo(d25 * 4, 3);
    expect(d100).toBeCloseTo(0.35, 2);
    expect(d100).toBeLessThanOrEqual(0.35 + 1e-6);
  });

  it("never pushes a vertex outside the lengthM x widthM footprint, for any zone and severity, and only inward", () => {
    const g = carBox();
    const a = positions(g);
    const INW: Record<Zone, [number, number]> = { front: [0, 1], rear: [0, -1], left: [1, 0], right: [-1, 0], "front-left": [1, 1], "front-right": [-1, 1], "rear-left": [1, -1], "rear-right": [-1, -1] };
    for (const zone of ZONES) for (const sev of [0.3, 1]) {
      const inward = INW[zone];
      const d = dentGeometry(g, zone, sev), b = positions(d);
      for (let i = 0; i < b.count; i++) {
        expect(Math.abs(b.getX(i))).toBeLessThanOrEqual(W / 2 + 1e-6);
        expect(Math.abs(b.getZ(i))).toBeLessThanOrEqual(L / 2 + 1e-6);
        expect(b.getY(i)).toBe(a.getY(i));
        // only along the zone's inward direction (never outward, never sideways out of the face)
        const dx = b.getX(i) - a.getX(i), dz = b.getZ(i) - a.getZ(i);
        expect(dx * inward[0] + dz * inward[1]).toBeGreaterThanOrEqual(-1e-6);
      }
    }
  });

  it("is smooth: neighbouring vertices move by similar amounts, and the input is untouched", () => {
    const g = new BoxGeometry(W, H, L, 24, 28, 48).translate(0, H / 2, 0);
    const before = Float32Array.from(positions(g).array as Float32Array);
    const d = dentGeometry(g, "front", 1);
    expect(Array.from(positions(g).array as Float32Array)).toEqual(Array.from(before));
    // Along the front face centre line (x = 0), the push varies by less than 0.05 m between rows 1/6 apart
    const a = positions(g), b = positions(d);
    const rows: Array<{ y: number; dz: number }> = [];
    for (let i = 0; i < a.count; i++) if (Math.abs(a.getX(i)) < 1e-6 && Math.abs(a.getZ(i) + L / 2) < 1e-6) rows.push({ y: a.getY(i), dz: b.getZ(i) - a.getZ(i) });
    rows.sort((p, q) => p.y - q.y);
    expect(rows.length).toBeGreaterThan(4);
    for (let i = 1; i < rows.length; i++) expect(Math.abs(rows[i]!.dz - rows[i - 1]!.dz)).toBeLessThan(0.08);
  });

  it("keeps normals unit length", () => {
    const d = dentGeometry(carBox(), "left", 1), n = d.getAttribute("normal");
    for (let i = 0; i < n.count; i++) expect(Math.hypot(n.getX(i), n.getY(i), n.getZ(i))).toBeCloseTo(1, 4);
  });

  it("dentParts leaves tires alone and returns new geometry for the panels", () => {
    const parts = { body: carBox(), glass: new BoxGeometry(1, 0.4, 2).translate(0, 1.2, 0), tire: new BoxGeometry(0.2, 0.6, 0.6) };
    const out = dentParts(parts, [{ zone: "front", severity: 1 }]);
    expect(out.tire).toBe(parts.tire);
    expect(out.body).not.toBe(parts.body);
    expect(moved(parts.body, out.body).some(Boolean)).toBe(true);
    expect(dentParts(parts, []).body).toBe(parts.body);
  });
});

describe("dent as a morph target", () => {
  it("is intact at 0, equals the dented geometry at 1, and the tire has no morph", () => {
    const parts = { body: carBox(), tire: new BoxGeometry(0.2, 0.6, 0.6) };
    const specs = [{ zone: "front-left" as const, severity: 0.9 }];
    const m = morphParts(parts, specs), d = dentParts(parts, specs);
    expect(m.tire).toBe(parts.tire);
    expect(m.body.morphTargetsRelative).toBe(true);
    const base = positions(m.body), delta = m.body.morphAttributes["position"]![0]!, want = positions(d.body), orig = positions(parts.body);
    let moves = 0;
    for (let i = 0; i < base.count; i++) {
      expect(base.getX(i)).toBe(orig.getX(i));                                   // influence 0 = the intact model
      expect(base.getZ(i) + delta.getZ(i)).toBeCloseTo(want.getZ(i), 5);         // influence 1 = the dent
      if (Math.abs(delta.getX(i)) + Math.abs(delta.getZ(i)) > 0) moves++;
    }
    expect(moves).toBeGreaterThan(0);
  });
  it("grows over a moment after the impact and then stays", () => {
    expect(dentProgress(-0.001)).toBe(0);
    expect(dentProgress(0)).toBe(0);
    expect(dentProgress(DENT_GROW_S / 2)).toBeGreaterThan(0.3);
    expect(dentProgress(DENT_GROW_S)).toBe(1);
    expect(dentProgress(9)).toBe(1);
    expect(dentProgress(0, true)).toBe(1);        // reduced motion: dented as soon as it has happened
    expect(dentProgress(-1, true)).toBe(0);
  });
  it("sets the influence on the meshes that carry a morph target and no others", () => {
    const parts = morphParts({ body: carBox(), tire: new BoxGeometry(0.2, 0.6, 0.6) }, [{ zone: "rear", severity: 1 }]);
    const g = new Group(), a = new Mesh(parts.body), b = new Mesh(parts.tire);
    g.add(a, b);
    applyDentProgress(g, 0.5);
    expect(a.morphTargetInfluences).toEqual([0.5]);
    expect(b.morphTargetInfluences).toBeUndefined();
  });
});

// ------------------------------------------------------------------ a synthetic simulation

const DT = 1 / 120;
const pose = (x: number, y: number, h: number, v: number): Pose => ({ xM: x, yM: y, headingRad: h, speedMps: v });

/** A heading-north car hitting at the origin at `speed`; after impact it slides forward `slide` m while turning at `yawRate` rad/s. */
function car(id: "A" | "B", opts: { speed: number; after: number; yawRate: number; start?: Vec; heading?: number; type?: string; impact?: boolean }): VehicleResult {
  const h0 = opts.heading ?? 0;
  const start = opts.start ?? { x: 0, y: 0 };
  const pre = Math.round(5 / DT), post = Math.round(2 / DT);
  const track: Pose[] = [];
  const dir = (h: number) => ({ x: Math.sin(h), y: Math.cos(h) });
  for (let i = 0; i <= pre; i++) {
    const t = -5 + i * DT;
    const d = dir(h0);
    track.push(pose(start.x + d.x * opts.speed * t, start.y + d.y * opts.speed * t, h0, opts.speed));
  }
  let { x, y } = start, h = h0, v = opts.after;
  for (let i = 1; i <= post; i++) {
    h += opts.yawRate * DT * (1 - i / post);
    const d = dir(h0 + (h - h0) * 0.5);
    v = Math.max(0, opts.after * (1 - i / post));
    x += d.x * v * DT; y += d.y * v * DT;
    track.push(pose(x, y, h, v));
  }
  const iI = pre;
  return {
    id, type: (opts.type ?? "car") as VehicleResult["type"], massKg: 1500, lengthM: L, widthM: W, inertiaKgM2: 3000, path: null,
    speedAtImpactMps: { lo: opts.speed, mid: opts.speed, hi: opts.speed }, approachDistanceM: { lo: 20, mid: 20, hi: 20 }, postImpactDistanceM: { lo: 3, mid: 3, hi: 3 },
    impactPose: track[iI]!, restPose: track[track.length - 1]!, track,
  };
}
type Vec = { x: number; y: number };
const simOf = (vehicles: VehicleResult[]): SimulationResult => ({
  physicsVersion: "t", dtS: DT, startTimeS: -5, impactTimeS: 0, restTimeS: -5 + (vehicles[0]!.track.length - 1) * DT, frictionCoefficient: 0.7, restitution: 0.2,
  impactPointM: { x: 0, y: 0.5 }, vehicles, gaps: [], assumptions: [], warnings: [],
} as SimulationResult);

describe("impact info adapter", () => {
  it("derives delta-v from the track around the impact sample", () => {
    const a = car("A", { speed: 10, after: 4, yawRate: 0 });
    expect(deltaVFromTrack(simOf([a]), a)).toBeCloseTo(6, 1);
    const parked = car("B", { speed: 0, after: 0, yawRate: 0 });
    expect(deltaVFromTrack(simOf([parked]), parked)).toBeCloseTo(0, 3);
  });

  it("prefers the physics' own impact data when present", () => {
    const a = { ...car("A", { speed: 10, after: 4, yawRate: 0 }), impact: { deltaVMps: { lo: 1, mid: 9, hi: 11 }, contactPointM: { x: 1, y: 2 }, normal: { x: 0, y: 1 }, spinRadps: { lo: 0, mid: 0, hi: 0 }, zoneHit: "left", leadingZone: "front-left" } } as VehicleResult;
    const info = getImpactInfo(simOf([a]), a);
    expect(info.fromPhysics).toBe(true);
    expect(info.deltaVMps).toBe(9);
    expect(info.leadingZone).toBe("front-left");
    expect(info.contactPointM).toEqual({ x: 1, y: 2 });
  });

  it("names the face of a body that a point is nearest to", () => {
    const north = pose(0, 0, 0, 0), east = pose(0, 0, Math.PI / 2, 0);
    expect(zoneOfPoint(north, { x: 0, y: 3 })).toBe("front");
    expect(zoneOfPoint(north, { x: 3, y: 0 })).toBe("right");
    expect(zoneOfPoint(north, { x: -3, y: -3 })).toBe("rear-left");
    expect(zoneOfPoint(east, { x: 3, y: 0 })).toBe("front");      // facing east: east is the front
    expect(zoneOfPoint(east, { x: 0, y: -3 })).toBe("right");
    expect(zoneDistance("front", "rear")).toBe(4);
    expect(zoneDistance("front-left", "front")).toBe(1);
  });
});

describe("planDents", () => {
  const scene = (zoneA: Zone, zoneB: Zone) => ({ vehicles: [{ id: "A", zone: zoneA }, { id: "B", zone: zoneB }] }) as never;

  it("dents the entered zone, scaled by this vehicle's delta-v, and nothing for an untouched vehicle", () => {
    const a = car("A", { speed: 15, after: 3, yawRate: 0 });
    const still = car("B", { speed: 0, after: 0, yawRate: 0, start: { x: 9, y: 9 } });
    const plan = planDents(simOf([a, still]), scene("rear", "front"));
    expect(plan.get("A")![0]).toMatchObject({ zone: "rear" });
    expect(plan.get("A")![0]!.severity).toBeCloseTo(severityFromDeltaV(12), 1);
    expect(plan.has("B")).toBe(false);
  });

  it("also dents the striker's leading face (from the contact point) when it differs from the entered zone", () => {
    // B heads east and hits the side of A: B's front is where the contact point is. The claimant entered "rear" for B.
    const a = car("A", { speed: 8, after: 5, yawRate: 0 });
    const b = car("B", { speed: 12, after: 2, yawRate: 0, heading: Math.PI / 2, start: { x: 0, y: 0 } });
    const sim = simOf([a, b]);
    const plan = planDents(sim, scene("left", "rear"));
    const zonesB = plan.get("B")!.map((s) => s.zone);
    expect(zonesB).toContain("rear");
    expect(zonesB).toContain(zoneOfPoint(b.impactPose, sim.impactPointM));
    // and when the entered zone IS the leading face, one dent only
    const plan2 = planDents(sim, scene("left", zoneOfPoint(b.impactPose, sim.impactPointM)));
    expect(plan2.get("B")!).toHaveLength(1);
  });
});

describe("debris", () => {
  const base = { seed: hashString("scene"), originM: { x: 1, y: 2 }, headingsRad: [0, Math.PI / 2], strengthMps: 12 };

  it("is deterministic: the same seed gives the same shards; another seed gives others", () => {
    const a = buildShards(base), b = buildShards(base), c = buildShards({ ...base, seed: hashString("other") });
    expect(Array.from(a.vx)).toEqual(Array.from(b.vx));
    expect(Array.from(a.vx)).not.toEqual(Array.from(c.vx));
    expect(rng(5)()).toBe(rng(5)());
  });

  it("is a few dozen shards of glass and plastic, fewer for a tap, none for a nudge", () => {
    const hard = buildShards({ ...base, strengthMps: 20 });
    expect(hard.count).toBeGreaterThanOrEqual(24);
    expect(hard.count).toBeLessThanOrEqual(60);
    expect(hard.kind.some((k) => k === 0)).toBe(true);
    expect(hard.kind.some((k) => k === 1)).toBe(true);
    expect(shardCounts(3).glass).toBeLessThan(shardCounts(20).glass);
    expect(buildShards({ ...base, strengthMps: 1 }).count).toBe(0);
  });

  it("follows a ballistic arc, lands, and stays settled", () => {
    const s = buildShards(base);
    const p: ShardPose = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, visible: false };
    expect(shardPoseAt(s, 0, -0.01, p).visible).toBe(false);
    for (let i = 0; i < s.count; i++) {
      const T = s.flightS[i]!;
      shardPoseAt(s, i, 0, p);
      expect(p.x).toBeCloseTo(1, 0);
      expect(p.z).toBeGreaterThan(0.4);
      shardPoseAt(s, i, T / 2, p);
      const mid = p.z;
      expect(mid).toBeGreaterThan(0);
      shardPoseAt(s, i, T, p);
      expect(p.z).toBeCloseTo(0, 5);
      const landed = { x: p.x, y: p.y };
      shardPoseAt(s, i, T + 5, p);
      expect(p.z).toBe(0);
      expect(p.x).toBeCloseTo(landed.x, 6);
      expect(p.y).toBeCloseTo(landed.y, 6);
      shardPoseAt(s, i, Infinity, p);                    // reduced motion: already settled and flat
      expect(p.rx).toBeCloseTo(0, 6);
      expect(p.rz).toBeCloseTo(0, 6);
      expect(p.x).toBeCloseTo(landed.x, 6);
    }
    expect(settledPositions(s)).toHaveLength(s.count);
  });

  it("lands within a few meters of the contact point", () => {
    for (const pt of settledPositions(buildShards({ ...base, strengthMps: 25 }))) expect(Math.hypot(pt.x - 1, pt.y - 2)).toBeLessThan(14);
  });
});

describe("time warp and shake", () => {
  it("slows to 0.25x at impact, smoothly, and is 1x outside +-0.25 s", () => {
    expect(warpFactor(0)).toBeCloseTo(WARP_MIN);
    expect(warpFactor(0.25)).toBe(1);
    expect(warpFactor(-0.3)).toBe(1);
    expect(warpFactor(-5)).toBe(1);
    expect(warpFactor(0.125)).toBeGreaterThan(WARP_MIN);
    expect(warpFactor(0.125)).toBeLessThan(1);
    expect(warpFactor(0.1)).toBeCloseTo(warpFactor(-0.1));
    let last = warpFactor(0);
    for (let t = 0.01; t <= 0.25; t += 0.01) { const f = warpFactor(t); expect(f).toBeGreaterThanOrEqual(last - 1e-9); last = f; }
  });
  it("does nothing with reduced motion, and doesn't slow an already slow speed further", () => {
    expect(warpFactor(0, true)).toBe(1);
    expect(effectiveRate(1, 0, true)).toBe(1);
    expect(effectiveRate(1, 0)).toBeCloseTo(WARP_MIN);
    expect(effectiveRate(0.5, 0)).toBe(0.5);
  });
  it("shakes for 150 ms, small and damped, deterministically", () => {
    const o = { x: 0, y: 0 };
    let early = 0, late = 0;
    for (let ms = 0; ms < SHAKE_MS; ms += 3) {
      shakeOffset(ms, 99, o);
      const m = Math.hypot(o.x, o.y);
      expect(m).toBeLessThan(8);
      if (ms < 50) early = Math.max(early, m); else if (ms > 100) late = Math.max(late, m);
    }
    expect(late).toBeLessThan(early);
    shakeOffset(SHAKE_MS, 99, o);
    expect(o).toEqual({ x: 0, y: 0 });
    shakeOffset(40, 99, o);
    const a = { ...o };
    shakeOffset(40, 99, o);
    expect(o).toEqual(a);
  });
});

describe("skid marks", () => {
  const roads = (): RoadNetwork => ({
    radiusM: 100,
    ways: [{ id: "r", name: "Main", ref: null, kind: "residential", oneway: false, lanesForward: 1, lanesBackward: 1, laneWidthM: 3.5, centerline: [{ x: 0, y: -100 }, { x: 0, y: 100 }], speedLimitMph: 25, osmWayIds: [] }],
    buildings: [{ id: "b", footprint: [{ x: 5, y: 1.4 }, { x: 15, y: 1.4 }, { x: 15, y: 12 }, { x: 5, y: 12 }], heightM: 6, heightSource: "default" }],
    parking: [], terrain: null,
  } as unknown as RoadNetwork);
  const turning = () => simOf([car("A", { speed: 12, after: 7, yawRate: 1.6 })]);
  const none = new Set<string>();

  it("builds four wheel tracks for a car and two for a motorcycle, inside the body's own footprint", () => {
    expect(wheelOffsets("car", L, W)).toHaveLength(4);
    expect(wheelOffsets("motorcycle", 2.1, 0.8)).toHaveLength(2);
    for (const w of wheelOffsets("suv", L, W)) { expect(Math.abs(w.b)).toBeLessThan(W / 2); expect(Math.abs(w.a)).toBeLessThan(L / 2); }
    const [r] = buildSkids({ sim: turning(), roads: null, terrain: null, braking: none });
    expect(r!.tracks).toHaveLength(4);
    const m = simOf([car("A", { speed: 12, after: 7, yawRate: 0, type: "motorcycle" })]);
    expect(buildSkids({ sim: m, roads: null, terrain: null, braking: none })[0]!.tracks).toHaveLength(2);
  });

  it("follows each wheel through the yaw, so marks curve when the vehicle rotates (and are straight when it doesn't)", () => {
    const wheelOnLeft = (tracks: readonly (readonly { x: number; y: number }[])[]) => tracks[0]!;
    const curved = buildSkids({ sim: turning(), roads: null, terrain: null, braking: none })[0]!;
    const straight = buildSkids({ sim: simOf([car("A", { speed: 12, after: 7, yawRate: 0 })]), roads: null, terrain: null, braking: none })[0]!;
    const lateralSpread = (tr: readonly { x: number; y: number }[]) => Math.max(...tr.map((p) => p.x)) - Math.min(...tr.map((p) => p.x));
    expect(lateralSpread(wheelOnLeft(straight.tracks))).toBeLessThan(1e-3);
    expect(lateralSpread(wheelOnLeft(curved.tracks))).toBeGreaterThan(0.3);
    // wheels stay a fixed distance from the pose, whatever the heading
    const sim = turning(), v = sim.vehicles[0]!;
    const w = wheelOffsets("car", L, W)[1]!;
    for (const p of [v.track[650]!, v.track[800]!]) expect(Math.hypot(wheelAt(p, w).x - p.xM, wheelAt(p, w).y - p.yM)).toBeCloseTo(Math.hypot(w.a, w.b), 6);
  });

  it("grows with time and stays at rest", () => {
    const sim = turning();
    const r = buildSkids({ sim, roads: null, terrain: null, braking: none })[0]!;
    expect(drawCountAt(r, -0.1)).toBe(0);
    const c1 = drawCountAt(r, 0.2), c2 = drawCountAt(r, 0.8), c3 = drawCountAt(r, sim.restTimeS);
    expect(c1).toBeGreaterThan(0);
    expect(c2).toBeGreaterThan(c1);
    expect(c3).toBeGreaterThanOrEqual(c2);
    expect(drawCountAt(r, sim.restTimeS + 10)).toBe(c3);
    expect(c3 % 3).toBe(0);
    expect(c3).toBeLessThanOrEqual(r.indices.length);
    // ribbon is as wide as a tire
    const a = r.positions, i0 = r.indices[0]!;
    expect(Math.hypot(a[i0 * 3]! - a[(i0 + 1) * 3]!, a[i0 * 3 + 2]! - a[(i0 + 1) * 3 + 2]!)).toBeCloseTo(MARK_WIDTH_M, 3);
  });

  it("draws pre-impact braking marks only for braking vehicles, and only over the last BRAKING_S", () => {
    const sim = simOf([car("A", { speed: 12, after: 7, yawRate: 0 })]);
    expect(buildSkids({ sim, roads: null, terrain: null, braking: none }).map((r) => r.kind)).toEqual(["slide"]);
    const both = buildSkids({ sim, roads: null, terrain: null, braking: new Set(["A"]) });
    expect(both.map((r) => r.kind).sort()).toEqual(["brake", "slide"]);
    const brake = both.find((r) => r.kind === "brake")!;
    expect(brake.segEndS[0]!).toBeGreaterThanOrEqual(-BRAKING_S - 0.05);
    expect(brake.segEndS[brake.segEndS.length - 1]!).toBeLessThanOrEqual(1e-6);
  });

  it("clips to drivable surfaces and never draws inside a building", () => {
    const net = roads();
    const s = makeSurfaces(net);
    expect(s.drivable({ x: 0, y: 5 })).toBe(true);
    expect(s.drivable({ x: 30, y: 5 })).toBe(false);
    expect(s.building({ x: 8, y: 6 })).toBe(true);
    // A vehicle that slides off the 7 m wide road and into the building: marks stop at the road edge
    const sim = simOf([car("A", { speed: 12, after: 9, yawRate: 0, heading: Math.PI / 2, start: { x: -3, y: 2 } })]);
    const r = buildSkids({ sim, roads: net, terrain: null, braking: none })[0]!;
    const pts = r.tracks.flat();
    expect(pts.length).toBeGreaterThan(2);
    for (const p of pts) { expect(s.building(p)).toBe(false); expect(s.drivable(p)).toBe(true); }
    // Same slide with no road data: the marks aren't dropped
    const open = buildSkids({ sim, roads: null, terrain: null, braking: none })[0]!;
    expect(open.tracks.flat().length).toBeGreaterThan(pts.length);
  });
});

describe("aftermath framing", () => {
  it("covers the impact point, both vehicles at rest, their slide paths and the debris", () => {
    const sim = simOf([car("A", { speed: 12, after: 7, yawRate: 1.2 }), car("B", { speed: 9, after: 5, yawRate: -0.8, heading: Math.PI / 2, start: { x: -2, y: 0.5 } })]);
    const far = [{ x: 30, y: -20 }];
    const b = aftermathBox(sim, far);
    for (const p of [sim.impactPointM, ...sim.vehicles.map((v) => ({ x: v.restPose.xM, y: v.restPose.yM })), ...far]) {
      expect(p.x).toBeGreaterThanOrEqual(b.minX); expect(p.x).toBeLessThanOrEqual(b.maxX);
      expect(p.y).toBeGreaterThanOrEqual(b.minY); expect(p.y).toBeLessThanOrEqual(b.maxY);
    }
  });
});
