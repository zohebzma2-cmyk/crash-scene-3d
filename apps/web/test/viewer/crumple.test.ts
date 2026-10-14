// Crumple on the catalog models (effects/crumple.ts): the displacement (zone, falloff, cap, nothing under the
// threshold, the physics' push), the plan from the impact data, and the per-vehicle copy of a fitted catalog model.
import { describe, expect, it, vi } from "vitest";
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Vector3, type BufferGeometry } from "three";
import { MPH_TO_MPS, ZONES, type Pose, type SimulationResult, type VehicleResult, type Zone } from "@csd/core";
import { DENT_MAX_M, applyDentProgress, dentDepthM, severityFromDeltaV, type Box3 } from "../../src/viewer/effects/damage";
import { FOLD, FOLD_ALONG_M, PUSH_MIN_COS, ZONE_INWARD, crumpleAmount, crumpleFrame, crumpleModel, crumpleOffset, crumpleWeight, dirToVehicleFrame, planCrumples, toVehicleFrame, type CrumpleSpec } from "../../src/viewer/effects/crumple";
import { normalise } from "../../src/viewer/glb-model";

const L = 4.6, W = 1.9, H = 1.4;
/** The model's drawn box, vehicle frame: faces -z, x to the right, wheels on y = 0. */
const BOX: Box3 = { minX: -W / 2, maxX: W / 2, minY: 0, maxY: H, minZ: -L / 2, maxZ: L / 2 };
/** A dense grid of surface points on that box. */
function surface(step = 0.1): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  const xs = range(BOX.minX, BOX.maxX, step), ys = range(BOX.minY, BOX.maxY, step), zs = range(BOX.minZ, BOX.maxZ, step);
  for (const y of ys) {
    for (const z of zs) { out.push([BOX.minX, y, z], [BOX.maxX, y, z]); }
    for (const x of xs) { out.push([x, y, BOX.minZ], [x, y, BOX.maxZ]); }
  }
  return out;
}
function range(a: number, b: number, step: number): number[] {
  const n = Math.round((b - a) / step), out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(a + ((b - a) * i) / n);
  return out;
}
const len = (d: readonly number[]) => Math.hypot(d[0]!, d[1]!, d[2]!);
/** Bumper height: low on the body, where the crumple is full (the roof barely moves). */
const LOW = 0.4;

describe("crumple displacement: nothing under the threshold, then capped", () => {
  it("moves nothing under 3 mph of delta-v (severity 0), and no model copy is made", () => {
    const spec: CrumpleSpec = { zone: "front", severity: severityFromDeltaV(2.9 * MPH_TO_MPS) };
    expect(spec.severity).toBe(0);
    for (const p of surface(0.2)) expect(len(crumpleOffset([spec], BOX, ...p))).toBe(0);
    const g = new Group(); g.add(new Mesh(new BoxGeometry(W, H, L, 8, 4, 16).translate(0, H / 2, 0)));
    expect(crumpleModel(g, [spec])).toBeNull();
  });

  it("is as deep as the dents' curve at the contact, and never deeper than DENT_MAX_M, even with two crumples overlapping", () => {
    for (const mph of [8, 20, 35]) {
      const s = severityFromDeltaV(mph * MPH_TO_MPS);
      const d = crumpleOffset([{ zone: "front", severity: s }], BOX, 0, LOW, BOX.minZ);
      expect(len(d)).toBeCloseTo(dentDepthM(s), 6);
    }
    const at40 = crumpleOffset([{ zone: "front", severity: severityFromDeltaV(40 * MPH_TO_MPS) }], BOX, 0, LOW, BOX.minZ);
    const at90 = crumpleOffset([{ zone: "front", severity: severityFromDeltaV(90 * MPH_TO_MPS) }], BOX, 0, LOW, BOX.minZ);
    expect(len(at40)).toBeCloseTo(DENT_MAX_M, 6);
    expect(at90).toEqual(at40);
    // The entered zone and the face that touched, overlapping at full depth: the total move is still capped.
    const both: CrumpleSpec[] = [{ zone: "front", severity: 1 }, { zone: "front-left", severity: 1 }];
    let deepest = 0;
    for (const p of surface()) deepest = Math.max(deepest, len(crumpleOffset(both, BOX, ...p)));
    expect(deepest).toBeGreaterThan(DENT_MAX_M * 0.9);
    expect(deepest).toBeLessThanOrEqual(DENT_MAX_M + 1e-9);
  });

  it("only pushes inward and never outside the model's box, for every zone, contact and push", () => {
    const pushes = [null, { x: 0.3, z: 1 }, { x: -1, z: 0.2 }, { x: 0, z: -1 }];
    for (const zone of ZONES) for (const push of pushes) for (const contact of [null, { x: -0.5, z: -1.5 }, { x: 3, z: 9 }]) {
      for (const p of surface(0.2)) {
        const d = crumpleOffset([{ zone, severity: 1, contact, push }], BOX, ...p);
        const q = [p[0] + d[0], p[1] + d[1], p[2] + d[2]];
        expect(q[0]).toBeGreaterThanOrEqual(BOX.minX - 1e-9); expect(q[0]).toBeLessThanOrEqual(BOX.maxX + 1e-9);
        expect(q[2]).toBeGreaterThanOrEqual(BOX.minZ - 1e-9); expect(q[2]).toBeLessThanOrEqual(BOX.maxZ + 1e-9);
        expect(d[1]).toBe(0);                                                // never up or down
        if (len(d) > 0) expect(d[0] * ZONE_INWARD[zone].x + d[2] * ZONE_INWARD[zone].z, JSON.stringify({ zone, push, contact, p, d })).toBeGreaterThan(0);   // into the body
      }
    }
  });
});

