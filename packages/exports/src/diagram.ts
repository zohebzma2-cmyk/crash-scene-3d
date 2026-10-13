// The top-down diagram, planned once as drawing primitives from the
// simulation result (and the road layout when there is one). The PDF and the
// PNG both replay this plan, so they show the same picture. World frame:
// x east, y north, meters. Output frame: y down, in the box's units.
import { M_TO_FT, buildRoadArt, formatDistance, inkOn, placeStreetNames, streetNameSpots, vehicleColor as bodyColor, featureIcon, FEATURE_NAMES, taggedTurnArrows, taggedCrosswalkPaint } from "@csd/core";
import type { Pose, RoadNetwork, SimulationResult, Vec2, VehicleResult, VehicleType } from "@csd/core";
import { roundedRectPts, wrapText, type Measure, type Pt, type Prim } from "./draw";
import { MIN_DRAWN_MOVE_M, markerKeys } from "./model";
import { color, mix, vehicleColor } from "./style";
import { iconPrims } from "./feature-icons";

/** How much of the approach is kept in view (s). The dashed path itself runs the whole approach and is clipped. */
const NEAR_WINDOW_S = 0.6;
/** Never zoom in past this much visible width (m): a tiny scene still shows its road. */
const MIN_SPAN_M = 18;
const PAD_M = 3;
const OPACITY_PATH = 0.6;
const GHOST_MIX = 0.55;
const CURB_M = 0.3;
const MAX_PATH_POINTS = 60;

export interface Box { readonly x: number; readonly y: number; readonly w: number; readonly h: number }

export interface DiagramOptions {
  readonly box: Box;
  /** Letter on each vehicle. */
  readonly letters?: boolean;
  /** Numbered measurement markers. */
  readonly markers?: boolean;
  readonly streetLabels?: boolean;
  /** Ghost outlines where each vehicle was at impact. */
  readonly ghosts?: boolean;
  /** Smallest text size to draw (output units); street names smaller than this are skipped. */
  readonly minTextSize?: number;
  /** Smallest line width (output units). */
  readonly minLine?: number;
  /** Smallest marker / letter circle radius (output units). */
  readonly minTagRadius?: number;
  /** Rectangles drawn over the picture afterwards (the north arrow and scale chip), output units: street names and measurement markers stay clear of them. */
  readonly obstacles?: readonly Rect[];
  /** Space kept free of vehicles, markers and the impact ring (cards drawn over the picture), output units. */
  readonly insets?: { readonly top?: number; readonly right?: number; readonly bottom?: number; readonly left?: number };
  /**
   * Picked paint by vehicle letter ("#rrggbb", from `paintByLetter(model)`). It fills the body at rest through core's
   * `vehicleColor()`; the outline, the ghost, the path and the letter stay in the vehicle token colour.
   */
  readonly paint?: Readonly<Record<string, string>>;
}

export interface Rect { readonly x: number; readonly y: number; readonly w: number; readonly h: number }

export interface DiagramPlan {
  readonly prims: readonly Prim[];
  /** Output units per meter. */
  readonly scale: number;
  /** Marker anchors in output units, in marker order. */
  readonly markers: ReadonlyArray<{ key: string; n: number; at: Pt }>;
  /** The part of the box the scene was fitted into (the box minus the insets). */
  readonly safe: Rect;
  /** Output-unit rectangles that must stay clear of overlays: vehicle bodies at rest and at impact, the short run-up and the impact ring. */
  readonly keep: readonly Rect[];
  /** Outlines of the vehicles at final rest, output units. */
  readonly bodies: ReadonlyArray<readonly Pt[]>;
}

const rad2deg = (r: number) => (r * 180) / Math.PI;

/** Pose at time t from the sampled track (linear; heading by the short way round). */
export function poseAtTime(sim: SimulationResult, rv: VehicleResult, t: number): Pose {
  const tr = rv.track;
  if (tr.length === 0) return t < 0 ? rv.impactPose : rv.restPose;
  const f = Math.min(Math.max((t - sim.startTimeS) / sim.dtS, 0), tr.length - 1);
  const i = Math.floor(f);
  const a = tr[i]!;
  const b = tr[Math.min(i + 1, tr.length - 1)]!;
  const k = f - i;
  let dh = b.headingRad - a.headingRad;
  dh = Math.atan2(Math.sin(dh), Math.cos(dh));
  return { xM: a.xM + (b.xM - a.xM) * k, yM: a.yM + (b.yM - a.yM) * k, headingRad: a.headingRad + dh * k, speedMps: a.speedMps + (b.speedMps - a.speedMps) * k };
}

