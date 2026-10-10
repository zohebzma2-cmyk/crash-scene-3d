// Where a street's name could be painted on the road. These are only candidate spots in world
// meters: the viewer passes them through the label collision avoidance together with the vehicle
// labels and measurement pills, and a name that has no free spot is left off.
import type { RoadNetwork, Scene, SceneVehicle, Vec2 } from "@csd/core";
import { angleDiffDeg, pointAtDistance, polylineLength } from "./geometry";
import type { ViewBox } from "./diagramView";

export interface StreetSpot {
  readonly at: Vec2;
  /** Text direction, degrees counter-clockwise from east in the world, kept upright (-90 to 90). */
  readonly angleDeg: number;
}
export interface StreetName {
  readonly name: string;
  /** Best spot first. */
  readonly spots: readonly StreetSpot[];
}

/** How far apart candidate spots along a road are, meters. */
const SPOT_SPACING_M = 10;
const MAX_SPOTS = 12;
/** Names are preferably painted this share of the view's short side away from the impact. */
const PREFERRED_SHARE = 0.3;
/** Template roads: spots at these distances either side of the impact, meters. */
const TEMPLATE_STEPS_M = [12, 24, 36, 48];

const upright = (deg: number): number => {
  let a = deg;
  while (a > 90) a -= 180;
  while (a < -90) a += 180;
  return a;
};

/** Distinct travel lines (compass bearings mod 180) for the no-road-data template. */
export function templateAxes(vehicles: readonly SceneVehicle[]): number[] {
  const axes: number[] = [];
  for (const v of vehicles) {
    const b = ((v.travel.bearingDeg % 180) + 180) % 180;
    if (!axes.some((a) => angleDiffDeg(a * 2, b * 2) / 2 < 10)) axes.push(b);
  }
  return axes;
}

const inView = (p: Vec2, vb: ViewBox): boolean => p.x > vb.x && p.x < vb.x + vb.w && -p.y > vb.y && -p.y < vb.y + vb.h;

export function streetNames(scene: Scene, roads: RoadNetwork | null, vb: ViewBox, focus: Vec2): StreetName[] {
  const want = Math.min(vb.w, vb.h) * PREFERRED_SHARE;
  const rank = (p: Vec2) => Math.abs(Math.hypot(p.x - focus.x, p.y - focus.y) - want);
  const out: StreetName[] = [];

  if (roads) {
    // One name can be several ways (a road split at every junction): gather spots from all of them.
    const byName = new Map<string, StreetSpot[]>();
    for (const w of roads.ways) {
      if (!w.name || w.kind === "parking_aisle") continue;
      const spots = byName.get(w.name) ?? [];
      const total = polylineLength(w.centerline);
      for (let s = SPOT_SPACING_M / 2; s < total; s += SPOT_SPACING_M) {
        const p = pointAtDistance(w.centerline, s);
        if (p && inView(p.point, vb)) spots.push({ at: p.point, angleDeg: upright(90 - p.bearingDeg) });
      }
      byName.set(w.name, spots);
    }
    for (const [name, spots] of byName) {
      spots.sort((a, b) => rank(a.at) - rank(b.at));
      if (spots.length) out.push({ name, spots: spots.slice(0, MAX_SPOTS) });
    }
    return out;
  }

  const axes = templateAxes(scene.vehicles);
  axes.forEach((axis) => {
    const named = scene.vehicles.find((v) => angleDiffDeg((((v.travel.bearingDeg % 180) + 180) % 180) * 2, axis * 2) / 2 < 10 && v.travel.roadName)?.travel.roadName;
    if (!named || out.some((o) => o.name === named)) return;
    const dir = { x: Math.sin((axis * Math.PI) / 180), y: Math.cos((axis * Math.PI) / 180) };
    const spots: StreetSpot[] = [];
    for (const d of TEMPLATE_STEPS_M) for (const sign of [1, -1]) {
      const at = { x: focus.x + dir.x * d * sign, y: focus.y + dir.y * d * sign };
      if (inView(at, vb)) spots.push({ at, angleDeg: upright(90 - axis) });
    }
    spots.sort((a, b) => rank(a.at) - rank(b.at));
    if (spots.length) out.push({ name: named, spots });
  });
  return out;
}