describe("crumple displacement: the right area", () => {
  it("each of the eight zones crumples on its own side only", () => {
    for (const zone of ZONES) {
      const n = ZONE_INWARD[zone];
      let sx = 0, sz = 0, total = 0;
      for (const p of surface()) {
        const m = len(crumpleOffset([{ zone, severity: 1 }], BOX, ...p));
        if (m === 0) continue;
        sx += p[0] * m; sz += p[2] * m; total += m;
        // Nothing moves on the far half of the body.
        expect(p[0] * n.x + p[2] * n.z, `${zone} at ${p.join(",")}`).toBeLessThan(0);
      }
      expect(total, zone).toBeGreaterThan(0);
      // The centre of the crumple is on the zone's side: toward -n (the outside of that face).
      expect(-(sx / total) * n.x - (sz / total) * n.z, zone).toBeGreaterThan(0.5);
    }
  });

  it("mirrors left and right, and front and rear", () => {
    for (const [a, b, mx, mz] of [["left", "right", -1, 1], ["front", "rear", 1, -1], ["front-left", "rear-right", -1, -1]] as Array<[Zone, Zone, number, number]>) {
      for (const p of surface(0.2)) {
        const da = crumpleOffset([{ zone: a, severity: 0.7 }], BOX, ...p);
        const db = crumpleOffset([{ zone: b, severity: 0.7 }], BOX, p[0] * mx, p[1], p[2] * mz);
        expect(db[0]).toBeCloseTo(da[0] * mx, 9);
        expect(db[2]).toBeCloseTo(da[2] * mz, 9);
      }
    }
  });

  it("is centred where the vehicles touched: a side hit near the front crumples the front door, near the back the rear door", () => {
    for (const cz of [-1.2, 0.9]) {
      let best = { z: Number.NaN, m: 0 };
      for (const z of range(BOX.minZ, BOX.maxZ, 0.05)) {
        const m = len(crumpleOffset([{ zone: "left", severity: 0.8, contact: { x: -W / 2 - 0.05, z: cz } }], BOX, BOX.minX, LOW, z));
        if (m > best.m) best = { z, m };
      }
      expect(Math.abs(best.z - cz)).toBeLessThan(0.051);
      // and the other end of that side is untouched
      expect(len(crumpleOffset([{ zone: "left", severity: 0.8, contact: { x: -W / 2, z: cz } }], BOX, BOX.minX, LOW, -Math.sign(cz) * L / 2))).toBe(0);
    }
    // A contact off the box (the physics' box is a little bigger than the drawn model) is kept on the face.
    const off = crumpleFrame({ zone: "front", severity: 1, contact: { x: 5, z: -9 } }, BOX);
    expect(off.cx).toBe(BOX.maxX);
    expect(off.cz).toBe(BOX.minZ);
    // A corner crumples around the contact in its own quarter of the body, and around the corner itself otherwise.
    const near = crumpleFrame({ zone: "front-left", severity: 1, contact: { x: -0.6, z: -L / 2 - 0.02 } }, BOX);
    expect([near.cx, near.cz]).toEqual([-0.6, -L / 2]);
    const away = crumpleFrame({ zone: "rear-right", severity: 1, contact: { x: -0.5, z: -1.5 } }, BOX);
    expect([away.cx, away.cz]).toEqual([BOX.maxX, BOX.maxZ]);
  });

  it("falls off smoothly along the face, into the body and toward the roof, to nothing at the reach", () => {
    const f = crumpleFrame({ zone: "rear", severity: 1, contact: { x: 0, z: L / 2 } }, BOX);
    const along = range(0, f.reachAlong + 0.3, 0.02).map((x) => crumpleWeight(f, BOX, x, LOW, BOX.maxZ));
    const into = range(0, f.reachIn + 0.3, 0.02).map((d) => crumpleWeight(f, BOX, 0, LOW, BOX.maxZ - d));
    const up = range(0, H, 0.02).map((y) => crumpleWeight(f, BOX, 0, y, BOX.maxZ));
    for (const [name, ws] of [["along", along], ["into", into], ["up", up]] as const) {
      expect(ws[0], name).toBeGreaterThan(name === "up" ? 0.99 : 0.999);
      for (let i = 1; i < ws.length; i++) {
        expect(ws[i]!, `${name} ${i}`).toBeLessThanOrEqual(ws[i - 1]! + 1e-12);          // never grows away from the contact
        expect(Math.abs(ws[i]! - ws[i - 1]!), `${name} step ${i}`).toBeLessThan(0.08);    // smooth: no step
      }
    }
    expect(along.at(-1)).toBe(0);
    expect(into.at(-1)).toBe(0);
    expect(up.at(-1)).toBeGreaterThan(0.2);                       // the roof barely moves, but it isn't cut off
    expect(up.at(-1)).toBeLessThan(0.3);
    expect(crumpleWeight(f, BOX, f.reachAlong, LOW, BOX.maxZ)).toBeCloseTo(0, 12);
    expect(crumpleWeight(f, BOX, 0, LOW, BOX.maxZ - f.reachIn)).toBeCloseTo(0, 12);
  });

  it("folds the panel: full depth at the contact, creases pushed in less, never deeper than the bump nor out of it", () => {
    const f = crumpleFrame({ zone: "left", severity: 1, contact: { x: -W / 2, z: 0 } }, BOX);
    expect(crumpleAmount(f, BOX, BOX.minX, LOW, 0)).toBeCloseTo(crumpleWeight(f, BOX, BOX.minX, LOW, 0), 12);
    let creased = 0;
    for (const z of range(-1.2, 1.2, 0.01)) for (const y of range(0, H, 0.05)) {
      const w = crumpleWeight(f, BOX, BOX.minX, y, z), a = crumpleAmount(f, BOX, BOX.minX, y, z);
      expect(a).toBeLessThanOrEqual(w + 1e-12);
      expect(a).toBeGreaterThanOrEqual(w * (1 - FOLD) - 1e-12);
      if (w > 0.3 && a < w * (1 - FOLD / 2)) creased++;
    }
    expect(creased, "the creases between the folds").toBeGreaterThan(50);
    // A crease every FOLD_ALONG_M across the face: back to the full bump there.
    expect(crumpleAmount(f, BOX, BOX.minX, LOW, FOLD_ALONG_M) / crumpleWeight(f, BOX, BOX.minX, LOW, FOLD_ALONG_M)).toBeCloseTo(1, 9);
  });

  it("pushes the way the hit pushed the vehicle when that goes into the face, else straight in", () => {
    const n = { x: 0.6, z: 0.8 };                                                   // into the front face, at an angle
    const d = crumpleOffset([{ zone: "front", severity: 1, push: n }], BOX, 0, LOW, BOX.minZ);
    expect(d[0] / len(d)).toBeCloseTo(0.6, 6);
    expect(d[2] / len(d)).toBeCloseTo(0.8, 6);
    // Along the face or outward: straight in.
    for (const bad of [{ x: 1, z: 0 }, { x: 0, z: -1 }, { x: Math.sqrt(1 - (PUSH_MIN_COS - 0.01) ** 2), z: PUSH_MIN_COS - 0.01 }]) {
      const s = crumpleOffset([{ zone: "front", severity: 1, push: bad }], BOX, 0, LOW, BOX.minZ);
      expect(s[0]).toBeCloseTo(0, 9);
      expect(s[2]).toBeCloseTo(DENT_MAX_M, 6);
    }
  });
});

