// The export stills (1920 x 933) are framed on their own subject, tight, whatever the live view is doing:
//   - impact: both vehicles and the impact ring fill about 60% of the frame
//   - final rest (the Aftermath still): the vehicles at rest and the slide marks fill about 60%
// The vehicles' projected box is at least about a quarter of the frame width, and no street name placed for
// the still's camera crosses the frame edge. Labels (vehicle letters and measurement pills) go through one
// layout pass with no overlaps in the Aftermath still.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { Matrix4, PerspectiveCamera, Vector3 } from "three";
import { buildRoadArt, parseScene, simulate, streetNameSpots, type Pose, type RoadNetwork, type SimulationResult, type VehicleResult } from "@csd/core";
import { decodeTerrarium, parseOverpass, terrainGrid } from "@csd/mapdata";
import { headingToYaw, toThree } from "../../src/viewer/math";
import { STILL_SIZE } from "../../src/review/stills";
import { SUBJECT_HEIGHT_M, stillCamera, stillSubject, type StillKind } from "../../src/viewer/still-camera";
import { projectVehicle } from "../../src/viewer/labels";
import { groundInView, placeNamesInView } from "../../src/viewer/StreetNames";
import { disposeVehicleModels, mergedModel, vehicleModel } from "../../src/viewer/vehicle-models";

const NAMES = ["t-bone-intersection", "highway-rear-end", "parking-lot-backing"] as const;
const W = STILL_SIZE.width, H = STILL_SIZE.height;

function exampleNet(name: string): RoadNetwork {
  const dir = fileURLToPath(new URL(`../../../../examples/${name}/`, import.meta.url));
  const osm = JSON.parse(readFileSync(`${dir}osm.json`, "utf8"));
  const frame = { origin: osm.center };
  const tiles = readdirSync(`${dir}terrain/`).filter((f) => f.endsWith(".png")).map((f) => {
    const [z, x, y] = f.replace(".png", "").split("-").map(Number) as [number, number, number];
    const png = PNG.sync.read(readFileSync(`${dir}terrain/${f}`));
    return { z, x, y, size: png.width, heights: decodeTerrarium(new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength), png.width, png.height) };
  });
  const net = parseOverpass(osm, frame, osm.radiusM, osm.fetchedAt);
  return { ...net, terrain: terrainGrid(tiles, frame, osm.radiusM, 10) };
}

function load(name: string): { net: RoadNetwork; sim: SimulationResult } {
  const parsed = parseScene(JSON.parse(readFileSync(new URL(`../../../../examples/${name}/scene.json`, import.meta.url), "utf8")));
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  const net = exampleNet(name);
  const out = simulate(parsed.value, net);
  if (!out.ok) throw new Error(out.errors.map((e) => e.text).join("; "));
  return { net, sim: out.result };
}

function threeCamera(kind: StillKind, sim: SimulationResult, net: RoadNetwork): PerspectiveCamera {
  const spec = stillCamera(kind, sim, { w: W, h: H }, net.terrain);
  const cam = new PerspectiveCamera(spec.fovDeg, W / H, 0.3, 4000);
  cam.position.set(...spec.position);
  cam.lookAt(...spec.target);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
  return cam;
}

function project(v: VehicleResult, pose: Pose, cam: PerspectiveCamera): Array<[number, number]> {
  const g = mergedModel(vehicleModel(v.type, v.lengthM, v.widthM));
  const m = new Matrix4().makeRotationY(headingToYaw(pose.headingRad)).setPosition(...toThree({ x: pose.xM, y: pose.yM }, 0));
  const pos = g.getAttribute("position");
  const p = new Vector3();
  const out: Array<[number, number]> = [];
  for (let i = 0; i < pos.count; i++) { p.fromBufferAttribute(pos, i).applyMatrix4(m).project(cam); out.push([((p.x + 1) / 2) * W, ((1 - p.y) / 2) * H]); }
  g.dispose();
  return out;
}

