// The map for fixtures (test) mode, where no OSM tiles are used: a tile drawn on a canvas from the
// RoadNetwork the app already has for the area (roads, buildings, parking), in the same style family as
// OSM (light ground, white roads with casing, grey buildings, street names where they fit). It is an
// illustration, not OSM's own rendering. Nothing is fetched; the colors are passed in (they come from the
// --color-map-* tokens).
import type { LatLon, RoadKind, RoadNetwork, Vec2 } from "@csd/core";

export const TILE_SIZE = 256;
const EARTH_CIRCUMFERENCE_M = 40_075_016.686;
/** Road casing is this wide on each side, px. */
const CASING_PX = 1.5;
/** Roads are never thinner than this, px, however far out the map is zoomed. */
const MIN_ROAD_PX = 2;
const OUTLINE_PX = 1;
/** Shapes within this many px of the tile still count as touching it. */
const EDGE_MARGIN_PX = 40;
const LABEL_MIN_ZOOM = 16;
const LABEL_PX = 11;
const LABEL_BIG_PX = 12;
const LABEL_BIG_ZOOM = 18;
const LABEL_HALO_PX = 3;
/** A label needs this much road beyond its own length. */
const LABEL_ROOM_PX = 24;
const LABEL_LINE_HEIGHT = 1.3;
/** A label's stretch of road may bend this much. */
const LABEL_MAX_TURN_RAD = 0.35;

export interface MapColors {
  readonly ground: string;
  readonly road: string;
  readonly roadCasing: string;
  readonly roadMajor: string;
  readonly roadMajorCasing: string;
  readonly building: string;
  readonly buildingEdge: string;
  readonly parking: string;
  readonly label: string;
  readonly fontFamily: string;
}

/** A point in Web Mercator units: 0..1 across the world, y down. */
type Merc = readonly [number, number];
interface Bounds { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number }
interface Shape { readonly pts: readonly Merc[]; readonly bounds: Bounds }
interface DrawnRoad extends Shape { readonly kind: RoadKind; readonly widthM: number; readonly name: string | null; readonly major: boolean }

export interface DrawnMap {
  readonly roads: readonly DrawnRoad[];
  readonly buildings: readonly Shape[];
  readonly parking: readonly Shape[];
  /** Latitude of the area, for meters per pixel. */
  readonly lat: number;
}

export function mercator(p: LatLon): Merc {
  const rad = (p.lat * Math.PI) / 180;
  return [(p.lon + 180) / 360, (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2];
}

const boundsOf = (pts: readonly Merc[]): Bounds => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  return { minX, minY, maxX, maxY };
};

const MAJOR: ReadonlySet<RoadKind> = new Set<RoadKind>(["motorway", "trunk", "primary", "secondary"]);

/** Everything in the network as Mercator shapes, computed once per network. */
export function projectNetwork(net: RoadNetwork, toLatLon: (frame: RoadNetwork["frame"], v: Vec2) => LatLon): DrawnMap {
  const proj = (v: readonly Vec2[]): Merc[] => v.map((p) => mercator(toLatLon(net.frame, p)));
  const shape = (v: readonly Vec2[]): Shape => { const pts = proj(v); return { pts, bounds: boundsOf(pts) }; };
  return {
    roads: net.ways.map((w) => {
      const s = shape(w.centerline);
      return { ...s, kind: w.kind, widthM: Math.max(1, (w.lanesForward + w.lanesBackward) * w.laneWidthM), name: w.name, major: MAJOR.has(w.kind) };
    }),
    buildings: net.buildings.map((b) => shape(b.footprint)),
    parking: net.parking.map((p) => shape(p.outline)),
    lat: net.frame.origin.lat,
  };
}

/** Ground meters in one pixel at this zoom and latitude. */
export const metersPerPixel = (lat: number, z: number): number => (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180)) / (TILE_SIZE * 2 ** z);

