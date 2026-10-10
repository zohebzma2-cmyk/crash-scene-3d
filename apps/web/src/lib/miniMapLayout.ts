// Where each vehicle's marker sits on the vehicles step's mini map. Markers go on the vehicle's own
// lane path, a little way back from the impact point, so they show where it came from. Markers never
// overlap each other or the pin, and never sit on a building: a marker that would is pushed further
// back along its path (a rear-end pair therefore lines up along the lane, one behind the other).
import type { Vec2, VehicleId } from "@csd/core";
import { dist, nearestOnPolyline, pointAtDistance, pointInPolygon, unitFromBearing } from "./geometry";

export interface MiniVehicleInput {
  readonly id: VehicleId;
  /** The lane path in travel order; null when parked. */
  readonly path: readonly Vec2[] | null;
  /** Vehicle center at impact. */
  readonly impact: Vec2;
  /** Compass bearing the vehicle faces. */
  readonly headingDeg: number;
}

export interface MiniVehiclePlacement {
  readonly id: VehicleId;
  readonly pos: Vec2;
  readonly headingDeg: number;
  /** How far back along its path the marker ended up, meters. */
  readonly backM: number;
}

export interface MiniMapLayoutInput {
  readonly pin: Vec2;
  readonly vehicles: readonly MiniVehicleInput[];
  readonly buildings: ReadonlyArray<readonly Vec2[]>;
  /** Ground meters per screen pixel at the map's zoom. */
  readonly mPerPx: number;
  /** Marker diameter in screen pixels. */
  readonly markerPx: number;
}

const GAP_FACTOR = 1.15;
const STEPS = 28;

export function layoutMiniMap(input: MiniMapLayoutInput): MiniVehiclePlacement[] {
  const { pin, mPerPx, markerPx } = input;
  const diameter = markerPx * mPerPx;
  const minSep = diameter * GAP_FACTOR;
  const pinClear = diameter * 0.9;
  const ring = Array.from({ length: 8 }, (_, i) => ({ x: Math.sin((i / 8) * Math.PI * 2) * diameter * 0.45, y: Math.cos((i / 8) * Math.PI * 2) * diameter * 0.45 }));
  const onBuilding = (p: Vec2) => input.buildings.some((b) => pointInPolygon(p, b) || ring.some((r) => pointInPolygon({ x: p.x + r.x, y: p.y + r.y }, b)));

  const placed: MiniVehiclePlacement[] = [];
  for (const v of input.vehicles) {
    const parked = v.path == null;
    const along = v.path ? nearestOnPolyline(v.path, v.impact)?.s ?? 0 : 0;
    const base = diameter * (parked ? 1.0 : 1.7);
    const back = (b: number): Vec2 => {
      if (v.path) return pointAtDistance(v.path, along - b)?.point ?? v.impact;
      const u = unitFromBearing(v.headingDeg);
      return { x: v.impact.x - u.x * b, y: v.impact.y - u.y * b };
    };
    let best: { pos: Vec2; backM: number; score: number } | null = null;
    for (let k = 0; k < STEPS; k++) {
      const b = base + k * diameter * 0.5;
      const pos = back(b);
      const overlapping = placed.some((p) => dist(p.pos, pos) < minSep);
      const touchesPin = dist(pin, pos) < pinClear;
      const building = onBuilding(pos);
      const score = (overlapping ? 4 : 0) + (touchesPin ? 3 : 0) + (building ? 1 : 0);
      if (!best || score < best.score) best = { pos, backM: b, score };
      if (score === 0) break;
    }
    const chosen = best as { pos: Vec2; backM: number };
    placed.push({ id: v.id, pos: chosen.pos, headingDeg: v.headingDeg, backM: chosen.backM });
  }
  return placed;
}

/** Ground meters per pixel for web-mercator tiles at a latitude and zoom. */
export function metersPerPixel(latDeg: number, zoom: number): number {
  return (156543.03392 * Math.cos((latDeg * Math.PI) / 180)) / 2 ** zoom;
}
