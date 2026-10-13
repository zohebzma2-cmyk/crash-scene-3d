import type { RoadNetwork, Vec2 } from "./contracts";
import { buildRoadArt, pointInPolygon } from "./roadart";
export interface TaggedPaint { readonly id: string; readonly points: readonly Vec2[] }
const crosswalkCache = new WeakMap<RoadNetwork, TaggedPaint[]>();
const bounds = (points: readonly Vec2[]) => ({ minX: Math.min(...points.map(p => p.x)), maxX: Math.max(...points.map(p => p.x)), minY: Math.min(...points.map(p => p.y)), maxY: Math.max(...points.map(p => p.y)) });
const overlaps = (a: ReturnType<typeof bounds>, b: ReturnType<typeof bounds>) => a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;

/** Clip a segment once against the union of nearby road polygons, without sampling its length. */
export function clipPaintLine(points: readonly Vec2[], polygons: readonly (readonly Vec2[])[]): Vec2[][] {
  const a = points[0]!, b = points[1]!;
  const dx = b.x - a.x, dy = b.y - a.y;
  const at = (t: number): Vec2 => ({ x: a.x + dx * t, y: a.y + dy * t });
  const cuts = [0, 1];
  for (const poly of polygons) for (let i = 0; i < poly.length; i++) {
    const c = poly[i]!, d = poly[(i + 1) % poly.length]!;
    const ex = d.x - c.x, ey = d.y - c.y, den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-10) continue;
    const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / den;
    const u = ((c.x - a.x) * dy - (c.y - a.y) * dx) / den;
    if (t > 0 && t < 1 && u >= 0 && u <= 1) cuts.push(t);
  }
  const ordered = [...new Set(cuts)].sort((x, y) => x - y), out: Vec2[][] = [];
  let start: number | null = null;
  for (let i = 1; i < ordered.length; i++) {
    const lo = ordered[i - 1]!, hi = ordered[i]!;
    if (polygons.some(poly => pointInPolygon(at((lo + hi) / 2), poly))) start ??= lo;
    else if (start !== null) { out.push([at(start), at(lo)]); start = null; }
  }
  if (start !== null) out.push([at(start), at(1)]);
  return out;
}
/** Paint only an explicitly marked, mapped crossing path. Width is a schematic 3 m. */
export function taggedCrosswalkPaint(net: RoadNetwork): TaggedPaint[] {
  const cached = crosswalkCache.get(net);
  if (cached) return cached;
  const out: TaggedPaint[] = [];
  for (const f of net.features ?? []) {
    if (!f.crossingPath || !f.crossingMarkings) continue;
    for (let i = 1; i < f.crossingPath.length; i++) {
      const a = f.crossingPath[i - 1]!, b = f.crossingPath[i]!;
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      if (length < 0.1) continue;
      const ux = (b.x - a.x) / length, uy = (b.y - a.y) / length;
      const point = (d: number, side: number): Vec2 => ({ x: a.x + ux * d - uy * side, y: a.y + uy * d + ux * side });
      // Parallel boundary lines are the conservative schematic for unspecified marking style.
      for (const side of [-1.5, 1.5]) out.push({ id: `${f.id}-${i}-${side}`, points: [point(0, side), point(length, side)] });
      if (f.crossingMarkings !== "yes") for (let d = 0.5; d < length; d += 1) out.push({ id: `${f.id}-${i}-rung-${d}`, points: [point(d, -1.5), point(d, 1.5)] });
    }
  }
  // Crossing paths may include sidewalks or roads excluded from this scene. Keep paint on modeled roads.
  if (!out.length) { crosswalkCache.set(net, out); return out; }
  const outlines = buildRoadArt(net).ribbons.map((r) => ({ polygon: r.polygon, bounds: bounds(r.polygon) }));
  const clipped: TaggedPaint[] = [];
  for (const line of out) {
    const box = bounds(line.points);
    const nearby = outlines.filter(r => overlaps(box, r.bounds)).map(r => r.polygon);
    clipPaintLine(line.points, nearby).forEach((points, i) => clipped.push({ id: `${line.id}-${i}`, points }));
  }
  crosswalkCache.set(net, clipped);
  return clipped;
}
/** Schematic turn arrows on the tagged way; no turn or directional lane split is invented. */
export function taggedTurnArrows(net: RoadNetwork): TaggedPaint[] {
  const out: TaggedPaint[] = [];
  for (const t of net.taggedRoads ?? []) {
    const feature = net.features?.find((f) => f.osmId === t.osmId && f.kind === "turn-lanes");
    const road = net.ways.find((w) => w.osmWayIds.includes(t.osmId));
    if (!feature || !road || feature.facingDeg === null) continue;
    for (const backward of [false, true]) {
      const turns = backward ? t.turnsBackward : t.turnsForward;
      const n = backward ? t.backward : t.oneway ? t.lanes ?? t.forward : t.forward;
      if (n === null || n !== turns.length) continue;
      const b = (feature.facingDeg + (backward ? 180 : 0)) * Math.PI / 180;
      const forward = { x: Math.sin(b), y: Math.cos(b) }, right = { x: Math.cos(b), y: -Math.sin(b) };
      turns.forEach((value, i) => {
        const offset = (t.oneway ? i + 0.5 - n / 2 : i + 0.5 + (t.bothWays ?? 0) / 2) * road.laneWidthM;
        const center = { x: feature.position.x + right.x * offset, y: feature.position.y + right.y * offset };
        const point = (x: number, y: number): Vec2 => ({ x: center.x + right.x * x + forward.x * y, y: center.y + right.y * x + forward.y * y });
        const paths: Array<Array<[number, number]>> = [];
        for (const turn of value.split(";")) {
          if (turn === "through") paths.push([[0, -1.5], [0, 1.5]], [[-0.5, 0.9], [0, 1.5], [0.5, 0.9]]);
          else if (turn === "left" || turn === "right" || turn === "slight_left" || turn === "slight_right" || turn === "sharp_left" || turn === "sharp_right") {
            const side = turn.endsWith("left") ? -1 : 1;
            paths.push([[0, -1.5], [0, 0.4], [side * 0.9, 1]], [[side * 0.35, 1.15], [side * 0.9, 1], [side * 0.75, 0.45]]);
          }
        }
        paths.forEach((path, j) => out.push({ id: `${t.osmId}-${backward}-${i}-${j}`, points: path.map(([x, y]) => point(x, y)) }));
      });
    }
  }
  return out;
}