// ------------------------------------------------------------------ from the simulation

const DT = 1 / 120;
const pose = (x: number, y: number, h: number): Pose => ({ xM: x, yM: y, headingRad: h, speedMps: 0 });
function vehicle(id: "A" | "B", p: Pose, impact?: { dvMph: number; contact: { x: number; y: number }; normal: { x: number; y: number }; zoneHit: Zone; leadingZone: Zone }): VehicleResult {
  const track = [p, p, p];
  return {
    id, type: "car", massKg: 1500, lengthM: L, widthM: W, inertiaKgM2: 3000, path: null,
    speedAtImpactMps: { lo: 0, mid: 0, hi: 0 }, approachDistanceM: { lo: 0, mid: 0, hi: 0 }, postImpactDistanceM: { lo: 0, mid: 0, hi: 0 },
    impactPose: p, restPose: p, track,
    ...(impact ? { impact: { deltaVMps: { lo: 0, mid: impact.dvMph * MPH_TO_MPS, hi: 0 }, contactPointM: impact.contact, normal: impact.normal, spinRadps: { lo: 0, mid: 0, hi: 0 }, zoneHit: impact.zoneHit, leadingZone: impact.leadingZone } } : {}),
  };
}
const simOf = (vehicles: VehicleResult[]): SimulationResult => ({
  physicsVersion: "t", dtS: DT, startTimeS: -DT, impactTimeS: 0, restTimeS: DT, frictionCoefficient: 0.7, restitution: 0.2,
  impactPointM: { x: 0, y: 0 }, vehicles, gaps: [], assumptions: [], warnings: [],
} as unknown as SimulationResult);