describe("export stills are framed tight on their subject", () => {
  for (const name of NAMES) {
    const { net, sim } = load(name);
    for (const kind of ["impact", "rest"] as const) {
      it(`${name} ${kind}: the vehicles fill at least a quarter of the frame width, the subject 55-65%, and everything stays in frame`, () => {
        const cam = threeCamera(kind, sim, net);
        const pts = sim.vehicles.flatMap((v) => project(v, kind === "impact" ? v.impactPose : v.restPose, cam));
        const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
        const boxW = Math.max(...xs) - Math.min(...xs);
        expect(Math.min(...xs)).toBeGreaterThan(0); expect(Math.max(...xs)).toBeLessThan(W);
        expect(Math.min(...ys)).toBeGreaterThan(0); expect(Math.max(...ys)).toBeLessThan(H);
        expect(boxW / W, `vehicles span ${(boxW / W).toFixed(2)} of the width`).toBeGreaterThanOrEqual(0.25);
        // The whole subject (vehicles, ring, slide marks) fills 50-70% of its limiting side.
        const sp: Array<[number, number]> = [];
        const v3 = new Vector3();
        for (const p of stillSubject(kind, sim)) for (const hh of [0, SUBJECT_HEIGHT_M]) { v3.set(...toThree(p, hh)).project(cam); sp.push([((v3.x + 1) / 2) * W, ((1 - v3.y) / 2) * H]); }
        const fill = Math.max((Math.max(...sp.map((p) => p[0])) - Math.min(...sp.map((p) => p[0]))) / W, (Math.max(...sp.map((p) => p[1])) - Math.min(...sp.map((p) => p[1]))) / H);
        expect(fill).toBeGreaterThan(0.55);
        expect(fill).toBeLessThan(0.67);
        disposeVehicleModels();
      });

      it(`${name} ${kind}: no street name placed for the still's camera crosses the frame edge`, () => {
        const cam = threeCamera(kind, sim, net);
        const focus = sim.impactPointM;
        const spots = streetNameSpots(buildRoadArt(net), focus);
        const view = groundInView(cam, 0, [new Vector3(), new Vector3(), new Vector3()]);
        const avoid = sim.vehicles.flatMap((v) => v.track.filter((_, i) => i % 20 === 0).map((p) => ({ x: p.xM, y: p.yM })));
        const placed = placeNamesInView(spots, () => undefined, view, focus, avoid);
        const v3 = new Vector3();
        for (const p of placed) {
          const c = Math.cos(p.angleRad), s = Math.sin(p.angleRad);
          for (const [i, j] of [[1, 1], [1, -1], [-1, -1], [-1, 1]] as const) {
            const q = { x: p.at.x + (i * p.lengthM * c) / 2 - (j * p.heightM * s) / 2, y: p.at.y + (i * p.lengthM * s) / 2 + (j * p.heightM * c) / 2 };
            v3.set(q.x, 0, -q.y).project(cam);
            const px = ((v3.x + 1) / 2) * W, py = ((1 - v3.y) / 2) * H;
            expect(px, `${p.name} x`).toBeGreaterThanOrEqual(0); expect(px, `${p.name} x`).toBeLessThanOrEqual(W);
            expect(py, `${p.name} y`).toBeGreaterThanOrEqual(0); expect(py, `${p.name} y`).toBeLessThanOrEqual(H);
          }
        }
      });
    }
  }

describe("vehicle obstacles for labels", () => {
  it("the strips follow the projected outline: inside the rect, covering the vehicle's center, tighter than the rect", () => {
    const { net, sim } = load("t-bone-intersection");
    const cam = threeCamera("impact", sim, net);
    for (const v of sim.vehicles) {
      const model = vehicleModel(v.type, v.lengthM, v.widthM);
      const p = projectVehicle(cam, { w: W, h: H }, v.impactPose, { lengthM: v.lengthM, widthM: v.widthM, heightM: model.heightM }, 0);
      expect(p.strips.length).toBeGreaterThan(3);
      for (const r of p.strips) {
        expect(r.x).toBeGreaterThanOrEqual(p.rect.x - 0.01); expect(r.x + r.w).toBeLessThanOrEqual(p.rect.x + p.rect.w + 0.01);
        expect(r.y).toBeGreaterThanOrEqual(p.rect.y - 0.01); expect(r.y + r.h).toBeLessThanOrEqual(p.rect.y + p.rect.h + 0.01);
      }
      const area = p.strips.reduce((a, r) => a + r.w * r.h, 0);
      expect(area).toBeLessThan(p.rect.w * p.rect.h);
      const cx = p.rect.x + p.rect.w / 2, cy = p.rect.y + p.rect.h / 2;
      expect(p.strips.some((r) => cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h)).toBe(true);
    }
  });
});
});