const meets = (a: Bounds, b: Bounds) => a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;

export interface TileDraw { readonly z: number; readonly x: number; readonly y: number }

/** The tile's area in Mercator units, with a margin for road width and cut-off shapes. */
function viewOf(t: TileDraw): Bounds {
  const scale = TILE_SIZE * 2 ** t.z;
  const pad = EDGE_MARGIN_PX / scale;
  return { minX: (t.x * TILE_SIZE) / scale - pad, minY: (t.y * TILE_SIZE) / scale - pad, maxX: ((t.x + 1) * TILE_SIZE) / scale + pad, maxY: ((t.y + 1) * TILE_SIZE) / scale + pad };
}

/** Does anything in the map reach this tile? (No: it is plain ground.) */
export function tileHasContent(map: DrawnMap | null, t: TileDraw): boolean {
  if (!map) return false;
  const view = viewOf(t);
  return [...map.roads, ...map.buildings, ...map.parking].some((s) => meets(s.bounds, view));
}

/**
 * Draw one tile. Returns how many shapes it drew (0 means the tile is plain ground).
 * `ctx` is a 2D context sized TILE_SIZE × TILE_SIZE.
 */
export function drawFallbackTile(ctx: CanvasRenderingContext2D, t: TileDraw, map: DrawnMap | null, colors: MapColors): number {
  const n = 2 ** t.z;
  const scale = TILE_SIZE * n;
  const ox = t.x * TILE_SIZE;
  const oy = t.y * TILE_SIZE;
  const px = (m: Merc): [number, number] => [m[0] * scale - ox, m[1] * scale - oy];
  ctx.fillStyle = colors.ground;
  ctx.fillRect(0, 0, TILE_SIZE, TILE_SIZE);
  if (!map) return 0;
  const view = viewOf(t);
  const inView = <S extends Shape>(list: readonly S[]) => list.filter((s) => meets(s.bounds, view));
  let drew = 0;
  // Roads end where the data ends (the edge of the cached area): square ends, not round blobs.
  ctx.lineJoin = "round";
  ctx.lineCap = "butt";

  const path = (pts: readonly Merc[], close: boolean) => {
    ctx.beginPath();
    pts.forEach((p, i) => { const [x, y] = px(p); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
    if (close) ctx.closePath();
  };

  for (const lot of inView(map.parking)) {
    path(lot.pts, true);
    ctx.fillStyle = colors.parking;
    ctx.fill();
    ctx.lineWidth = OUTLINE_PX;
    ctx.strokeStyle = colors.roadCasing;
    ctx.stroke();
    drew++;
  }
  for (const b of inView(map.buildings)) {
    path(b.pts, true);
    ctx.fillStyle = colors.building;
    ctx.fill();
    ctx.lineWidth = OUTLINE_PX;
    ctx.strokeStyle = colors.buildingEdge;
    ctx.stroke();
    drew++;
  }

  const mpp = metersPerPixel(map.lat, t.z);
  const roads = inView(map.roads);
  const widthPx = (r: DrawnRoad) => Math.max(r.widthM / mpp, MIN_ROAD_PX);
  // Minor roads first, major roads over them; each pass is casing, then fill, so crossings read as joined.
  for (const major of [false, true]) {
    const group = roads.filter((r) => r.major === major);
    for (const r of group) { path(r.pts, false); ctx.lineWidth = widthPx(r) + CASING_PX * 2; ctx.strokeStyle = major ? colors.roadMajorCasing : colors.roadCasing; ctx.stroke(); }
    for (const r of group) { path(r.pts, false); ctx.lineWidth = widthPx(r); ctx.strokeStyle = major ? colors.roadMajor : colors.road; ctx.stroke(); drew++; }
  }

  if (t.z >= LABEL_MIN_ZOOM) drew += drawLabels(ctx, map.roads, { scale, ox, oy, colors, z: t.z });
  return drew;
}

interface LabelEnv { readonly scale: number; readonly ox: number; readonly oy: number; readonly colors: MapColors; readonly z: number }

/** Runs of a polyline that keep (about) one direction, each as its two end points. */
function straightRuns(pts: readonly Merc[], scale: number): Array<{ len: number; a: [number, number]; b: [number, number] }> {
  const runs: Array<{ len: number; a: [number, number]; b: [number, number] }> = [];
  let start = 0;
  const at = (i: number): [number, number] => [(pts[i] as Merc)[0] * scale, (pts[i] as Merc)[1] * scale];
  const dir = (i: number) => { const a = at(i - 1); const b = at(i); return Math.atan2(b[1] - a[1], b[0] - a[0]); };
  for (let i = 1; i < pts.length; i++) {
    const last = i === pts.length - 1;
    const turn = last ? false : Math.abs(Math.atan2(Math.sin(dir(i + 1) - dir(start + 1)), Math.cos(dir(i + 1) - dir(start + 1)))) > LABEL_MAX_TURN_RAD;
    if (last || turn) {
      const a = at(start);
      const b = at(i);
      runs.push({ len: Math.hypot(b[0] - a[0], b[1] - a[1]), a, b });
      start = i;
    }
  }
  return runs;
}

/**
 * Street names along the middle of each road's longest straight stretch, where the whole name fits on
 * the road. Placement is worked out for the whole map (not per tile) in world pixels, so a label that
 * crosses a tile edge is drawn by both tiles and lines up; the canvas clips the part outside.
 */
function drawLabels(ctx: CanvasRenderingContext2D, roads: readonly DrawnRoad[], env: LabelEnv): number {
  const size = env.z >= LABEL_BIG_ZOOM ? LABEL_BIG_PX : LABEL_PX;
  ctx.font = `${size}px ${env.colors.fontFamily}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  const th = size * LABEL_LINE_HEIGHT;
  const placed: Array<{ x: number; y: number; r: number }> = [];
  let drew = 0;
  for (const r of roads) {
    if (!r.name) continue;
    const best = straightRuns(r.pts, env.scale).reduce<{ len: number; a: [number, number]; b: [number, number] } | null>((m, run) => (!m || run.len > m.len ? run : m), null);
    if (!best) continue;
    const textW = ctx.measureText(r.name).width;
    if (best.len < textW + LABEL_ROOM_PX) continue;
    const cx = (best.a[0] + best.b[0]) / 2;
    const cy = (best.a[1] + best.b[1]) / 2;
    let angle = Math.atan2(best.b[1] - best.a[1], best.b[0] - best.a[0]);
    if (angle > Math.PI / 2 || angle < -Math.PI / 2) angle += Math.PI;
    const reach = Math.max(textW, th) / 2;
    if (placed.some((p) => Math.hypot(p.x - cx, p.y - cy) < p.r + reach)) continue;
    placed.push({ x: cx, y: cy, r: reach });
    // Only labels that touch this tile are painted.
    const halfW = (Math.abs(Math.cos(angle)) * textW + Math.abs(Math.sin(angle)) * th) / 2;
    const halfH = (Math.abs(Math.sin(angle)) * textW + Math.abs(Math.cos(angle)) * th) / 2;
    const lx = cx - env.ox;
    const ly = cy - env.oy;
    if (lx + halfW < 0 || lx - halfW > TILE_SIZE || ly + halfH < 0 || ly - halfH > TILE_SIZE) continue;
    ctx.save();
    ctx.translate(lx, ly);
    ctx.rotate(angle);
    ctx.lineWidth = LABEL_HALO_PX;
    ctx.strokeStyle = env.colors.road;
    ctx.strokeText(r.name, 0, 0);
    ctx.fillStyle = env.colors.label;
    ctx.fillText(r.name, 0, 0);
    ctx.restore();
    drew++;
  }
  return drew;
}
