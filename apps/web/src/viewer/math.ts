// Pure helpers for the 3D viewer. This is the rendering boundary: the scene is
// in SI local ENU (x east, y north, compass headings); three.js is y-up with
// -z forward. Every conversion between the two happens here, nowhere else.
import type { Pose, RoadNetwork, SimulationResult, TerrainGrid, Vec2, VehicleResult } from "@csd/core";
import { AFTERMATH_ELEVATION_DEG, AFTERMATH_FILL, aftermathBox } from "./effects/aftermath";
import type { CameraView } from "./types";

/** Local ENU (meters) + height → three.js position [x, y(up), z]. North is −z. */
export function toThree(p: Vec2, heightM = 0): [number, number, number] {
  return [p.x, heightM, -p.y];
}

/**
 * Compass heading (radians, 0 = north, clockwise seen from above) → three.js
 * rotation about +y. Models are built facing −z (north); a positive y rotation
 * turns counter-clockwise seen from above, so the sign flips.
 */
export function headingToYaw(headingRad: number): number {
  return -headingRad;
}

/** Ground height at a point, bilinear in the terrain grid; 0 without terrain or outside it. */
export function heightAt(terrain: TerrainGrid | null, p: Vec2): number {
  if (!terrain) return 0;
  const gx = (p.x - terrain.originM.x) / terrain.cellM;
  const gy = (p.y - terrain.originM.y) / terrain.cellM;
  if (gx < 0 || gy < 0 || gx > terrain.cols - 1 || gy > terrain.rows - 1) return 0;
  const x0 = Math.floor(gx), y0 = Math.floor(gy);
  const x1 = Math.min(x0 + 1, terrain.cols - 1), y1 = Math.min(y0 + 1, terrain.rows - 1);
  const fx = gx - x0, fy = gy - y0;
  const h = (x: number, y: number) => terrain.heightsM[y * terrain.cols + x] ?? 0;
  return (h(x0, y0) * (1 - fx) + h(x1, y0) * fx) * (1 - fy) + (h(x0, y1) * (1 - fx) + h(x1, y1) * fx) * fy;
}

export interface Box { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number }

/**
 * How much of the approach "wide" frames, in seconds before impact. The
 * physics window is longer (5 s; a highway follower starts ~120 m back), and
 * framing all of it would shrink the crash to a dot. Playback can still show
 * the earlier part as vehicles drive in from the edge.
 */
export const WIDE_APPROACH_S = 2;
/** ...and never more than this far back along the approach, so a fast highway follower doesn't shrink the crash to a dot. */
export const WIDE_APPROACH_MAX_M = 25;

/** The track pose `secondsBefore` impact (clamped to the track). */
export function poseBeforeImpact(sim: SimulationResult, track: readonly Pose[], secondsBefore: number): Pose | undefined {
  if (!track.length) return undefined;
  const i = Math.round((-secondsBefore - sim.startTimeS) / sim.dtS);
  return track[Math.min(Math.max(i, 0), track.length - 1)];
}

/** The pose WIDE_APPROACH_S before impact, pulled in to within WIDE_APPROACH_MAX_M of the impact pose. */
export function approachPose(sim: SimulationResult, v: VehicleResult): Pose | undefined {
  const early = poseBeforeImpact(sim, v.track, WIDE_APPROACH_S);
  if (!early) return undefined;
  const i0 = v.track.indexOf(early);
  for (let i = Math.max(i0, 0); i < v.track.length; i++) {
    const p = v.track[i]!;
    if (Math.hypot(p.xM - v.impactPose.xM, p.yM - v.impactPose.yM) <= WIDE_APPROACH_MAX_M) return p;
  }
  return v.impactPose;
}

/** The corners of every vehicle's box at the poses worth framing (impact, rest, and in "wide" the last WIDE_APPROACH_S of the approach), plus the impact point. */
export function framingPoints(sim: SimulationResult, wide: boolean): Vec2[] {
  const pts: Vec2[] = [sim.impactPointM];
  for (const v of sim.vehicles) {
    const poses: Pose[] = [v.impactPose, v.restPose];
    const early = wide ? approachPose(sim, v) : undefined;
    if (early) poses.push(early);
    for (const p of poses) {
      const fx = Math.sin(p.headingRad), fy = Math.cos(p.headingRad);          // forward
      const rx = fy, ry = -fx;                                                    // right
      for (const [a, b] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
        pts.push({ x: p.xM + fx * a * (v.lengthM / 2) + rx * b * (v.widthM / 2), y: p.yM + fy * a * (v.lengthM / 2) + ry * b * (v.widthM / 2) });
      }
    }
  }
  return pts;
}