describe("the vehicle frame", () => {
  it("is the models' frame: facing -z, x to the vehicle's right", () => {
    const north = pose(10, 20, 0), east = pose(10, 20, Math.PI / 2);
    expect(toVehicleFrame(north, { x: 10, y: 22 })).toEqual({ x: 0, z: -2 });          // 2 m ahead
    expect(toVehicleFrame(north, { x: 11, y: 20 })).toEqual({ x: 1, z: -0 });          // 1 m to its right (east)
    const ahead = toVehicleFrame(east, { x: 12, y: 20 });
    expect(ahead.x).toBeCloseTo(0, 9); expect(ahead.z).toBeCloseTo(-2, 9);
    const left = toVehicleFrame(east, { x: 10, y: 21 });                                // north of an eastbound car: its left
    expect(left.x).toBeCloseTo(-1, 9); expect(left.z).toBeCloseTo(0, 9);
    const southward = dirToVehicleFrame(east, { x: 0, y: -1 });                         // pushed south: to its right
    expect(southward.x).toBeCloseTo(1, 9); expect(southward.z).toBeCloseTo(0, 9);
  });
});

describe("planCrumples", () => {
  it("places each crumple at the physics' contact, pushed the physics' way, as deep as the vehicle's own delta-v", () => {
    // A heads east and is hit on its left (north) side, toward its front, by B heading south; B's front crumples.
    const a = vehicle("A", pose(0, 0, Math.PI / 2), { dvMph: 14, contact: { x: 1, y: W / 2 }, normal: { x: 0, y: -1 }, zoneHit: "left", leadingZone: "left" });
    const b = vehicle("B", pose(1, W / 2 + L / 2, Math.PI), { dvMph: 9, contact: { x: 1, y: W / 2 }, normal: { x: 0, y: 1 }, zoneHit: "front", leadingZone: "front" });
    const plan = planCrumples(simOf([a, b]));
    const [ca] = plan.get("A")!;
    expect(plan.get("A")).toHaveLength(1);
    expect(ca!.zone).toBe("left");
    expect(ca!.severity).toBeCloseTo(severityFromDeltaV(14 * MPH_TO_MPS), 9);
    expect(ca!.contact!.x).toBeCloseTo(-W / 2, 9);                                     // on A's left
    expect(ca!.contact!.z).toBeCloseTo(-1, 9);                                         // 1 m ahead of A's middle
    expect(ca!.push!.x).toBeCloseTo(1, 9);                                             // pushed to A's right: inward
    const [cb] = plan.get("B")!;
    expect(cb!.zone).toBe("front");
    expect(cb!.contact!.z).toBeCloseTo(-L / 2, 9);                                     // B's front
    expect(cb!.push!.z).toBeCloseTo(1, 9);                                             // pushed back: into its front
    // The deepest point of A's crumple is at the contact, on its left side.
    let best = { z: 0, m: 0 };
    for (const z of range(-L / 2, L / 2, 0.05)) { const m = len(crumpleOffset(plan.get("A")!, BOX, -W / 2, LOW, z)); if (m > best.m) best = { z, m }; }
    expect(best.z).toBeCloseTo(-1, 1);
  });

  it("crumples the entered zone and the face that touched (shallower), and nothing under 3 mph", () => {
    const a = vehicle("A", pose(0, 0, 0), { dvMph: 20, contact: { x: -W / 2, y: L / 2 }, normal: { x: 0.7, y: -0.7 }, zoneHit: "front", leadingZone: "front-left" });
    const nudge = vehicle("B", pose(9, 9, 0), { dvMph: 2.5, contact: { x: 9, y: 9 }, normal: { x: 0, y: 1 }, zoneHit: "rear", leadingZone: "rear" });
    const untouched = vehicle("B", pose(9, 9, 0));
    const plan = planCrumples(simOf([a, nudge]));
    expect(plan.has("B")).toBe(false);
    expect(planCrumples(simOf([a, untouched])).has("B")).toBe(false);
    const specs = plan.get("A")!;
    expect(specs.map((s) => s.zone)).toEqual(["front", "front-left"]);
    expect(specs[1]!.severity).toBeLessThan(specs[0]!.severity);
    // Both are next to the contact, so both are centred on it.
    for (const s of specs) { expect(s.contact!.x).toBeCloseTo(-W / 2, 9); expect(s.contact!.z).toBeCloseTo(-L / 2, 9); }
    // An entered zone far from the contact keeps its own middle.
    const far = planCrumples(simOf([vehicle("A", pose(0, 0, 0), { dvMph: 20, contact: { x: 0, y: L / 2 }, normal: { x: 0, y: -1 }, zoneHit: "rear", leadingZone: "front" })])).get("A")!;
    expect(far.find((s) => s.zone === "rear")!.contact).toBeNull();
    expect(far.find((s) => s.zone === "front")!.contact).not.toBeNull();
  });
});