function decimate<T>(xs: readonly T[], max: number): T[] {
  if (xs.length <= max) return [...xs];
  const step = Math.ceil(xs.length / max);
  const out = xs.filter((_, i) => i % step === 0);
  const last = xs[xs.length - 1]!;
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/** Bounds of everything the diagram has to show (impact, rest, a short run-up), in meters. */
export function sceneBounds(sim: SimulationResult): { minX: number; maxX: number; minY: number; maxY: number } {
  const xs: number[] = [sim.impactPointM.x];
  const ys: number[] = [sim.impactPointM.y];
  for (const rv of sim.vehicles) {
    const r = Math.hypot(rv.lengthM, rv.widthM) / 2 + 0.5;
    for (const p of [rv.impactPose, rv.restPose, poseAtTime(sim, rv, -NEAR_WINDOW_S)]) {
      xs.push(p.xM - r, p.xM + r);
      ys.push(p.yM - r, p.yM + r);
    }
  }
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

interface Transform { readonly s: number; readonly cx: number; readonly cy: number; readonly ox: number; readonly oy: number }
const toPx = (t: Transform, p: Vec2 | Pt): Pt => {
  const x = Array.isArray(p) ? p[0] : (p as Vec2).x;
  const y = Array.isArray(p) ? p[1] : (p as Vec2).y;
  return [t.ox + (x - t.cx) * t.s, t.oy - (y - t.cy) * t.s];
};
const toWorld = (p: Vec2): Pt => [p.x, p.y];

function fitTransform(sim: SimulationResult, box: Box, safe: Rect): Transform {
  const b = sceneBounds(sim);
  const bw = Math.max(b.maxX - b.minX + PAD_M * 2, 1e-6);
  const bh = Math.max(b.maxY - b.minY + PAD_M * 2, 1e-6);
  // Fit the scene into the safe rectangle, but never zoom in past MIN_SPAN_M across the whole box.
  const s = Math.min(safe.w / bw, safe.h / bh, box.w / MIN_SPAN_M, box.h / MIN_SPAN_M);
  return { s, cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, ox: safe.x + safe.w / 2, oy: safe.y + safe.h / 2 };
}

/** Body outline of a vehicle in the page frame. */
function bodyPts(t: Transform, pose: Pose, type: VehicleType, L: number, W: number): Pt[] {
  const f: Pt = [Math.sin(pose.headingRad), Math.cos(pose.headingRad)];
  const r: Pt = [Math.cos(pose.headingRad), -Math.sin(pose.headingRad)];
  const local = (u: number, v: number): Pt => toPx(t, [pose.xM + u * r[0] + v * f[0], pose.yM + u * r[1] + v * f[1]]);
  const radius = type === "car" ? Math.min(W * 0.3, 0.6) : type === "motorcycle" ? W * 0.45 : Math.min(W * 0.3, 0.6) * 0.7;
  return roundedRectPts(-W / 2, -L / 2, W, L, radius, 5).map(([u, v]) => local(u, -v)); // v measured from the front
}

/** Windows and ribs, in vehicle units (u right, d back from the front), like the icon set. */
function detailLines(type: VehicleType, L: number, W: number): Array<Array<[number, number]>> {
  const x0 = W / 2;
  const q = (fy: number, bow: number): Array<[number, number]> => [[-(x0 - 0.25), L * fy], [0, L * (fy - bow)], [x0 - 0.25, L * fy]];
  switch (type) {
    case "car": return [q(0.3, 0.06), q(0.84, -0.04)];
    case "suv": return [[[-(x0 - 0.25), L * 0.26], [x0 - 0.25, L * 0.26]], [[-(x0 * 0.56), L * 0.4], [-(x0 * 0.56), L * 0.88]], [[x0 * 0.56, L * 0.4], [x0 * 0.56, L * 0.88]]];
    case "pickup": return [[[-(x0 - 0.25), L * 0.22], [x0 - 0.25, L * 0.22]], [[-x0, L * 0.45], [x0, L * 0.45]]];
    case "van": return [q(0.13, 0.04), ...[0.38, 0.58, 0.78].map((k): Array<[number, number]> => [[-x0 * 0.6, L * k], [x0 * 0.6, L * k]])];
    case "truck": return [[[-(x0 - 0.3), L * 0.09], [x0 - 0.3, L * 0.09]], [[-x0, L * 0.25], [x0, L * 0.25]]];
    case "motorcycle": return [[[-x0, L * 0.24], [x0, L * 0.24]]];
  }
}

function drawVehicle(prims: Prim[], t: Transform, rv: VehicleResult, pose: Pose, opts: { fill: string | null; outline?: string; lines: boolean; minLine: number; painted?: boolean }) {
  const body = bodyPts(t, pose, rv.type, rv.lengthM, rv.widthM);
  const base = opts.fill ?? vehicleColor(rv.id);
  prims.push({ k: "poly", pts: body, closed: true, ...(opts.fill ? { fill: opts.fill } : {}), ...(opts.outline ? { stroke: { color: opts.outline, width: Math.max(opts.minLine, 0.14 * t.s), join: "round" as const } } : {}) });
  if (!opts.lines) return;
  const f: Pt = [Math.sin(pose.headingRad), Math.cos(pose.headingRad)];
  const r: Pt = [Math.cos(pose.headingRad), -Math.sin(pose.headingRad)];
  // On a picked paint the window lines take whichever of the surface and text inks reads better on it.
  const lineColor = opts.painted ? inkOn(base, color("color-surface"), color("color-text")).ink : mix(color("color-surface"), base, 0.85);
  for (const ln of detailLines(rv.type, rv.lengthM, rv.widthM)) {
    const pts = ln.map(([u, d]) => { const v = rv.lengthM / 2 - d; return toPx(t, [pose.xM + u * r[0] + v * f[0], pose.yM + u * r[1] + v * f[1]]); });
    prims.push({ k: "poly", pts, stroke: { color: lineColor, width: Math.max(opts.minLine * 0.8, 0.12 * t.s), cap: "round", join: "round" } });
  }
}

/** Douglas-Peucker: drop points that sit within tol of the line between their neighbours (the densified straight stretches). */
function simplify(pts: readonly Vec2[], tol: number): Vec2[] {
  if (pts.length < 3) return [...pts];
  const keep = new Array<boolean>(pts.length).fill(false);
  keep[0] = true;
  keep[pts.length - 1] = true;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const pa = pts[a]!;
    const pb = pts[b]!;
    const vx = pb.x - pa.x;
    const vy = pb.y - pa.y;
    const l = Math.hypot(vx, vy) || 1;
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i]!.x - pa.x) * vy - (pts[i]!.y - pa.y) * vx) / l;
      if (d > worst) { worst = d; at = i; }
    }
    if (worst > tol && at > 0) { keep[at] = true; stack.push([a, at], [at, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Dash pattern of lane lines, in meters: dash then gap (the same as the 3D view). */
const DASH_M = [3, 6] as const;
const PAINT_M = 0.18;
const STALL_M = 0.12;
/** Text sizes tried for a street name, largest first: a smaller name fits where a bigger one doesn't. */
const NAME_SIZE_STEPS = [1, 0.78, 0.6] as const;

interface RoadStyle { readonly minLine: number; readonly minTextSize: number; readonly streetLabels: boolean }

/** `safe` is the part of the box street names may use (the cards drawn over the picture sit outside it). */
function drawRoads(prims: Prim[], t: Transform, box: Box, net: RoadNetwork, o: RoadStyle, avoid: ReadonlyArray<{ at: Pt; r: number }>, avoidLines: ReadonlyArray<readonly Pt[]>, measure: Measure, safe: Rect = box) {
  const road = color("color-scene-road");
  const art = buildRoadArt(net);
  const wx = (px_: number, py_: number): Pt => [(px_ - t.ox) / t.s + t.cx, -(py_ - t.oy) / t.s + t.cy];
  const [x0, y1] = wx(box.x, box.y);
  const [x1, y0] = wx(box.x + box.w, box.y + box.h);
  const margin = 40; // m: include things just outside the view
  const near = (pts: readonly Pt[]) => pts.some(([x, y]) => x > x0 - margin && x < x1 + margin && y > y0 - margin && y < y1 + margin);
  const boxNear = (b: { minX: number; minY: number; maxX: number; maxY: number }) => b.maxX > x0 - margin && b.minX < x1 + margin && b.maxY > y0 - margin && b.minY < y1 + margin;

  for (const b of net.buildings) {
    const pts = b.footprint.map(toWorld);
    if (near(pts)) prims.push({ k: "poly", pts: pts.map((p) => toPx(t, p)), closed: true, fill: color("color-surface-2"), stroke: { color: color("color-border-strong"), width: Math.max(o.minLine * 0.6, 0.15 * t.s) } });
  }
  // A lot is paler than the ground by only a little in the tokens: some road color makes it read as paving (as in the 3D view).
  const lotFill = mix(color("color-scene-lot"), road, 0.6);
  for (const p of net.parking) {
    const pts = p.outline.map(toWorld);
    if (near(pts)) prims.push({ k: "poly", pts: pts.map((q) => toPx(t, q)), closed: true, fill: lotFill });
  }

  // Road surfaces: one outline per road (a carriageway each, with the median left open), a curb under it.
  const ribbons = art.ribbons.filter((r) => boxNear(r.box));
  const outlines = ribbons.map((r) => ({ r, pts: [...simplify(r.leftEdge, 0.03), ...simplify([...r.rightEdge].reverse(), 0.03)].map((p) => toPx(t, p)) }));
  for (const { pts } of outlines) prims.push({ k: "poly", pts, closed: true, fill: color("color-border-strong"), stroke: { color: color("color-border-strong"), width: CURB_M * 2 * t.s, join: "round" } });
  for (const { pts } of outlines) prims.push({ k: "poly", pts, closed: true, fill: road });

  // Paint, already clipped to its road and stopped at junctions; stalls on both sides of the aisles.
  const lane = color("color-scene-lane");
  for (const p of art.paint) {
    const pts = p.points.map(toWorld);
    if (!near(pts) || pts.length < 2) continue;
    const stall = p.kind === "stall";
    const width = Math.max(o.minLine * (stall ? 0.4 : 0.6), (stall ? STALL_M : PAINT_M) * t.s);
    prims.push({ k: "poly", pts: simplify(p.points, 0.03).map((q) => toPx(t, q)), stroke: { color: lane, width, ...(p.dashed ? { dash: [DASH_M[0] * t.s, DASH_M[1] * t.s] } : {}) } });
  }
  if (!o.streetLabels) return;

  // One name per street: core picks the spots (clear of junctions, inside the view, off the vehicles and paths).
  const focus = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
  const view = Math.min(x1 - x0, y1 - y0);
  const inset = 2;
  const [sx0, sy1] = wx(Math.max(box.x, safe.x) + inset, Math.max(box.y, safe.y) + inset);
  const [sx1, sy0] = wx(Math.min(box.x + box.w, safe.x + safe.w) - inset, Math.min(box.y + box.h, safe.y + safe.h) - inset);
  const inside = [{ x: sx0, y: sy0 }, { x: sx1, y: sy0 }, { x: sx1, y: sy1 }, { x: sx0, y: sy1 }];
  const keep: Vec2[] = [];
  for (const v of avoid) {
    const c = wx(v.at[0], v.at[1]);
    const r = v.r / t.s;
    keep.push({ x: c[0], y: c[1] });
    for (let k = 0; k < 12; k++) keep.push({ x: c[0] + Math.cos((k / 12) * Math.PI * 2) * r, y: c[1] + Math.sin((k / 12) * Math.PI * 2) * r });
    for (let k = 0; k < 8; k++) keep.push({ x: c[0] + Math.cos((k / 8) * Math.PI * 2) * r * 0.5, y: c[1] + Math.sin((k / 8) * Math.PI * 2) * r * 0.5 });
  }
  for (const ln of avoidLines) {
    for (let i = 0; i + 1 < ln.length; i++) {
      const a = wx(ln[i]![0], ln[i]![1]);
      const b = wx(ln[i + 1]![0], ln[i + 1]![1]);
      const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])));
      for (let k = 0; k <= n; k++) keep.push({ x: a[0] + ((b[0] - a[0]) * k) / n, y: a[1] + ((b[1] - a[1]) * k) / n });
    }
  }
  const spots = streetNameSpots(art, focus, Math.hypot(x1 - x0, y1 - y0));
  const textFor = (name: string, size: number) => {
    const text = name.toUpperCase();
    const tracking = size * 0.18;
    return { text, tracking, w: measure("sansBold", size, text) + tracking * (text.length - 1) };
  };
  const placed = placeStreetNames(spots, (name, width) => {
    const out: Array<{ lengthM: number; heightM: number }> = [];
    for (const k of NAME_SIZE_STEPS) {
      const size = Math.min(width * t.s * 0.4, o.minTextSize * 2.2) * k;
      if (size < o.minTextSize) continue;
      out.push({ lengthM: textFor(name, size).w / t.s, heightM: (size * 0.95) / t.s });
    }
    return out;
  }, focus, { preferM: view * 0.3, keepClearM: 0, avoid: keep, inside });
  for (const p of placed) {
    // The size that fit: the glyph height is 0.95 of the font size.
    const size = (p.heightM * t.s) / 0.95;
    const { text, tracking } = textFor(p.name, size);
    const centre = toPx(t, p.at);
    const ang = -rad2deg(p.angleRad);
    const th = (ang * Math.PI) / 180;
    // The baseline point sits a little below the road center so the letters are centered on it.
    const base: Pt = [centre[0] - Math.sin(th) * size * 0.35, centre[1] + Math.cos(th) * size * 0.35];
    prims.push({ k: "text", at: base, text, font: "sansBold", size, color: color("color-scene-label"), anchor: "middle", rotateDeg: ang, tracking });
  }
}