/** Bounds of everything worth framing (see framingPoints), grown by `marginM`. */
export function framingBounds(sim: SimulationResult, wide: boolean, marginM = 6): Box {
  const pts = framingPoints(sim, wide);
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return { minX: Math.min(...xs) - marginM, minY: Math.min(...ys) - marginM, maxX: Math.max(...xs) + marginM, maxY: Math.max(...ys) + marginM };
}

export type Viewport = { readonly w: number; readonly h: number };

export interface CameraSpec {
  /** Top is orthographic, so footprints read exactly (no perspective lean on tall boxes); the rest are perspective. */
  readonly kind: "perspective" | "orthographic";
  readonly position: [number, number, number];
  readonly target: [number, number, number];
  readonly fovDeg: number;
  /** Orthographic only: pixels per meter at this viewport (R3F sizes an orthographic frustum in pixels). */
  readonly zoom: number;
}

/** How much of the view the crash area fills: Top is tight, Wide shows a little context. */
export const TOP_FILL = 0.7;
export const WIDE_FILL = 0.78;
/** The crash area is never framed tighter than this span, so a parking-lot bump isn't a close-up. */
export const MIN_SPAN_M = 7;
const MIN_WIDE_DISTANCE_M = 14;
/** Tallest thing worth keeping in frame in Wide (a box truck), meters. */
const FRAME_HEIGHT_M = 3.6;
const WIDE_ELEVATION_RAD = (50 * Math.PI) / 180;
const WIDE_AZIMUTH_RAD = (160 * Math.PI) / 180;

type V3 = readonly [number, number, number];

/**
 * The distance from `target`, along `dir` (unit vector from the target toward the camera), at which every
 * point projects within `fill` of the half-width and half-height of a view with this fov and aspect.
 */
export function fitDistance(points: readonly V3[], target: V3, dir: V3, fovDeg: number, aspect: number, fill: number): number {
  // Camera basis: forward f = -dir, right = f x worldUp, up = right x f.
  const f: V3 = [-dir[0], -dir[1], -dir[2]];
  let rx = -f[2], rz = f[0];
  const ry = 0;
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl; rz /= rl;
  const ux = ry * f[2] - rz * f[1], uy = rz * f[0] - rx * f[2], uz = rx * f[1] - ry * f[0];
  const th = Math.tan((fovDeg * Math.PI) / 360);
  let d = 0;
  for (const p of points) {
    const px = p[0] - target[0], py = p[1] - target[1], pz = p[2] - target[2];
    const x = px * rx + py * ry + pz * rz, y = px * ux + py * uy + pz * uz;
    const toward = px * dir[0] + py * dir[1] + pz * dir[2];
    d = Math.max(d, toward + Math.abs(x) / (fill * th * aspect), toward + Math.abs(y) / (fill * th));
  }
  return d;
}

/** A crash this much longer than it is wide (a highway pile-up) is viewed along its length. */
const ELONGATED_RATIO = 2.2;

/**
 * Where the Wide camera stands, as a compass azimuth (radians): from the south-south-east, unless the crash
 * area is long and thin, when it looks along the crash from behind the approach so the vehicles stay large.
 */
export function wideAzimuth(sim: SimulationResult): number {
  const pts = framingPoints(sim, true);
  const n = pts.length;
  const mx = pts.reduce((a, p) => a + p.x, 0) / n, my = pts.reduce((a, p) => a + p.y, 0) / n;
  let cxx = 0, cyy = 0, cxy = 0;
  for (const p of pts) { cxx += (p.x - mx) ** 2; cyy += (p.y - my) ** 2; cxy += (p.x - mx) * (p.y - my); }
  const theta = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
  const mean = (a: number, b: number) => (a + b) / 2;
  const root = Math.sqrt(((cxx - cyy) / 2) ** 2 + cxy ** 2);
  const l1 = mean(cxx, cyy) + root, l2 = Math.max(mean(cxx, cyy) - root, 1e-6);
  if (Math.sqrt(l1 / l2) < ELONGATED_RATIO) return WIDE_AZIMUTH_RAD;
  const ux = Math.sin(Math.PI / 2 - theta), uy = Math.cos(Math.PI / 2 - theta);          // major axis, east/north
  let ex = 0, ey = 0, rx = 0, ry = 0, k = 0;
  for (const v of sim.vehicles) {
    const early = approachPose(sim, v);
    if (!early) continue;
    ex += early.xM; ey += early.yM; rx += v.restPose.xM; ry += v.restPose.yM; k++;
  }
  const sign = k > 0 && (ex - rx) * ux + (ey - ry) * uy < 0 ? -1 : 1;
  return Math.atan2(sign * ux, sign * uy);
}

