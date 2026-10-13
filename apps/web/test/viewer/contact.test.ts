// @vitest-environment jsdom
// Contact, not overlap (roads and paths, 2026-10-11): at the impact frame the bodies the viewer DRAWS touch as the physics
// placed them. For every example, the owner's curved road and a side hit on it, each vehicle's drawn geometry (our low-poly
// model, and the catalog fixture GLB fitted the way the viewer fits it) is posed at the impact; its plan outline (the convex
// hull of every vertex, in metres) may overlap the other vehicle's by at most a few centimetres. The impact ring sits clear of
// both bodies, with its leader line to where they touched.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Matrix4, Vector3, type BufferGeometry, type Group, type Mesh, type Object3D } from "three";
import { directionChoices, parseScene, simulate, type Scene, type SimulationResult, type Vec2, type VehicleResult } from "@csd/core";
import { parseOverpass } from "@csd/mapdata";
import { SITE_CENTERS, siteNet } from "../../../../packages/mapdata/test/synthetic-osm";
import { headingToYaw, toThree } from "../../src/viewer/math";
import { mergedModel, vehicleModel, SKIN_M } from "../../src/viewer/vehicle-models";
import { normalise } from "../../src/viewer/glb-model";
import { parseGlb } from "../../src/viewer/glb-loader";
import { RING_M, ringPlacement } from "../../src/viewer/scene-geometry";

const here = dirname(fileURLToPath(import.meta.url));
const BOX = readFileSync(join(here, "../../fixtures/models/synthetic-box-car.glb"));
const ab = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
/** Overlap allowed between two drawn bodies at the impact, m ("a few centimetres"). */
const TOL_M = 0.03;

function example(name: string): { scene: Scene; sim: SimulationResult } {
  const parsed = parseScene(JSON.parse(readFileSync(join(here, `../../../../examples/${name}/scene.json`), "utf8")));
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  // The roads the app loads for the example (fixtures build: its cached Overpass JSON, parsed around the pin).
  const osm = JSON.parse(readFileSync(join(here, `../../../../examples/${name}/osm.json`), "utf8")) as unknown;
  const roads = parseOverpass(osm, { origin: { lat: parsed.value.location.lat, lon: parsed.value.location.lon } }, 250, "2026-10-09T12:00:00Z");
  const out = simulate(parsed.value, roads);
  if (!out.ok) throw new Error(out.errors.map((e) => e.text).join("; "));
  return { scene: parsed.value, sim: out.result };
}

/** The owner's curved road with both vehicles on it: a rear-end, and a side hit from a driveway. */
function curved(kind: "rear-end" | "driveway"): { scene: Scene; sim: SimulationResult } {
  const net = siteNet("curved");
  const roadNW = directionChoices(net, { x: 0, y: 0 }, "straight").find((c) => c.label === "Heading northwest on Willow Bend Road")!;
  const drive = directionChoices(net, { x: 0, y: 0 }, "straight").find((c) => c.kind === "driveway")!;
  const v = (id: "A" | "B", travel: typeof roadNW.travel, mph: number, zone: Scene["vehicles"][number]["zone"]): Scene["vehicles"][number] => ({
    id, role: id === "A" ? "claimant" : "other", year: null, make: "", model: "", type: "car", typeSource: "manual", action: "straight",
    travel: { ...travel, lane: null }, speed: { kind: "known", mph }, braking: false, zone,
  });
  const c = SITE_CENTERS.curved;
  const scene: Scene = {
    schemaVersion: 4, claim: { number: "CLM-CONTACT", vehicle: { year: null, make: "", model: "" } },
    location: { lat: c.lat, lon: c.lon, label: "", nearLabel: "", source: "pin", place: "road" }, occurred: { date: "2026-10-02", time: "17:15" },
    road: { condition: "dry" },
    vehicles: kind === "rear-end" ? [v("A", roadNW.travel, 25, "rear"), v("B", roadNW.travel, 30, "front")] : [v("A", roadNW.travel, 25, "left"), v("B", drive.travel, 10, "front")],
  };
  const out = simulate(scene, net);
  if (!out.ok) throw new Error(out.errors.map((e) => e.text).join("; "));
  return { scene, sim: out.result };
}

/** Every vertex of an object's meshes in plan (x east, y north), with the object posed at `v`'s impact. */
function planPoints(obj: Object3D, v: VehicleResult): Vec2[] {
  const pose = v.impactPose;
  const [x, , z] = toThree({ x: pose.xM, y: pose.yM }, 0);
  const posed = new Matrix4().makeRotationY(headingToYaw(pose.headingRad)).setPosition(x, 0, z);
  obj.updateMatrixWorld(true);
  const pts: Vec2[] = [];
  const p = new Vector3();
  obj.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    const pos = (mesh.geometry as BufferGeometry).getAttribute("position");
    const m = new Matrix4().multiplyMatrices(posed, mesh.matrixWorld);
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i).applyMatrix4(m);
      // three: x east, z south (toThree); back to plan metres.
      pts.push({ x: p.x, y: -p.z });
    }
  });
  return pts;
}