// ------------------------------------------------------------------ on a catalog model

const FOOT = { lengthM: L, widthM: W, heightM: H };
/** A raw catalog-like model: glTF's +z forward, scaled and off the origin, one dense mesh (like the catalog's) and a wheel. */
function catalogLike() {
  const root = new Group();
  const paint = new MeshStandardMaterial({ name: "" });
  const body = new Mesh(new BoxGeometry(0.42, 0.3, 1, 12, 8, 30).translate(0, 0.15, 0), paint);
  const wheel = new Mesh(new BoxGeometry(0.05, 0.08, 0.08), paint); wheel.position.set(0.17, 0.04, -0.35);    // at the back (glTF +z is the front)
  root.add(body, wheel);
  root.scale.setScalar(2.5);
  root.position.set(4, 1, -3);
  return { fit: normalise(root, FOOT), body, wheel, paint };
}
/** Vertex positions of a mesh in the vehicle frame (the fitted group's parent), with its morph at `k`. */
function drawn(mesh: Mesh, k: number): Vector3[] {
  mesh.updateWorldMatrix(true, false);
  const g = mesh.geometry as BufferGeometry, pos = g.getAttribute("position"), dm = g.morphAttributes["position"]?.[0];
  return Array.from({ length: pos.count }, (_, i) => new Vector3(pos.getX(i) + k * (dm?.getX(i) ?? 0), pos.getY(i) + k * (dm?.getY(i) ?? 0), pos.getZ(i) + k * (dm?.getZ(i) ?? 0)).applyMatrix4(mesh.matrixWorld));
}
const meshes = (o: Group | ReturnType<typeof crumpleModel> & object) => { const out: Mesh[] = []; ("object" in o ? o.object : o).traverse((x) => { if ((x as Mesh).isMesh) out.push(x as Mesh); }); return out; };