/** The Aftermath view's camera: the aftermath box (effects/aftermath.ts), seen from the same side as Wide, steeper so the marks read. */
function aftermathSpec(sim: SimulationResult, aspect: number, terrain: TerrainGrid | null, extraPoints: readonly Vec2[], fovDeg: number): CameraSpec {
  const b = aftermathBox(sim, extraPoints);
  const c: Vec2 = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
  const ground = heightAt(terrain, c);
  const el = (AFTERMATH_ELEVATION_DEG * Math.PI) / 180;
  const dir: V3 = [Math.sin(WIDE_AZIMUTH_RAD) * Math.cos(el), Math.sin(el), -Math.cos(WIDE_AZIMUTH_RAD) * Math.cos(el)];
  const target: [number, number, number] = [c.x, ground, -c.y];
  const pts: V3[] = [];
  for (const x of [b.minX, b.maxX]) for (const y of [b.minY, b.maxY]) for (const hh of [0, FRAME_HEIGHT_M]) pts.push([x, ground + hh, -y]);
  const d = Math.max(fitDistance(pts, target, dir, fovDeg, aspect, AFTERMATH_FILL), MIN_WIDE_DISTANCE_M);
  return { kind: "perspective", position: [target[0] + dir[0] * d, target[1] + dir[1] * d, target[2] + dir[2] * d], target, fovDeg, zoom: 1 };
}

/**
 * Camera for a preset.
 * - Top: orthographic, straight down, the impact and rest area filling TOP_FILL of the limiting side.
 * - Wide: perspective from the south-south-east, the impact, rest and last WIDE_APPROACH_S of the approach filling WIDE_FILL.
 * - Aftermath: perspective from the south-south-east and a little steeper than Wide, framing the impact, both vehicles at rest, their slide paths and the debris field.
 * - Driver: behind and above the vehicle at time t, looking along its heading (a chase view that keeps the whole vehicle clear).
 */
export function cameraFor(view: CameraView, sim: SimulationResult, pose: (id: "A" | "B") => Pose | null, viewport: Viewport, terrain: TerrainGrid | null, extraPoints: readonly Vec2[] = []): CameraSpec {
  const fovDeg = 45;
  const aspect = viewport.w / Math.max(viewport.h, 1);
  if (view === "aftermath") return aftermathSpec(sim, aspect, terrain, extraPoints, fovDeg);   // FX: effects/aftermath.ts
  if (view === "driver-a" || view === "driver-b") {
    const id = view === "driver-a" ? "A" : "B";
    const p = pose(id);
    if (p) {
      const len = sim.vehicles.find((v) => v.id === id)?.lengthM ?? 4.8;
      const back = Math.max(9, len * 1.4 + 4), up = 3.2 + Math.max(0, len - 5) * 0.35;
      const fx = Math.sin(p.headingRad), fy = Math.cos(p.headingRad);
      const eye: Vec2 = { x: p.xM - fx * back, y: p.yM - fy * back };
      const look: Vec2 = { x: p.xM + fx * 6, y: p.yM + fy * 6 };
      return { kind: "perspective", position: toThree(eye, heightAt(terrain, eye) + up), target: toThree(look, heightAt(terrain, look) + 1), fovDeg, zoom: 1 };
    }
  }
  const wide = view !== "top";
  const b = framingBounds(sim, wide, 0);
  const c: Vec2 = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
  const w = Math.max(b.maxX - b.minX, MIN_SPAN_M), h = Math.max(b.maxY - b.minY, MIN_SPAN_M);
  const ground = heightAt(terrain, c);
  if (!wide) {
    const zoom = TOP_FILL * Math.min(viewport.w / w, viewport.h / h);
    return { kind: "orthographic", position: [c.x, ground + 400, -c.y + 0.001], target: [c.x, ground, -c.y], fovDeg, zoom };
  }
  const az = wideAzimuth(sim);
  const dir: V3 = [Math.sin(az) * Math.cos(WIDE_ELEVATION_RAD), Math.sin(WIDE_ELEVATION_RAD), -Math.cos(az) * Math.cos(WIDE_ELEVATION_RAD)];
  const target: [number, number, number] = [c.x, ground, -c.y];
  // The real corner points (not their bounding rectangle), at ground level and at vehicle height; a tiny crash is padded to MIN_SPAN_M.
  const pts: Array<[number, number, number]> = [];
  for (const p of framingPoints(sim, true)) for (const hh of [0, FRAME_HEIGHT_M]) pts.push([p.x, ground + hh, -p.y]);
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) pts.push([target[0] + (sx * MIN_SPAN_M) / 2, ground, target[2] + (sy * MIN_SPAN_M) / 2]);
  const d = Math.max(fitDistance(pts, target, dir, fovDeg, aspect, WIDE_FILL), MIN_WIDE_DISTANCE_M);
  const eye: [number, number, number] = [target[0] + dir[0] * d, target[1] + dir[1] * d, target[2] + dir[2] * d];
  return { kind: "perspective", position: eye, target, fovDeg, zoom: 1 };
}