export function planDiagram(sim: SimulationResult, roads: RoadNetwork | null, opts: DiagramOptions, measure: Measure): DiagramPlan {
  const { box } = opts;
  const ins = opts.insets ?? {};
  const minTextSize = opts.minTextSize ?? 6;
  const kinds = [...new Set(roads?.features?.map((f) => f.kind) ?? [])];
  const legendEntries: Array<{ kind: typeof kinds[number]; x: number; row: number }> = [];
  let legendX = minTextSize, legendRow = 0;
  for (const kind of kinds) {
    const width = measure("sans", minTextSize, FEATURE_NAMES[kind]) + minTextSize * 3;
    if (legendX + width > box.w - minTextSize && legendX > minTextSize) { legendRow++; legendX = minTextSize; }
    legendEntries.push({ kind, x: legendX, row: legendRow }); legendX += width;
  }
  const legendLines = kinds.length ? wrapText("OpenStreetMap tags; positions and models schematic. Missing tags unknown.", box.w - minTextSize * 2, (text) => measure("sans", minTextSize, text)) : [];
  const legendH = kinds.length ? (legendRow + 1) * minTextSize * 1.8 + (legendLines.length + 0.5) * minTextSize * 1.3 : 0;
  const safe: Rect = { x: box.x + (ins.left ?? 0), y: box.y + (ins.top ?? 0), w: box.w - (ins.left ?? 0) - (ins.right ?? 0), h: box.h - (ins.top ?? 0) - (ins.bottom ?? 0) - legendH };
  const legendY = safe.y + safe.h;
  const t = fitTransform(sim, box, safe);
  const minLine = opts.minLine ?? 1;
  const tagMin = opts.minTagRadius ?? 6;
  const prims: Prim[] = [];
  prims.push({ k: "clip", x: box.x, y: box.y, w: box.w, h: box.h });
  prims.push({ k: "poly", pts: [[box.x, box.y], [box.x + box.w, box.y], [box.x + box.w, box.y + box.h], [box.x, box.y + box.h]], closed: true, fill: color("color-scene-ground") });

  const roadColor = color("color-scene-road");
  // Paths: dashed run-up, solid slide to rest. Planned first so street names can keep clear of them.
  const pathPrims: Prim[] = [];
  const avoid: Array<{ at: Pt; r: number }> = sim.vehicles.flatMap((rv) => [rv.impactPose, rv.restPose].map((p) => ({ at: toPx(t, [p.xM, p.yM]), r: (Math.max(rv.lengthM, rv.widthM) / 2) * t.s })));
  const avoidLines: Pt[][] = [];
  const keepClear = (pts: readonly Pt[]) => { avoidLines.push([...pts]); };
  for (const rv of sim.vehicles) {
    const c = mix(vehicleColor(rv.id), roadColor, OPACITY_PATH);
    const impactIdx = rv.track.length ? Math.round(-sim.startTimeS / sim.dtS) : 0;
    const approach = rv.track.slice(0, impactIdx + 1);
    const after = rv.track.slice(impactIdx);
    if (approach.length > 1 && rv.speedAtImpactMps.mid > 0.01) {
      const pts = decimate(approach, MAX_PATH_POINTS).map((p) => toPx(t, [p.xM, p.yM]));
      keepClear(pts);
      pathPrims.push({ k: "poly", pts, stroke: { color: c, width: Math.max(minLine, 0.18 * t.s), dash: [0.8 * t.s, 0.6 * t.s] } });
    }
    if (rv.postImpactDistanceM.hi >= MIN_DRAWN_MOVE_M) {
      const pts = after.length > 1 ? decimate(after, MAX_PATH_POINTS) : [];
      const line = (pts.length > 1 ? pts : [rv.impactPose, rv.restPose]).map((p) => toPx(t, [p.xM, p.yM]));
      keepClear(line);
      pathPrims.push({ k: "poly", pts: line, stroke: { color: c, width: Math.max(minLine, 0.18 * t.s), join: "round" } });
    }
  }
  // Overlay rectangles count like paths: street names keep off them (lines every half meter across each rectangle).
  const obstacles = opts.obstacles ?? [];
  const fillLines: Pt[][] = [];
  for (const o of obstacles) {
    const step = Math.max(1, 0.5 * t.s);
    for (let y = o.y; y <= o.y + o.h + 1e-6; y += step) fillLines.push([[o.x, y], [o.x + o.w, y]]);
  }
  if (roads) drawRoads(prims, t, box, roads, { minLine, minTextSize, streetLabels: opts.streetLabels ?? true }, avoid, [...avoidLines, ...fillLines], measure, safe);
  prims.push(...pathPrims);
  if (roads?.features?.length) {
    for (const arrow of [...taggedTurnArrows(roads), ...taggedCrosswalkPaint(roads)]) prims.push({ k: "poly", pts: arrow.points.map((p) => toPx(t, p)), stroke: { color: color("color-scene-lane"), width: Math.max(minLine, 0.15 * t.s), cap: "round", join: "round" } });
    const slots = new Map<string, number>();
    const size = Math.max(minTextSize * 1.6, Math.min(2 * t.s, minTextSize * 2.5));
    for (const f of roads.features) {
      const key = `${f.source}-${f.osmId}`, slot = slots.get(key) ?? 0; slots.set(key, slot + 1);
      const anchor = toPx(t, f.position), p: Pt = [anchor[0] + slot * size * 1.3, anchor[1]];
      if (p[0] < safe.x + size || p[0] > safe.x + safe.w - size || p[1] < safe.y + size || p[1] > safe.y + safe.h - size) continue;
      prims.push({ k: "circle", c: p, r: size * 0.6, fill: color("color-surface") });
      prims.push(...iconPrims(featureIcon(f.kind), p[0] - size / 2, p[1] - size / 2, size, color("color-scene-label"), f.kind === "oneway" && f.facingDeg !== null ? f.facingDeg - 90 : 0));
      if (f.kind === "speed" || f.kind === "lanes") {
        const label = f.label.replace(" (road tag; sign position unknown)", "");
        const width = measure("sans", minTextSize, label);
        const labelY = p[1] + size / 2 + slot * minTextSize * 1.3;
        if (p[0] - width / 2 >= safe.x && p[0] + width / 2 <= safe.x + safe.w && labelY + minTextSize * 1.2 < safe.y + safe.h) {
          prims.push({ k: "poly", pts: [[p[0] - width / 2, labelY], [p[0] + width / 2, labelY], [p[0] + width / 2, labelY + minTextSize * 1.2], [p[0] - width / 2, labelY + minTextSize * 1.2]], closed: true, fill: color("color-surface") });
          prims.push({ k: "text", at: [p[0], labelY + minTextSize], text: label, font: "sans", size: minTextSize, color: color("color-text-secondary"), anchor: "middle" });
        }
      }
    }
    // Reserve a legend strip above caller-owned cards; never paint over cars or scale/north chips.
    prims.push({ k: "poly", pts: [[box.x, legendY], [box.x + box.w, legendY], [box.x + box.w, legendY + legendH], [box.x, legendY + legendH]], closed: true, fill: color("color-surface") });
    for (const entry of legendEntries) {
      const y = legendY + entry.row * minTextSize * 1.8;
      prims.push(...iconPrims(featureIcon(entry.kind), box.x + entry.x, y, minTextSize * 1.4, color("color-text-secondary")));
      prims.push({ k: "text", at: [box.x + entry.x + minTextSize * 1.7, y + minTextSize], text: FEATURE_NAMES[entry.kind], font: "sans", size: minTextSize, color: color("color-text-secondary") });
    }
    legendLines.forEach((text, i) => prims.push({ k: "text", at: [box.x + minTextSize, legendY + (legendRow + 1) * minTextSize * 1.8 + (i + 1) * minTextSize * 1.3], text, font: "sans", size: minTextSize, color: color("color-text-secondary") }));
  }
  // Impact ring.
  const ic = toPx(t, sim.impactPointM);
  prims.push({ k: "circle", c: ic, r: 1.1 * t.s, stroke: { color: color("color-scene-impact"), width: Math.max(minLine * 1.4, 0.25 * t.s) } });
  prims.push({ k: "circle", c: ic, r: Math.max(0.3 * t.s, minLine * 1.5), fill: color("color-scene-impact") });

  if (opts.ghosts ?? true) {
    for (const rv of sim.vehicles) {
      const g = mix(vehicleColor(rv.id), roadColor, GHOST_MIX);
      drawVehicle(prims, t, rv, rv.impactPose, { fill: null, outline: g, lines: false, minLine });
    }
  }
  const paint = opts.paint ?? {};
  for (const rv of sim.vehicles) {
    const fill = bodyColor({ id: rv.id, color: paint[rv.id] ? { name: rv.id, hex: paint[rv.id]! } : null }, vehicleColor);
    const painted = fill !== vehicleColor(rv.id);
    // A painted body keeps an outline in its token colour, so the vehicle is told apart by its letter colour, never by paint.
    drawVehicle(prims, t, rv, rv.restPose, { fill, lines: true, minLine, painted, ...(painted ? { outline: vehicleColor(rv.id) } : {}) });
  }

  // Measurement lines (stopping at the letter circles), then numbered markers kept off the vehicle bodies, then the letters on top.
  const tagR = (rv: VehicleResult) => Math.max(Math.min(0.75, rv.widthM * 0.42) * t.s, tagMin);
  const tagOf = new Map(sim.vehicles.map((rv) => [rv.id, tagR(rv)]));
  const showLetters = opts.letters ?? true;
  const markers: Array<{ key: string; n: number; at: Pt }> = [];
  const measureInk = color("color-scene-measure");
  const shorten = (p: Pt, q: Pt, r: number): Pt => {
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    const k = Math.min(r, len * 0.45) / len;
    return [p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k];
  };
  markerKeys(sim).forEach((key, i) => {
    let a: Pt | undefined;
    let b: Pt | undefined;
    let dashed = false;
    let ra = 0;
    let rb = 0;
    if (key.startsWith("moved-")) {
      const rv = sim.vehicles.find((v) => v.id === key.slice(6));
      if (rv) { a = toPx(t, [rv.impactPose.xM, rv.impactPose.yM]); b = toPx(t, [rv.restPose.xM, rv.restPose.yM]); rb = showLetters ? tagOf.get(rv.id) ?? 0 : 0; }
    } else {
      const g = sim.gaps.find((x) => `gap-${x.a}-${x.b}` === key);
      const va = sim.vehicles.find((v) => v.id === g?.a);
      const vb = sim.vehicles.find((v) => v.id === g?.b);
      if (va && vb) { a = toPx(t, [va.restPose.xM, va.restPose.yM]); b = toPx(t, [vb.restPose.xM, vb.restPose.yM]); dashed = true; ra = showLetters ? tagOf.get(va.id) ?? 0 : 0; rb = showLetters ? tagOf.get(vb.id) ?? 0 : 0; }
    }
    if (!a || !b) return;
    const pa = ra ? shorten(a, b, ra) : a;
    const pb = rb ? shorten(b, a, rb) : b;
    prims.push({ k: "poly", pts: [pa, pb], stroke: { color: measureInk, width: Math.max(minLine * 0.9, 0.12 * t.s), ...(dashed ? { dash: [0.5 * t.s, 0.4 * t.s] } : {}) } });
    markers.push({ key, n: i + 1, at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] });
  });
  if (opts.markers ?? true) {
    const rr = Math.max(0.85 * t.s, tagMin);
    const bodyDist = (p: Pt, rv: VehicleResult): number => {
      const c = toPx(t, [rv.restPose.xM, rv.restPose.yM]);
      const h = rv.restPose.headingRad;
      const dx = p[0] - c[0];
      const dy = p[1] - c[1];
      const u = dx * Math.cos(h) + dy * Math.sin(h);
      const v = dx * Math.sin(h) - dy * Math.cos(h);
      return Math.hypot(Math.max(Math.abs(u) - (rv.widthM * t.s) / 2, 0), Math.max(Math.abs(v) - (rv.lengthM * t.s) / 2, 0));
    };
    const placed: Pt[] = [];
    const free = (p: Pt) =>
      p[0] >= box.x + rr + 1 && p[0] <= box.x + box.w - rr - 1 && p[1] >= box.y + rr + 1 && p[1] <= box.y + box.h - rr - 1 &&
      sim.vehicles.every((rv) => bodyDist(p, rv) >= rr + 1) &&
      obstacles.every((o) => p[0] < o.x - rr - 1 || p[0] > o.x + o.w + rr + 1 || p[1] < o.y - rr - 1 || p[1] > o.y + o.h + rr + 1) && placed.every((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) >= rr * 2 + 2);
    for (const m of markers) {
      let at: Pt = m.at;
      search: for (let ring = 0; ring < 40; ring++) {
        const steps = ring === 0 ? 1 : 16;
        for (let k = 0; k < steps; k++) {
          const ang = (k / steps) * Math.PI * 2 + ring * 0.37;
          const p: Pt = [m.at[0] + Math.cos(ang) * ring * rr * 0.4, m.at[1] + Math.sin(ang) * ring * rr * 0.4];
          if (free(p)) { at = p; break search; }
        }
      }
      placed.push(at);
      m.at = at;
      prims.push({ k: "circle", c: at, r: rr, fill: measureInk });
      prims.push({ k: "text", at: [at[0], at[1] + rr * 0.36], text: String(m.n), font: "sansBold", size: rr * 1.25, color: color("color-surface"), anchor: "middle" });
    }
  }
  if (showLetters) {
    for (const rv of sim.vehicles) {
      const rr = tagOf.get(rv.id) ?? tagMin;
      const c = toPx(t, [rv.restPose.xM, rv.restPose.yM]);
      prims.push({ k: "circle", c, r: rr, fill: color("color-surface") });
      prims.push({ k: "text", at: [c[0], c[1] + rr * 0.5], text: rv.id, font: "sansBold", size: rr * 1.4, color: vehicleColor(rv.id), anchor: "middle" });
    }
  }
  prims.push({ k: "unclip" });
  const keep: Rect[] = [];
  if (legendH) keep.push({ x: box.x, y: legendY, w: box.w, h: legendH });
  const bodies: Pt[][] = sim.vehicles.map((rv) => bodyPts(t, rv.restPose, rv.type, rv.lengthM, rv.widthM));
  const bbox = (pts: readonly Pt[]): Rect => {
    const xs = pts.map((q) => q[0]);
    const ys = pts.map((q) => q[1]);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  };
  for (const rv of sim.vehicles) {
    for (const pose of [rv.restPose, rv.impactPose, poseAtTime(sim, rv, -NEAR_WINDOW_S)]) keep.push(bbox(bodyPts(t, pose, rv.type, rv.lengthM, rv.widthM)));
  }
  keep.push({ x: ic[0] - 1.1 * t.s, y: ic[1] - 1.1 * t.s, w: 2.2 * t.s, h: 2.2 * t.s });
  return { prims, scale: t.s, markers, safe, keep, bodies };
}