function hull(pts: readonly Vec2[]): Vec2[] {
  const s = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Vec2[] = [], upper: Vec2[] = [];
  for (const p of s) { while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop(); lower.push(p); }
  for (const p of [...s].reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop(); upper.push(p); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** How deep two convex outlines are inside each other, m (separating axes; negative: a gap). */
function overlap(a: readonly Vec2[], b: readonly Vec2[]): number {
  let best = Infinity;
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!, q = poly[(i + 1) % poly.length]!;
      const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
      const n = { x: -(q.y - p.y) / len, y: (q.x - p.x) / len };
      const proj = (ps: readonly Vec2[]) => ps.map((v) => v.x * n.x + v.y * n.y);
      const pa = proj(a), pb = proj(b);
      best = Math.min(best, Math.min(Math.max(...pa), Math.max(...pb)) - Math.max(Math.min(...pa), Math.min(...pb)));
    }
  }
  return best;
}

const ourModel = (v: VehicleResult): Object3D => {
  const g = mergedModel(vehicleModel(v.type, v.lengthM, v.widthM));
  return { isMesh: true, geometry: g, matrixWorld: new Matrix4(), updateMatrixWorld: () => undefined, traverse(f: (o: unknown) => void) { f(this); } } as unknown as Object3D;
};

async function catalogModel(v: VehicleResult): Promise<Group> {
  const root = await parseGlb(ab(BOX));
  // The viewer's fit (catalog-models.ts): the footprint less the skin, our model's height.
  return normalise(root, { lengthM: v.lengthM - 2 * SKIN_M, widthM: v.widthM - 2 * SKIN_M, heightM: vehicleModel(v.type, v.lengthM, v.widthM).heightM });
}

const CASES: Array<[string, () => { scene: Scene; sim: SimulationResult }]> = [
  ["t-bone-intersection", () => example("t-bone-intersection")],
  ["highway-rear-end", () => example("highway-rear-end")],
  ["parking-lot-backing", () => example("parking-lot-backing")],
  ["curved road, rear-end", () => curved("rear-end")],
  ["curved road, out of a driveway into A's side", () => curved("driveway")],
];

describe("at the impact the drawn bodies touch, they don't overlap", () => {
  for (const [name, load] of CASES) {
    it(`${name}: our models, and the catalog fixture model on A then on B`, async () => {
      const { sim } = load();
      const [a, b] = sim.vehicles as [VehicleResult, VehicleResult];
      const ours = (v: VehicleResult) => hull(planPoints(ourModel(v), v));
      expect(overlap(ours(a), ours(b)), "our models").toBeLessThanOrEqual(TOL_M);
      const catA = hull(planPoints(await catalogModel(a), a)), catB = hull(planPoints(await catalogModel(b), b));
      expect(overlap(catA, ours(b)), "catalog A, our B").toBeLessThanOrEqual(TOL_M);
      expect(overlap(ours(a), catB), "our A, catalog B").toBeLessThanOrEqual(TOL_M);
      // And they really touch: within a few centimetres (the skin is 2 cm a side).
      expect(overlap(ours(a), ours(b)), "our models touch").toBeGreaterThanOrEqual(-2 * SKIN_M - TOL_M);
    });
  }
});

describe("the impact ring sits beside the crash, off both cars", () => {
  for (const [name, load] of CASES) {
    it(name, () => {
      const { sim } = load();
      const { center, anchor } = ringPlacement(sim);
      expect(anchor).toEqual(sim.impactPointM);
      for (const v of sim.vehicles) {
        // The ring's whole outline is outside the body's footprint at the impact.
        const pose = v.impactPose, fx = Math.sin(pose.headingRad), fy = Math.cos(pose.headingRad);
        const d = { x: center.x - pose.xM, y: center.y - pose.yM };
        const along = Math.abs(d.x * fx + d.y * fy), across = Math.abs(d.x * fy - d.y * fx);
        const gap = Math.hypot(Math.max(0, along - v.lengthM / 2), Math.max(0, across - v.widthM / 2));
        expect(gap, `ring to ${v.id}`).toBeGreaterThanOrEqual(RING_M.outer);
      }
      // Never far: within a few metres of where they touched.
      expect(Math.hypot(center.x - anchor.x, center.y - anchor.y)).toBeLessThan(8);
    });
  }
});

describe("one label for a vehicle everywhere (core vehicleTag)", () => {
  it("the 3D chip and the stills say 'A · Your car · 25 mph' and 'B · Other car · Stopped'", async () => {
    const { vehicleLabel } = await import("../../src/viewer/labels");
    const { vehicleTag } = await import("@csd/core");
    const { sim, scene } = example("t-bone-intersection");
    const a = sim.vehicles.find((v) => v.id === "A")!;
    const atImpact = vehicleLabel(scene.vehicles[0], "A", a.impactPose, 0, "us");
    expect(atImpact.full).toMatch(/^A · Your car · \d+ mph$/);
    expect(atImpact.text).toBe(atImpact.full.slice("A · ".length));
    const stopped = vehicleLabel(scene.vehicles[1], "B", { ...a.restPose, speedMps: 0 }, 9, "us");
    expect(stopped.full).toBe("B · Other car · Stopped");
    expect(vehicleTag({ id: "C" })).toBe("C · Other car");
    expect(vehicleTag({ id: "A" }, "Northbound")).toBe("A · Your car · Northbound");
  });
});
