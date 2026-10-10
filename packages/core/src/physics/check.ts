// Plain-language checks that the entered details can all be true (DESIGN.md section 18).
// Warnings never block. Codes: nothing-moving, same-direction, zone-mismatch, cannot-meet.
//
// A vehicle's approach is the relative motion of another vehicle (a backing vehicle
// travels opposite to the way it faces). A hit "faces" the marked zone when the
// approach comes from within one zone of it: 90 degrees for the long sides (left,
// right), 67.5 degrees for front, rear and the diagonals. Any of the low, middle and
// high speed cases may explain a hit. If the quick angle test says no, the pair is
// also judged on the real placement geometry (the lanes when roads are given), so a
// hit that fits the road and the bodies is never flagged.
import type { Vec2 } from "../contracts/geometry";
import type { RoadNetwork } from "../contracts/roads";
import type { Scene, SceneVehicle } from "../contracts/scene";
import type { PlainMessage } from "../contracts/simulation";
import { ZONE_WORDS, boundWord } from "../format";
import { angleBetween, bearingOf, dot, fwdOf, mul, norm, sub, toDeg, toRad, wrap2Pi } from "./geo";
import { CASES, type CaseKey, ZONE_ANGLE_RAD, isRearZone, speedCases, zoneToleranceRad } from "./model";
import { placeDetailed } from "./placement";
import { toLocal } from "./projection";
import { cannotWorkOut, validateScene } from "./validate";

const name = (v: SceneVehicle): string => (v.id === "A" ? "your car (A)" : `vehicle ${v.id}`);
const Name = (v: SceneVehicle): string => (v.id === "A" ? "Your car (A)" : `Vehicle ${v.id}`);

/** Where an approach comes from, relative to the vehicle's front, in words. */
function fromWords(relRad: number): string {
  const a = toDeg(wrap2Pi(relRad));
  if (a < 22.5 || a >= 337.5) return "head-on, from the front";
  if (a < 67.5) return "from the front right";
  if (a < 112.5) return "from the right";
  if (a < 157.5) return "from behind on the right";
  if (a < 202.5) return "from behind";
  if (a < 247.5) return "from behind on the left";
  if (a < 292.5) return "from the left";
  return "from the front left";
}

/** Direction of travel as a compass bearing (backing = opposite to facing). */
const travelBearing = (v: SceneVehicle): number => toRad(v.travel.bearingDeg) + (v.action === "backing" ? Math.PI : 0);
/**
 * Is the marked zone on the side of the vehicle that trails as it travels? For a backing vehicle the trailing side is its FRONT
 * (it travels rear first, so a vehicle coming up behind it meets its front); for any other vehicle it is the rear.
 */
const hitFromBehind = (v: SceneVehicle): boolean => (v.action === "backing" ? v.zone === "front" || v.zone === "front-left" || v.zone === "front-right" : isRearZone(v.zone));
const velocity = (v: SceneVehicle, k: CaseKey): Vec2 => mul(fwdOf(travelBearing(v)), speedCases(v)[k]);

export function checkScene(scene: Scene, roads: RoadNetwork | null): readonly PlainMessage[] {
  try {
    // Not trusting the input: a scene the physics can't read gets the plain reasons instead of checks.
    const invalid = validateScene(scene);
    return invalid.length ? invalid : checkValidScene(scene, roads);
  } catch {
    return [cannotWorkOut()];
  }
}

function checkValidScene(scene: Scene, roads: RoadNetwork | null): readonly PlainMessage[] {
  const vs = scene.vehicles;
  const out: PlainMessage[] = [];
  const moving = vs.filter((v) => v.action !== "parked" && speedCases(v).hi > 0);

  // 1. Nothing moving.
  if (moving.length === 0) {
    out.push({
      code: "nothing-moving",
      text: "None of the vehicles is moving, so nothing would have hit anything. Set a speed for at least one vehicle, or check what each was doing.",
      vehicleIds: vs.map((v) => v.id),
    });
    return out;
  }

  // 2. Same direction, neither hit from behind (for a backing vehicle, "from behind" means on its front).
  const handled = new Set<string>();
  for (let i = 0; i < vs.length; i++) {
    for (let j = i + 1; j < vs.length; j++) {
      const a = vs[i]!, b = vs[j]!;
      if (!moving.includes(a) || !moving.includes(b)) continue;
      if (dot(fwdOf(travelBearing(a)), fwdOf(travelBearing(b))) > 0.99 && !hitFromBehind(a) && !hitFromBehind(b)) {
        const dir = boundWord(toDeg(travelBearing(a))).replace("bound", "");
        out.push({
          code: "same-direction",
          text: `${Name(a)} and ${name(b)} were both going ${dir}. When two vehicles going the same way collide, one is usually hit in the rear, but neither is marked that way. Check the directions or where each was hit.`,
          vehicleIds: [a.id, b.id],
        });
        handled.add(a.id);
        handled.add(b.id);
      }
    }
  }

  // 3 and 4. Each vehicle's marked zone has to face where some other vehicle came from.
  const pin = roads ? toLocal(roads.frame, { lat: scene.location.lat, lon: scene.location.lon }) : { x: 0, y: 0 };
  const fitsGeometry = (x: SceneVehicle, y: SceneVehicle): boolean => {
    const r = placeDetailed({ ...scene, vehicles: [x, y] }, roads, pin, { exactZones: true });
    if (r.ok) return true;
    // Only a zone or approach problem counts against the hit; road-matching problems say nothing about it.
    return !r.errors.some((e) => e.code === "zones-cannot-touch" || e.code === "moving-apart");
  };
  for (const x of vs) {
    if (handled.has(x.id)) continue;
    let best: { y: SceneVehicle; rel: number; d: number } | null = null;
    let explained = false, anyMeet = false;
    for (const y of vs) {
      if (y === x) continue;
      for (const k of CASES) {
        const w = sub(velocity(y, k), velocity(x, k));
        if (norm(w) < 0.3) continue;
        anyMeet = true;
        const rel = bearingOf(mul(w, -1)) - toRad(x.travel.bearingDeg);
        const d = angleBetween(rel, ZONE_ANGLE_RAD[x.zone]);
        if (d < zoneToleranceRad(x.zone) - 1e-9) { explained = true; break; }
        if (!best || d < best.d) best = { y, rel, d };
      }
      if (explained) break;
    }
    if (!anyMeet) {
      out.push({
        code: "cannot-meet",
        text: `With these directions and speeds, nothing would have reached ${name(x)}. Check its direction and what it was doing.`,
        vehicleIds: [x.id],
      });
    } else if (!explained && best) {
      if (vs.some((y) => y !== x && fitsGeometry(x, y))) continue;
      out.push({
        code: "zone-mismatch",
        text: `${Name(best.y)} would have come at ${name(x)} ${fromWords(best.rel)}, but ${name(x)} is marked as hit on the ${ZONE_WORDS[x.zone]}.${x.action === "backing" ? ` ${Name(x)} was backing up, so its front is the way it was facing.` : ""} Check the direction, what each vehicle was doing, or where it was hit.`,
        vehicleIds: [x.id, best.y.id],
      });
    }
  }
  return out;
}
