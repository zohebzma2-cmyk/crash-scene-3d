// At impact the physics lets the two vehicle boxes touch with zero overlap. This checks that what the
// viewer DRAWS agrees: the projected silhouettes of A and B (wheels, mirrors, bumpers and all) overlap
// by no more than 2 px in the Top view, at desktop and phone sizes, for all three examples. It also
// checks the framing: the crash area fills about 60-70% of the view.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Matrix4, OrthographicCamera, PerspectiveCamera, Vector3, type BufferGeometry, type Camera } from "three";
import { parseScene, simulate, type Pose, type Scene, type SimulationResult, type VehicleResult } from "@csd/core";
import { loadRoads } from "../../../../packages/exports/test/osm-roads";
import { approachPose, cameraFor, headingToYaw, toThree, type Viewport } from "../../src/viewer/math";
import { disposeVehicleModels, mergedModel, vehicleModel } from "../../src/viewer/vehicle-models";

const EXAMPLES = ["t-bone-intersection", "highway-rear-end", "parking-lot-backing"] as const;
const VIEWPORTS: Viewport[] = [{ w: 1440, h: 810 }, { w: 390, h: 420 }];

function load(name: string): { scene: Scene; sim: SimulationResult } {
  const parsed = parseScene(JSON.parse(readFileSync(new URL(`../../../../examples/${name}/scene.json`, import.meta.url), "utf8")));
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  const scene = parsed.value;
  const roads = loadRoads(name, { lat: scene.location.lat, lon: scene.location.lon });
  const out = simulate(scene, roads);
  if (!out.ok) throw new Error(out.errors.map((e) => e.text).join("; "));
  return { scene, sim: out.result };
}

function cameraOf(view: "top" | "wide", sim: SimulationResult, vp: Viewport): Camera {
  const spec = cameraFor(view, sim, () => null, vp, null);
  let cam: OrthographicCamera | PerspectiveCamera;
  if (spec.kind === "orthographic") {
    cam = new OrthographicCamera(-vp.w / 2, vp.w / 2, vp.h / 2, -vp.h / 2, 0.3, 4000);
    cam.zoom = spec.zoom;
  } else cam = new PerspectiveCamera(spec.fovDeg, vp.w / vp.h, 0.3, 4000);
  cam.position.set(...spec.position);
  cam.lookAt(...spec.target);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
  return cam;
}

/** Every vertex of the vehicle model, placed at `pose` and projected to screen px. */
function projectModel(v: VehicleResult, pose: Pose, cam: Camera, vp: Viewport): Array<[number, number]> {
  const model = vehicleModel(v.type, v.lengthM, v.widthM);
  const g: BufferGeometry = mergedModel(model);
  const m = new Matrix4().makeRotationY(headingToYaw(pose.headingRad)).setPosition(...toThree({ x: pose.xM, y: pose.yM }, 0));
  const pos = g.getAttribute("position");
  const p = new Vector3();
  const out: Array<[number, number]> = [];
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i).applyMatrix4(m).project(cam);
    out.push([((p.x + 1) / 2) * vp.w, ((1 - p.y) / 2) * vp.h]);
  }
  g.dispose();
  return out;
}

function hull(points: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]) as Array<[number, number]>;
  const cross = (o: readonly [number, number], a: readonly [number, number], b: readonly [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const build = (list: Array<[number, number]>) => {
    const h: Array<[number, number]> = [];
    for (const p of list) { while (h.length >= 2 && cross(h[h.length - 2]!, h[h.length - 1]!, p) <= 0) h.pop(); h.push(p); }
    h.pop();
    return h;
  };
  return [...build(pts), ...build([...pts].reverse())];
}

/** How deep two convex polygons overlap, px: 0 when a separating axis exists (they touch or are apart). */
function penetration(a: Array<[number, number]>, b: Array<[number, number]>): number {
  let min = Infinity;
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!, q = poly[(i + 1) % poly.length]!;
      const ax = -(q[1] - p[1]), ay = q[0] - p[0], len = Math.hypot(ax, ay) || 1;
      const proj = (pts: Array<[number, number]>) => { const d = pts.map((r) => (r[0] * ax + r[1] * ay) / len); return [Math.min(...d), Math.max(...d)] as const; };
      const [a0, a1] = proj(a), [b0, b1] = proj(b);
      const overlap = Math.min(a1, b1) - Math.max(a0, b0);
      if (overlap <= 0) return 0;
      min = Math.min(min, overlap);
    }
  }
  return min;
}

describe("Top view: A and B touch at impact without overlapping on screen", () => {
  for (const name of EXAMPLES) {
    const { sim } = load(name);
    for (const vp of VIEWPORTS) {
      it(`${name} at ${vp.w}x${vp.h}: silhouettes overlap by at most 2 px`, () => {
        const cam = cameraOf("top", sim, vp);
        const [a, b] = sim.vehicles;
        const sa = hull(projectModel(a!, a!.impactPose, cam, vp)), sb = hull(projectModel(b!, b!.impactPose, cam, vp));
        expect(penetration(sa, sb)).toBeLessThanOrEqual(2);
      });
    }
  }
  it("the Top camera is orthographic, so tall boxes don't lean", () => {
    const { sim } = load("t-bone-intersection");
    expect(cameraFor("top", sim, () => null, VIEWPORTS[0]!, null).kind).toBe("orthographic");
  });
});

describe("framing: the crash area fills about 60-70% of the view", () => {
  /** Extent of the vehicles' boxes at impact and rest (plus, in Wide, 2 s before), as a share of the viewport's limiting side. */
  function fill(sim: SimulationResult, view: "top" | "wide", vp: Viewport): number {
    const cam = cameraOf(view, sim, vp);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const v of sim.vehicles) {
      const poses = [v.impactPose, v.restPose];
      if (view === "wide") { const early = approachPose(sim, v); if (early) poses.push(early); }
      for (const pose of poses) for (const [x, y] of projectModel(v, pose, cam, vp)) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    }
    return Math.max((maxX - minX) / vp.w, (maxY - minY) / vp.h);
  }
  for (const name of EXAMPLES) {
    const { sim } = load(name);
    for (const vp of VIEWPORTS) {
      for (const view of ["top", "wide"] as const) {
        it(`${name} ${view} at ${vp.w}x${vp.h}`, () => {
          const f = fill(sim, view, vp);
          // Between half and three quarters of the view (the spec is about 60-70%); never cut off. (A tiny crash is held to a minimum
          // span, so it may fill less than 60%, but a big one is never cut off.)
          expect(f).toBeGreaterThan(0.5);
          expect(f).toBeLessThan(0.76);
          disposeVehicleModels();
        });
      }
    }
  }
});