export interface ScaleBar {
  /** Length of the bar in meters. */
  readonly meters: number;
  /** Exact label for that length in the bar's own unit, e.g. "5.0 m" or "15 ft". */
  readonly label: string;
  /** Length in output units. */
  readonly px: number;
}

const METRIC_STEPS_M = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];
const US_STEPS_FT = [1, 2, 5, 10, 15, 20, 50, 100, 200, 500, 1000];
const FOOT_M = 1 / M_TO_FT;

function pick(steps: readonly number[], toMeters: (n: number) => number, pxPerM: number, maxPx: number): number {
  let best = steps[0]!;
  for (const n of steps) if (toMeters(n) * pxPerM <= maxPx) best = n;
  return best;
}

/**
 * Two scale bars, each exact in its own unit: a round number of meters and,
 * separately, a round number of feet. Never a rounded foot label on a meter bar.
 */
export function scaleBars(pxPerM: number, maxPx: number): { metric: ScaleBar; us: ScaleBar } {
  const m = pick(METRIC_STEPS_M, (n) => n, pxPerM, maxPx);
  const ft = pick(US_STEPS_FT, (n) => n * FOOT_M, pxPerM, maxPx);
  return {
    metric: { meters: m, label: formatDistance(m, { both: false, units: "metric" }).text, px: m * pxPerM },
    us: { meters: ft * FOOT_M, label: formatDistance(ft * FOOT_M, { both: false, units: "us" }).text, px: ft * FOOT_M * pxPerM },
  };
}

