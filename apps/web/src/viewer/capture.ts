// Export stills: the scene at a chosen time, seen from the fixed camera of a chosen view, rendered
// offscreen. Nothing on screen moves: a second renderer draws into its own canvas, the vehicles are
// placed for time t only for the length of that synchronous draw and put back, and the live camera is
// never touched. Vehicle letters and names are drawn into the picture (color is never the only cue).
import { Mesh, MeshBasicMaterial, OrthographicCamera, PerspectiveCamera, PlaneGeometry, Vector3, WebGLRenderer, type Camera, type Group, type Object3D, type Scene as ThreeScene } from "three";
import { buildRoadArt, streetNameSpots, type Pose, type RoadNetwork, type Scene, type SimulationResult, type TerrainGrid, type Units, type Vec2 } from "@csd/core";
import type { CameraView } from "./types";
import { cameraFor, headingToYaw, heightAt, layoutLabels, rectsOverlap, toThree, type LabelRequest, type PlacedLabel, type Rect } from "./math";
import { projectRing, projectVehicle, vehicleLabel } from "./labels";
import { stillCamera } from "./still-camera";
import { LIFT, RING_M, ringPlacement } from "./scene-geometry";
import { drawLabel, groundInView, placeNamesInView, type Label } from "./StreetNames";
import { distanceText, markerRows, measureRows } from "../lib/measure";
import { vehicleToken, type SceneColors } from "./tokens";
import { vehicleModel } from "./vehicle-models";

export interface CaptureContext {
  readonly live: WebGLRenderer;
  readonly scene: ThreeScene;
  readonly sim: SimulationResult;
  readonly doc: Scene;
  readonly units: Units;
  readonly terrain: TerrainGrid | null;
  /** The road layout, to place street names again for the still's own camera. */
  readonly roads: RoadNetwork | null;
  readonly colors: SceneColors;
  readonly groups: ReadonlyMap<string, Group>;
  readonly poseAt: (sim: SimulationResult, id: string, t: number) => Pose;
  /** Optional: set up extra per-time scene state (debris, skid marks) for time t. Returns the function that puts it back. */
  readonly prepare?: (t: number, view: CameraView) => () => void;
  /** Optional: points the Aftermath view must frame besides the vehicles (debris and slide-mark ends). */
  readonly extraPoints?: () => readonly Vec2[];
}

/** Label size on the picture, relative to its height (the on-screen pill is 24 px on a ~600 px view). */
const LABEL_SCALE_OF_HEIGHT = 1 / 600;
const LABEL_H = 24, LABEL_PAD = 12, BADGE = 20, FONT_PX = 12, GAP = 4;

/**
 * The export stills have cameras of their own, tight on their subject and independent of the live view:
 * "wide" is the moment-of-impact still, "aftermath" the final-rest still. Other views keep their preset camera.
 */