/* ---------------- compass ---------------- */
/** Below this much horizontal length the camera's screen-up has no usable direction on the ground (straight down is handled by its roll). */
const UP_EPS = 1e-4;
/** A camera straight above its target keeps this much horizontal offset, so its azimuth (and "north up") stays defined. */
export const MIN_ORBIT_RADIUS_M = 0.001;

const TWO_PI = Math.PI * 2;
/** An angle wrapped to (-π, π]. */
export function wrapAngle(a: number): number {
  const w = ((((a + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI) - Math.PI;
  return w === -Math.PI ? Math.PI : w;
}

/**
 * Compass heading (radians, 0 = north, clockwise seen from above) of what is "up the screen", on the ground.
 * In the Top view that is the direction the picture's top edge faces; in a tilted view it is the direction the camera looks.
 * Inputs are three.js world components: the camera's up axis (matrixWorld elements 4 and 6) and its forward axis
 * (the negated elements 8 and 10), used when the camera looks straight at the horizon or straight down with no roll.
 * North is three's −z and east is +x, so heading = atan2(x, −z).
 */
export function screenUpHeading(upX: number, upZ: number, forwardX: number, forwardZ: number): number {
  if (Math.hypot(upX, upZ) >= UP_EPS) return Math.atan2(upX, -upZ);
  return Math.atan2(forwardX, -forwardZ);
}

/** How far to turn the north arrow (CSS degrees, clockwise) when the screen's up is at this heading: the arrow points at north. */
export function compassRotationDeg(headingRad: number): number {
  const d = (-headingRad * 180) / Math.PI;
  const w = ((((d + 180) % 360) + 360) % 360) - 180;
  return w === -180 ? 180 : w;
}

/** A camera orbit around its target: the azimuth it stands at (θ = atan2(x, z) of its offset, 0 = due south of the target), and the rest of the offset. */
export interface NorthSpin { readonly theta0: number; readonly delta: number; readonly radius: number; readonly y: number }

/**
 * The turn that makes north up: the camera ends due south of its target (θ = 0, so it looks north and the top of the
 * picture is north), by the shorter way round, keeping its distance, height and elevation.
 */
export function northUpSpin(offsetX: number, offsetY: number, offsetZ: number): NorthSpin {
  const radius = Math.max(Math.hypot(offsetX, offsetZ), MIN_ORBIT_RADIUS_M);
  // Straight above the target there is no azimuth in the position; the offset is tiny and still has one, else it counts as 0.
  const theta0 = Math.hypot(offsetX, offsetZ) > 0 ? Math.atan2(offsetX, offsetZ) : 0;
  return { theta0, delta: wrapAngle(-theta0), radius, y: offsetY };
}

/** The camera's offset from its target `k` (0 to 1) of the way through the turn. Writes into `out` (no allocation per frame). */
export function spunOffset(spin: NorthSpin, k: number, out: [number, number, number]): [number, number, number] {
  const th = spin.theta0 + spin.delta * k;
  out[0] = spin.radius * Math.sin(th);
  out[1] = spin.y;
  out[2] = spin.radius * Math.cos(th);
  return out;
}

/* ---------------- labels ---------------- */
export interface Rect { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
export type LabelDir = "C" | "N" | "S" | "E" | "W" | "NE" | "NW" | "SE" | "SW";

export interface LabelRequest {
  readonly id: string;
  /** The point the label belongs to (a vehicle's projected top, a measurement's midpoint), px. */
  readonly anchor: { readonly x: number; readonly y: number };
  /** What the label sits next to: the vehicle's projected box (a pill uses a zero-size rect at its anchor). */
  readonly rect: Rect;
  readonly w: number;
  readonly h: number;
  /** Directions to try first at each distance, best first. Default: above, below, right, left, then the corners. */
  readonly prefer?: readonly LabelDir[];
  /** This label's own search radius, px (a measurement pill may stray further than a vehicle label). Default: the layout's. */
  readonly maxDistance?: number;
}

export interface PlacedLabel {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Straight line from the anchor to the label, drawn when the label is not in its first-choice place. */
  readonly leader: { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number } | null;
  /** Gap from the thing it labels to the label, px (0 when touching or overlapping). */
  readonly distance: number;
  /** True when the first-choice spot was taken and a later candidate was used. */
  readonly moved: boolean;
  /** False when the thing labeled is off screen: the label is left out (DESIGN section 7). */
  readonly visible: boolean;
}

export interface LayoutOptions {
  readonly viewport: Viewport;
  /** Rectangles no label may cover: the vehicle bodies and the impact ring. Covered only as the very last resort. */
  readonly obstacles?: readonly Rect[];
  /** The view controls, zoom buttons, legend and caption: kept clear too, but a label may sit under one before it covers an obstacle. */
  readonly controls?: readonly Rect[];
  /** A label stays within this distance of what it labels, px. */
  readonly maxDistance?: number;
  /**
   * How far a label may go (with a leader line back to its anchor) when nothing within `maxDistance` is clear of
   * the obstacles. Default: `maxDistance`, so a layout without it never goes further.
   */
  readonly farDistance?: number;
  /** Space kept between labels and from obstacles, px. */
  readonly gap?: number;
  /** Distance added per ring of candidates, px. */
  readonly step?: number;
}

export const LABEL_MAX_DISTANCE_PX = 64;
const DIR_ORDER: readonly LabelDir[] = ["N", "S", "E", "W", "NE", "NW", "SE", "SW"];
const DIAG = Math.SQRT1_2;

const overlap = (a: Rect, b: Rect, gap: number) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
export const rectsOverlap = overlap;
export const rectDistance = (a: Rect, b: Rect): number => Math.hypot(Math.max(0, b.x - (a.x + a.w), a.x - (b.x + b.w)), Math.max(0, b.y - (a.y + a.h), a.y - (b.y + b.h)));

function candidate(dir: LabelDir, r: LabelRequest, d: number): Rect {
  const { rect: t, w, h } = r;
  const cx = t.x + t.w / 2, cy = t.y + t.h / 2, k = d * DIAG;
  switch (dir) {
    case "C": return { x: cx - w / 2, y: cy - h / 2, w, h };
    case "N": return { x: cx - w / 2, y: t.y - d - h, w, h };
    case "S": return { x: cx - w / 2, y: t.y + t.h + d, w, h };
    case "E": return { x: t.x + t.w + d, y: cy - h / 2, w, h };
    case "W": return { x: t.x - d - w, y: cy - h / 2, w, h };
    case "NE": return { x: t.x + t.w + k, y: t.y - k - h, w, h };
    case "NW": return { x: t.x - k - w, y: t.y - k - h, w, h };
    case "SE": return { x: t.x + t.w + k, y: t.y + t.h + k, w, h };
    default: return { x: t.x - k - w, y: t.y + t.h + k, w, h };
  }
}

/**
 * Labels stay attached and never collide. Each label belongs to a rectangle (its vehicle's projected box).
 * Candidates run outward from that rectangle in 8 directions at growing distances (first-choice direction
 * first), and the first one that is on screen, off every obstacle and clear of the labels placed before it
 * wins, so labels move as little as they can. No label strays more than `maxDistance` from what it labels;
 * a label that had to move gets a leader line from its anchor. When no candidate is clear, the label may
 * cover a body (never another label); a thing that is entirely off screen gets no label.
 */
export function layoutLabels(labels: readonly LabelRequest[], opts: LayoutOptions): PlacedLabel[] {
  const gap = opts.gap ?? 4, step = opts.step ?? 8;
  const view: Rect = { x: 0, y: 0, w: opts.viewport.w, h: opts.viewport.h };
  const obstacles = opts.obstacles ?? [];
  const controls = opts.controls ?? [];
  const placed: Rect[] = [];
  const out: PlacedLabel[] = [];
  const inside = (c: Rect) => c.x >= 0 && c.y >= 0 && c.x + c.w <= view.w && c.y + c.h <= view.h;
  for (const l of labels) {
    const maxD = l.maxDistance ?? opts.maxDistance ?? LABEL_MAX_DISTANCE_PX;
    const farD = Math.max(maxD, l.maxDistance ?? opts.farDistance ?? maxD);
    const onScreen = overlap(l.rect, view, 0) || (l.anchor.x >= 0 && l.anchor.y >= 0 && l.anchor.x <= view.w && l.anchor.y <= view.h);
    if (!onScreen) {
      out.push({ id: l.id, x: 0, y: 0, w: l.w, h: l.h, leader: null, distance: 0, moved: false, visible: false });
      continue;
    }
    const order: LabelDir[] = [...(l.prefer ?? []), ...DIR_ORDER].filter((d, i, a) => a.indexOf(d) === i);
    const tries: Array<{ r: Rect; first: boolean }> = [];
    if (order.includes("C")) tries.push({ r: candidate("C", l, 0), first: tries.length === 0 });
    for (let dist = gap; dist <= farD; dist += step) {
      for (const d of order) if (d !== "C") tries.push({ r: candidate(d, l, dist), first: tries.length === 0 });
    }
    const free = (c: Rect, reach: number) => inside(c) && rectDistance(c, l.rect) <= reach + 0.5 && !placed.some((p) => overlap(c, p, gap));
    const clear = (c: Rect, list: readonly Rect[]) => !list.some((o) => overlap(c, o, gap / 2));
    // Nearest first: clear of bodies, the ring and the controls; then the same with a longer leader; then under a control
    // (never over a vehicle or the ring); and only then, covering a vehicle body (never another label).
    let pick = tries.find((t) => free(t.r, maxD) && clear(t.r, obstacles) && clear(t.r, controls));
    if (!pick && farD > maxD) pick = tries.find((t) => free(t.r, farD) && clear(t.r, obstacles) && clear(t.r, controls));
    if (!pick) pick = tries.find((t) => free(t.r, maxD) && clear(t.r, obstacles));
    if (!pick && farD > maxD) pick = tries.find((t) => free(t.r, farD) && clear(t.r, obstacles));
    if (!pick) pick = tries.find((t) => free(t.r, maxD));
    // Last resort: the first choice, pushed inside the view.
    const first = tries[0]!.r;
    pick ??= { r: { ...first, x: Math.min(Math.max(first.x, 0), Math.max(0, view.w - l.w)), y: Math.min(Math.max(first.y, 0), Math.max(0, view.h - l.h)) }, first: false };
    const r = pick.r;
    placed.push(r);
    const moved = !pick.first;
    const nx = Math.min(Math.max(l.anchor.x, r.x), r.x + r.w), ny = Math.min(Math.max(l.anchor.y, r.y), r.y + r.h);
    const leader = moved && Math.hypot(nx - l.anchor.x, ny - l.anchor.y) > 1 ? { x1: l.anchor.x, y1: l.anchor.y, x2: nx, y2: ny } : null;
    out.push({ id: l.id, x: r.x, y: r.y, w: r.w, h: r.h, leader, distance: rectDistance(r, l.rect), moved, visible: true });
  }
  return out;
}

/** Width of a road across all lanes, meters. */
export function roadWidthM(w: RoadNetwork["ways"][number]): number {
  return Math.max(1, w.lanesForward + w.lanesBackward) * w.laneWidthM;
}