export interface PinLabel { readonly text: string; readonly rotateDeg: number; readonly box: Rect }

export interface PinLabelOptions {
  readonly box: Box;
  /** The pin in the roads' local frame (meters). */
  readonly center: Vec2;
  /** Output units per meter. */
  readonly scale: number;
  /** Where the pin is in the box (default: the middle). */
  readonly pinAt?: Pt;
  /** Text size (output units). */
  readonly size: number;
  /** Streets to label even if they don't pass right by the pin (the names the claimant's vehicles travelled on). */
  readonly names?: readonly string[];
  /** Rectangles the names must keep clear of (the pin and its ring, the credit chip). */
  readonly keepClear: readonly Rect[];
  /** How close (m) a street must pass to the pin to count as meeting there. */
  readonly meetM?: number;
  readonly maxStreets?: number;
}

const MEET_M = 30;
/** Clear space between a street name at the pin (halo included) and the pin, the credit or another name, in text sizes. */
export const PIN_LABEL_GAP = 0.5;

/** Do two rectangles overlap or come closer than `gap`? */
export function rectsTouch(a: Rect, b: Rect, gap = 0): boolean {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}

/** Shortest distance (m) from p to a polyline. */
function distToLine(line: readonly Vec2[], p: Vec2): number {
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i]!;
    const b = line[i + 1]!;
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const l2 = vx * vx + vy * vy || 1;
    const k = Math.min(1, Math.max(0, ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2));
    best = Math.min(best, Math.hypot(p.x - (a.x + vx * k), p.y - (a.y + vy * k)));
  }
  return best;
}