describe("crumpleModel: a per-vehicle copy of a fitted catalog model", () => {
  it("crumples the copy on the right face in the vehicle's frame, through the model's own scale and turn, and leaves the model alone", () => {
    const { fit, body } = catalogLike();
    const before = Float32Array.from(body.geometry.getAttribute("position").array as ArrayLike<number>);
    const c = crumpleModel(fit, [{ zone: "front", severity: 1, contact: { x: 0.3, z: -L / 2 } }])!;
    expect(c).not.toBeNull();
    // The loaded model: same geometry object, same numbers, no morph target.
    expect(Array.from(body.geometry.getAttribute("position").array as ArrayLike<number>)).toEqual(Array.from(before));
    expect(Object.keys(body.geometry.morphAttributes)).toEqual([]);
    const [copyBody] = meshes(c);
    expect(copyBody!.geometry).not.toBe(body.geometry);
    expect(copyBody!.material).toBe(body.material);                                    // the tint still reaches it
    expect(copyBody!.morphTargetInfluences).toEqual([0]);                              // intact until ImpactEffects sets the time
    const intact = drawn(copyBody!, 0), full = drawn(copyBody!, 1), orig = drawn(body, 0);
    let moved = 0, deepest = 0;
    for (let i = 0; i < intact.length; i++) {
      expect(intact[i]!.distanceTo(orig[i]!)).toBeLessThan(1e-5);                     // influence 0 = the catalog model
      const d = full[i]!.clone().sub(intact[i]!);
      if (d.length() < 1e-6) continue;
      moved++;
      deepest = Math.max(deepest, d.length());
      expect(intact[i]!.z, "only the front moves").toBeLessThan(-L / 2 + 0.95);
      expect(d.z, "pushed back into the body").toBeGreaterThan(0);
      expect(Math.abs(full[i]!.x)).toBeLessThanOrEqual(W / 2 + 1e-4);
      expect(full[i]!.z).toBeGreaterThanOrEqual(-L / 2 - 1e-4);
    }
    expect(moved).toBeGreaterThan(20);
    expect(deepest).toBeGreaterThan(DENT_MAX_M * 0.9);                                 // in meters, not in the model's raw units
    expect(deepest).toBeLessThanOrEqual(DENT_MAX_M + 1e-4);
    c.dispose();
  });

  it("keeps the catalog's geometry for a part the crumple doesn't reach, and frees only its own copies", () => {
    const { fit, body, wheel } = catalogLike();
    const c = crumpleModel(fit, [{ zone: "front", severity: 1 }])!;
    const [copyBody, copyWheel] = meshes(c);
    expect(copyWheel!.geometry).toBe(wheel.geometry);                                  // the wheel at the back: shared, untouched
    const mine = vi.spyOn(copyBody!.geometry, "dispose"), theirs = vi.spyOn(body.geometry, "dispose"), shared = vi.spyOn(wheel.geometry, "dispose");
    c.dispose();
    expect(mine).toHaveBeenCalledTimes(1);
    expect(theirs).not.toHaveBeenCalled();
    expect(shared).not.toHaveBeenCalled();
  });

  it("is driven like the dents: applyDentProgress reaches the copy's nested meshes", () => {
    const { fit } = catalogLike();
    const c = crumpleModel(fit, [{ zone: "rear-right", severity: 0.6 }])!;
    const vehicleGroup = new Group();
    vehicleGroup.add(c.object);
    applyDentProgress(vehicleGroup, 0.4);
    const [copyBody, copyWheel] = meshes(c);
    expect(copyBody!.morphTargetInfluences).toEqual([0.4]);
    expect(copyWheel!.morphTargetInfluences ?? null).toBeNull();
    c.dispose();
  });

  it("returns null (draw the model as it is) when the crumple reaches nothing or there is nothing to crumple", () => {
    const { fit } = catalogLike();
    expect(crumpleModel(fit, [])).toBeNull();
    expect(crumpleModel(new Group(), [{ zone: "front", severity: 1 }])).toBeNull();
  });
});