function cameraForStill(ctx: CaptureContext, view: CameraView, t: number, w: number, h: number): Camera {
  const spec = view === "wide" ? stillCamera("impact", ctx.sim, { w, h }, ctx.terrain)
    : view === "aftermath" ? stillCamera("rest", ctx.sim, { w, h }, ctx.terrain, ctx.extraPoints?.())
    : cameraFor(view, ctx.sim, (id) => ctx.poseAt(ctx.sim, id, t), { w, h }, ctx.terrain);
  let cam: PerspectiveCamera | OrthographicCamera;
  if (spec.kind === "orthographic") {
    const o = new OrthographicCamera(-w / 2, w / 2, h / 2, -h / 2, 0.3, 4000);
    o.zoom = spec.zoom;
    cam = o;
  } else {
    cam = new PerspectiveCamera(spec.fovDeg, w / h, 0.3, 4000);
  }
  cam.position.set(...spec.position);
  cam.lookAt(...spec.target);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
  return cam;
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** Space kept between a street name and a label, px. */
const NAME_LABEL_GAP_PX = 6;

/** Where the vehicles go, one point every few meters: street names are kept off these (as in the live view). */
const pathPoints = (sim: SimulationResult): Vec2[] => sim.vehicles.flatMap((v) => v.track.filter((_, i) => i % 20 === 0).map((p): Vec2 => ({ x: p.xM, y: p.yM })));

/** A grid of points over each vehicle's box at the poses a still shows, so no street name is laid under a vehicle. */
function footprintPoints(sim: SimulationResult): Vec2[] {
  const out: Vec2[] = [];
  for (const v of sim.vehicles) for (const p of [v.impactPose, v.restPose]) {
    const fx = Math.sin(p.headingRad), fy = Math.cos(p.headingRad);
    for (let i = -2; i <= 2; i++) for (let j = -1; j <= 1; j++) {
      out.push({ x: p.xM + fx * (i * v.lengthM) / 4 + fy * (j * v.widthM) / 2, y: p.yM + fy * (i * v.lengthM) / 4 - fx * (j * v.widthM) / 2 });
    }
  }
  return out;
}

/**
 * Street names for THIS camera: the live names were placed for the live camera and may be cut by the still's
 * frame, so they are hidden and placed again with core's placeStreetNames against the ground this camera shows
 * (whole text inside the frame, or the name is left off). Returns the function that takes them away again.
 */
function addStreetNames(ctx: CaptureContext, cam: Camera, size: { w: number; h: number }, keepClear: readonly Rect[]): () => void {
  const live: Object3D[] = [];
  ctx.scene.traverse((o) => { if (o.name === "street-names" && o.visible) live.push(o); });
  live.forEach((o) => { o.visible = false; });
  const added: Mesh[] = [];
  const labels = new Map<string, Label>();
  if (ctx.roads) {
    const focus = ctx.sim.impactPointM;
    const family = getComputedStyle(document.documentElement).getPropertyValue("--font-sans").trim() || "sans-serif";
    const weight = getComputedStyle(document.documentElement).getPropertyValue("--weight-bold").trim() || "700";
    const spots = streetNameSpots(buildRoadArt(ctx.roads), focus);
    for (const name of new Set(spots.map((sp) => sp.name))) { const l = drawLabel(name, `${weight} 64px ${family}`, ctx.colors.css["--color-scene-label"]); if (l) labels.set(name, l); }
    const view = groundInView(cam, heightAt(ctx.terrain, focus), [new Vector3(), new Vector3(), new Vector3()]);
    const v3 = new Vector3();
    for (const p of placeNamesInView(spots, (name) => labels.get(name)?.aspect, view, focus, [...pathPoints(ctx.sim), ...footprintPoints(ctx.sim)])) {
      const l = labels.get(p.name);
      if (!l) continue;
      // A name that would sit under one of the picture's labels is left off rather than half covered.
      const c = Math.cos(p.angleRad), sn = Math.sin(p.angleRad);
      const box = ([[1, 1], [1, -1], [-1, -1], [-1, 1]] as const).map(([i, j]) => {
        v3.set(p.at.x + (i * p.lengthM * c) / 2 - (j * p.heightM * sn) / 2, heightAt(ctx.terrain, p.at), -(p.at.y + (i * p.lengthM * sn) / 2 + (j * p.heightM * c) / 2)).project(cam);
        return { x: ((v3.x + 1) / 2) * size.w, y: ((1 - v3.y) / 2) * size.h };
      });
      const r: Rect = { x: Math.min(...box.map((q) => q.x)), y: Math.min(...box.map((q) => q.y)), w: Math.max(...box.map((q) => q.x)) - Math.min(...box.map((q) => q.x)), h: Math.max(...box.map((q) => q.y)) - Math.min(...box.map((q) => q.y)) };
      if (keepClear.some((k) => rectsOverlap(r, k, NAME_LABEL_GAP_PX))) continue;
      const m = new Mesh(new PlaneGeometry(p.heightM * (l.canvas.width / 64), p.heightM * (l.canvas.height / 64)), new MeshBasicMaterial({ map: l.texture, transparent: true, depthWrite: false, toneMapped: false }));
      m.position.set(p.at.x, heightAt(ctx.terrain, p.at) + LIFT.paint + 0.04, -p.at.y);
      m.rotation.set(-Math.PI / 2, 0, p.angleRad);
      ctx.scene.add(m);
      added.push(m);
    }
  }
  return () => {
    for (const m of added) { ctx.scene.remove(m); m.geometry.dispose(); (m.material as MeshBasicMaterial).dispose(); }
    labels.forEach((l) => l.texture.dispose());
    live.forEach((o) => { o.visible = true; });
  };
}

/** How far a measurement pill may move from its line on the picture, as a multiple of the label scale (px on a 600 px view). */
const PILL_REACH = 150;

interface DrawItem { readonly id: string; readonly kind: "vehicle" | "measure"; readonly letter: string; readonly text: string; readonly color: string; readonly w: number; readonly h: number }

/**
 * Draw the labels onto the picture: a pill per vehicle (letter badge, name, speed) and, in the Aftermath still, a
 * pill per measurement. All of them go through ONE layout pass (vehicle labels first) with their real measured
 * sizes, a gap between them, leader lines back to what they label, and a longer reach for the measurement pills.
 */
interface LabelPlan { readonly k: number; readonly sans: string; readonly mono: string; readonly items: ReadonlyMap<string, DrawItem>; readonly placed: readonly PlacedLabel[] }

function planLabels(g: CanvasRenderingContext2D, ctx: CaptureContext, cam: Camera, t: number, w: number, h: number, view: CameraView): LabelPlan {
  const k = h * LABEL_SCALE_OF_HEIGHT;
  const css = getComputedStyle(document.documentElement);
  const sans = css.getPropertyValue("--font-sans").trim() || "sans-serif";
  const mono = css.getPropertyValue("--font-mono").trim() || "monospace";
  const items = new Map<string, DrawItem>();
  const requests: LabelRequest[] = [];
  const bodies: Rect[] = [];
  const size = { w, h };
  for (const v of ctx.sim.vehicles) {
    const pose = ctx.poseAt(ctx.sim, v.id, t);
    const model = vehicleModel(v.type, v.lengthM, v.widthM);
    const p = projectVehicle(cam, size, pose, { lengthM: v.lengthM, widthM: v.widthM, heightM: model.heightM }, heightAt(ctx.terrain, { x: pose.xM, y: pose.yM }));
    if (!p.valid) continue;
    bodies.push(...p.strips);
    const label = vehicleLabel(ctx.doc.vehicles.find((x) => x.id === v.id), v.id, pose, t, ctx.units);
    g.font = `600 ${FONT_PX * k}px ${sans}`;
    const item: DrawItem = { id: `v-${v.id}`, kind: "vehicle", letter: v.id, text: label.text, color: ctx.colors.css[vehicleToken(v.id)], w: (LABEL_PAD + BADGE + 8) * k + g.measureText(label.text).width, h: LABEL_H * k };
    items.set(item.id, item);
    requests.push({ id: item.id, anchor: p.anchor, rect: p.rect, w: item.w, h: item.h });
  }
  // The impact ring is kept clear too, as in the live picture.
  const ringAt = ringPlacement(ctx.sim).center;
  bodies.push(...projectRing(cam, size, ringAt, RING_M.outer, heightAt(ctx.terrain, ringAt) + LIFT.ring).strips);
  if (view === "aftermath") {
    const v3 = new Vector3();
    markerRows(measureRows(ctx.sim)).forEach((r, n) => {
      const at = r.anchor!;
      v3.set(...toThree(at, heightAt(ctx.terrain, at) + 0.5)).project(cam);
      if (v3.z > 1) return;
      const x = ((v3.x + 1) / 2) * w, y = ((1 - v3.y) / 2) * h;
      const text = distanceText(r, ctx.units);
      g.font = `600 ${FONT_PX * k}px ${mono}`;
      const item: DrawItem = { id: `m-${r.key}`, kind: "measure", letter: String(n + 1), text, color: ctx.colors.css["--color-scene-measure"], w: (LABEL_PAD + BADGE + 8) * k + g.measureText(text).width, h: LABEL_H * k };
      items.set(item.id, item);
      requests.push({ id: item.id, anchor: { x, y }, rect: { x, y, w: 0, h: 0 }, w: item.w, h: item.h, prefer: ["C"], maxDistance: PILL_REACH * k });
    });
  }
  const placed = layoutLabels(requests, { viewport: size, obstacles: bodies, maxDistance: 64 * k, farDistance: PILL_REACH * k, gap: 2 * GAP * k, step: 8 * k });
  return { k, sans, mono, items, placed };
}

function paintLabels(g: CanvasRenderingContext2D, ctx: CaptureContext, plan: LabelPlan): void {
  const { k, sans, mono, items, placed } = plan;
  for (const pl of placed) {
    if (!pl.visible) continue;
    const it = items.get(pl.id)!;
    if (pl.leader) {
      g.strokeStyle = it.color; g.lineWidth = 2 * k;
      g.beginPath(); g.moveTo(pl.leader.x1, pl.leader.y1); g.lineTo(pl.leader.x2, pl.leader.y2); g.stroke();
      g.fillStyle = it.color; g.beginPath(); g.arc(pl.leader.x1, pl.leader.y1, 3 * k, 0, Math.PI * 2); g.fill();
    }
    g.fillStyle = ctx.colors.css["--color-surface"];
    roundRect(g, pl.x, pl.y, pl.w, pl.h, pl.h / 2); g.fill();
    g.strokeStyle = ctx.colors.css["--color-border-strong"]; g.lineWidth = k;
    g.stroke();
    const bx = pl.x + 2 * k, by = pl.y + (pl.h - BADGE * k) / 2;
    g.fillStyle = it.color;
    g.beginPath(); g.arc(bx + (BADGE * k) / 2, by + (BADGE * k) / 2, (BADGE * k) / 2, 0, Math.PI * 2); g.fill();
    g.textBaseline = "middle"; g.textAlign = "center";
    g.fillStyle = it.kind === "measure" ? ctx.colors.css["--color-surface"] : ctx.colors.css["--color-text-on-brand"];
    g.font = `800 ${FONT_PX * k}px ${sans}`;
    g.fillText(it.letter, bx + (BADGE * k) / 2, by + (BADGE * k) / 2 + k * 0.5);
    g.textAlign = "left";
    g.fillStyle = ctx.colors.css["--color-text"];
    g.font = `600 ${FONT_PX * k}px ${it.kind === "measure" ? mono : sans}`;
    g.fillText(it.text, bx + BADGE * k + 8 * k, pl.y + pl.h / 2 + k * 0.5);
  }
}

/** Render `ctx.scene` at time t from the fixed camera of `view` into a PNG of `size`, with letters and names. */
export async function renderStill(ctx: CaptureContext, t: number, view: CameraView, size: { width: number; height: number }): Promise<Uint8Array> {
  const { width: w, height: h } = size;
  const cam = cameraForStill(ctx, view, t, w, h);
  const renderer = new WebGLRenderer({ canvas: document.createElement("canvas"), antialias: true, preserveDrawingBuffer: true });
  try {
    renderer.setPixelRatio(1);
    renderer.setSize(w, h, false);
    renderer.toneMapping = ctx.live.toneMapping;
    renderer.toneMappingExposure = ctx.live.toneMappingExposure;
    renderer.outputColorSpace = ctx.live.outputColorSpace;
    renderer.shadowMap.enabled = ctx.live.shadowMap.enabled;
    renderer.shadowMap.type = ctx.live.shadowMap.type;
    // Place the vehicles for time t, draw, and put them back before anything else can run.
    const saved = new Map<string, { x: number; y: number; z: number; ry: number }>();
    for (const v of ctx.sim.vehicles) {
      const g = ctx.groups.get(v.id);
      if (!g) continue;
      saved.set(v.id, { x: g.position.x, y: g.position.y, z: g.position.z, ry: g.rotation.y });
      const pose = ctx.poseAt(ctx.sim, v.id, t);
      g.position.set(...toThree({ x: pose.xM, y: pose.yM }, heightAt(ctx.terrain, { x: pose.xM, y: pose.yM })));
      g.rotation.y = headingToYaw(pose.headingRad);
      g.updateMatrixWorld(true);
    }
    const undo = ctx.prepare?.(t, view);
    // The labels are laid out first (they depend only on the camera), so street names can keep clear of them.
    const out = document.createElement("canvas");
    out.width = w; out.height = h;
    const g = out.getContext("2d");
    if (!g) throw new Error("capture failed");
    const plan = planLabels(g, ctx, cam, t, w, h, view);
    const undoNames = addStreetNames(ctx, cam, { w, h }, plan.placed.filter((p) => p.visible));
    try {
      renderer.render(ctx.scene, cam);
    } finally {
      undoNames();
      undo?.();
      for (const [id, s] of saved) {
        const g = ctx.groups.get(id)!;
        g.position.set(s.x, s.y, s.z); g.rotation.y = s.ry; g.updateMatrixWorld(true);
      }
    }
    g.drawImage(renderer.domElement, 0, 0);
    paintLabels(g, ctx, plan);
    const blob: Blob = await new Promise((res, rej) => out.toBlob((b) => (b ? res(b) : rej(new Error("capture failed"))), "image/png"));
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    renderer.dispose();
    renderer.forceContextLoss();
  }
}