/**
 * Names of the streets that meet at the pin, drawn along their roads near the pin: bold capitals with a halo so
 * they read on a road outline and on map tiles alike. Core gives the spots (the same ones the diagram uses:
 * straight stretches clear of junctions). Each street takes its spot nearest the pin whose label, halo included,
 * keeps a clear gap from the pin, the credit and every name already placed, so the names spread out along their
 * own roads instead of crowding at the pin (owner, 2026-10-10). Where the straight stretch is too short for the
 * name along it (a road along the short side of a wide box), the name is set level beside the road. A name with
 * no clear spot is left off rather than drawn over the pin, the credit or another name.
 */
export function planPinStreetLabels(roads: RoadNetwork, o: PinLabelOptions, measure: Measure): { prims: Prim[]; labels: PinLabel[] } {
  const pinAt = o.pinAt ?? [o.box.x + o.box.w / 2, o.box.y + o.box.h / 2];
  const t: Transform = { s: o.scale, cx: o.center.x, cy: o.center.y, ox: pinAt[0], oy: pinAt[1] };
  const art = buildRoadArt(roads);
  const meet = o.meetM ?? MEET_M;
  // The streets that pass the pin (and the ones the claimant's vehicles were on, a little further out).
  const display = new Map<string, string>();
  const near = new Map<string, number>();
  for (const r of art.ribbons) {
    const name = r.way.name?.trim();
    if (!name || r.way.kind === "parking_aisle") continue;
    const key = name.toLowerCase();
    display.set(key, name);
    near.set(key, Math.min(near.get(key) ?? Infinity, distToLine(r.line, o.center)));
  }
  const wanted = new Set((o.names ?? []).map((n) => n.trim().toLowerCase()));
  const keys = [...near.entries()]
    .filter(([k, d]) => wanted.size ? wanted.has(k) && d <= meet * 4 : d <= meet)
    .sort((a, b) => Number(wanted.has(b[0])) - Number(wanted.has(a[0])) || a[1] - b[1])
    .slice(0, o.maxStreets ?? 4)
    .map(([k]) => k);
  const prims: Prim[] = [{ k: "clip", x: o.box.x, y: o.box.y, w: o.box.w, h: o.box.h }];
  const labels: PinLabel[] = [];
  if (!keys.length) { prims.push({ k: "unclip" }); return { prims, labels }; }

  const size = o.size;
  const tracking = size * 0.18;
  const halo = Math.max(size * 0.14, 0.6);
  const gap = size * PIN_LABEL_GAP;
  const inset = 2;
  const textW = (name: string) => measure("sansBold", size, name.toUpperCase()) + tracking * (name.length - 1);
  const reach = Math.hypot(o.box.w, o.box.h) / o.scale;
  const spots = streetNameSpots(art, o.center, reach);
  const taken: Rect[] = [...o.keepClear];
  const clear = (r: Rect) =>
    r.x >= o.box.x + inset && r.y >= o.box.y + inset && r.x + r.w <= o.box.x + o.box.w - inset && r.y + r.h <= o.box.y + o.box.h - inset &&
    !taken.some((k) => rectsTouch(r, k, gap));
  /** The label centred on `centre` at `ang` degrees: where its baseline starts, and its box with the halo. */
  const shape = (width: number, centre: Pt, ang: number): { baseline: Pt; rect: Rect } => {
    const th = (ang * Math.PI) / 180;
    const ux = Math.cos(th);
    const uy = Math.sin(th);
    const baseline: Pt = [centre[0] - uy * size * 0.35, centre[1] + ux * size * 0.35];
    const corners: Pt[] = ([[-width / 2, -size * 0.75], [width / 2, -size * 0.75], [width / 2, size * 0.2], [-width / 2, size * 0.2]] as const)
      .map((c) => [baseline[0] + c[0] * ux - c[1] * uy, baseline[1] + c[0] * uy + c[1] * ux] as Pt);
    const xs = corners.map((q) => q[0]);
    const ys = corners.map((q) => q[1]);
    return { baseline, rect: { x: Math.min(...xs) - halo, y: Math.min(...ys) - halo, w: Math.max(...xs) - Math.min(...xs) + halo * 2, h: Math.max(...ys) - Math.min(...ys) + halo * 2 } };
  };
  const draw = (text: string, baseline: Pt, rect: Rect, ang: number) => {
    const common = { k: "text" as const, text, font: "sansBold" as const, size, anchor: "middle" as const, rotateDeg: ang, tracking };
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]] as const) {
      prims.push({ ...common, at: [baseline[0] + dx * halo, baseline[1] + dy * halo], color: color("color-surface") });
    }
    prims.push({ ...common, at: baseline, color: color("color-scene-label") });
    taken.push(rect);
    labels.push({ text, rotateDeg: ang, box: rect });
  };
  for (const key of keys) {
    const text = (display.get(key) ?? key).toUpperCase();
    const width = textW(text);
    const own = spots.filter((sp) => sp.name.trim().toLowerCase() === key)
      .sort((a, b) => Math.hypot(a.at.x - o.center.x, a.at.y - o.center.y) - Math.hypot(b.at.x - o.center.x, b.at.y - o.center.y));
    // Along its road first, on a straight stretch long enough for the name; then level beside the road.
    const along = own.filter((sp) => width / o.scale + 1 <= sp.halfSpanM * 2).map((sp) => ({ centre: toPx(t, sp.at), ang: -rad2deg(sp.angleRad) }));
    // Recaptured ways can have no straight label span inside this small map box. Keep the newer
    // collision/gap rules, but also try level labels beside the actual road vertices.
    const beside = art.ribbons.filter((r) => r.way.name?.trim().toLowerCase() === key).flatMap((r) => r.line.map((at, i) => ({ at, widthM: (r.left[i] ?? 0) + (r.right[i] ?? 0) })));
    const level = [...own, ...beside].sort((a, b) => Math.hypot(a.at.x - o.center.x, a.at.y - o.center.y) - Math.hypot(b.at.x - o.center.x, b.at.y - o.center.y)).flatMap((sp) => {
      const c = toPx(t, sp.at);
      return [1, -1].map((side) => ({ centre: [c[0] + side * ((sp.widthM * t.s) / 2 + width / 2 + size * 0.6), c[1]] as Pt, ang: 0 }));
    });
    for (const cand of [...along, ...level]) {
      const { baseline, rect } = shape(width, cand.centre, cand.ang);
      if (!clear(rect)) continue;
      draw(text, baseline, rect, cand.ang);
      break;
    }
  }
  prims.push({ k: "unclip" });
  return { prims, labels };
}

/**
 * The road outline for the map box when there is no map picture (DESIGN.md section 9): the same road
 * bands and buildings as the diagram, with no vehicles, framed on the pin across `spanM` meters, a pin
 * marker, and the names of the streets that meet at the pin.
 */
export function planRoadOutline(roads: RoadNetwork, box: Box, opts: { spanM: number; minTextSize: number; minLine: number; pinRadius: number; /** The scene pin in the roads' local frame, meters (the frame origin is the capture center, which can be off the pin). */ center: Vec2; /** Rectangles the street names must keep clear of (the credit chip). */ keepClear?: readonly Rect[]; /** Streets to label even when they don't pass right by the pin. */ streetNames?: readonly string[] }, measure: Measure): { prims: Prim[]; pin: Pt; scale: number; labels: PinLabel[] } {
  const t: Transform = { s: box.w / opts.spanM, cx: opts.center.x, cy: opts.center.y, ox: box.x + box.w / 2, oy: box.y + box.h / 2 };
  const prims: Prim[] = [{ k: "clip", x: box.x, y: box.y, w: box.w, h: box.h }];
  prims.push({ k: "poly", pts: [[box.x, box.y], [box.x + box.w, box.y], [box.x + box.w, box.y + box.h], [box.x, box.y + box.h]], closed: true, fill: color("color-scene-ground") });
  drawRoads(prims, t, box, roads, { minLine: opts.minLine, minTextSize: opts.minTextSize, streetLabels: false }, [], [], measure);
  const pin = toPx(t, opts.center);
  prims.push({ k: "circle", c: pin, r: opts.pinRadius * 1.5, fill: color("color-surface") });
  prims.push({ k: "circle", c: pin, r: opts.pinRadius, fill: color("color-map-pin") });
  prims.push({ k: "unclip" });
  const pinRect: Rect = { x: pin[0] - opts.pinRadius * 2, y: pin[1] - opts.pinRadius * 2, w: opts.pinRadius * 4, h: opts.pinRadius * 4 };
  const names = planPinStreetLabels(roads, {
    box, center: opts.center, scale: t.s, size: opts.minTextSize, ...(opts.streetNames ? { names: opts.streetNames } : {}),
    keepClear: [pinRect, ...(opts.keepClear ?? [])],
  }, measure);
  prims.push(...names.prims);
  return { prims, pin, scale: t.s, labels: names.labels };
}
