// Checks whether the entered details can all be true together, and explains
// what doesn't fit in plain words. Returns [] when everything fits.
import { ZONE_ANGLE, speedCases, travelDir } from "./physics.js";

import { MPH_TO_MPS as MPH } from "./physics.js";
const CASES = ["lo", "mid", "hi"];
const REAR = new Set(["rear", "rear-left", "rear-right"]);
const ZONE_WORDS = { front: "front", "front-right": "front right", right: "right side", "rear-right": "rear right", rear: "rear", "rear-left": "rear left", left: "left side", "front-left": "front left" };
const name = (v) => (v.id === "A" ? "your car (A)" : `vehicle ${v.id}`);
const Name = (v) => (v.id === "A" ? "Your car (A)" : `Vehicle ${v.id}`);
const COMPASS = { 0: "north", 90: "east", 180: "south", 270: "west" };

function fromWords(rel) {
  const a = ((rel % 360) + 360) % 360;
  if (a < 22.5 || a >= 337.5) return "head-on, from the front";
  if (a < 67.5) return "from the front right";
  if (a < 112.5) return "from the right";
  if (a < 157.5) return "from behind on the right";
  if (a < 202.5) return "from behind";
  if (a < 247.5) return "from behind on the left";
  if (a < 292.5) return "from the left";
  return "from the front left";
}
const angDiff = (a, b) => { const d = Math.abs((((a - b) % 360) + 540) % 360 - 180); return d; };
const bearing = (u) => (Math.atan2(u.x, u.y) * 180) / Math.PI;

function vel(v, k = "mid") {
  const s = speedCases(v)[k] * MPH;
  const u = travelDir(v);
  return { x: u.x * s, y: u.y * s };
}

/** @returns {{ ids: string[], text: string }[]} */
export function validate(scene) {
  const out = [];
  const vs = scene.vehicles;
  const moving = vs.filter((v) => v.action !== "parked" && speedCases(v).hi > 0);
  if (moving.length === 0) {
    out.push({ ids: vs.map((v) => v.id), text: "None of the vehicles is moving, so nothing would have hit anything. Set a speed for at least one vehicle, or check what each was doing." });
    return out;
  }
  const handled = new Set();
  // Same direction, both moving forward, and neither hit in the rear.
  for (let i = 0; i < vs.length; i++) for (let j = i + 1; j < vs.length; j++) {
    const a = vs[i], b = vs[j];
    if (!moving.includes(a) || !moving.includes(b)) continue;
    const ua = travelDir(a), ub = travelDir(b);
    if (ua.x * ub.x + ua.y * ub.y > 0.99 && !REAR.has(a.zone) && !REAR.has(b.zone)) {
      const dir = COMPASS[(((a.action === "backing" ? a.heading + 180 : a.heading) % 360) + 360) % 360] || "the same way";
      out.push({ ids: [a.id, b.id], text: `${Name(a)} and ${name(b)} were both going ${dir}. When two vehicles going the same way collide, one is usually hit in the rear, but neither is marked that way. Check the directions or where each was hit.` });
      handled.add(a.id); handled.add(b.id);
    }
  }
  // Each vehicle's marked zone has to face where some other vehicle came from.
  for (const x of vs) {
    if (handled.has(x.id)) continue;
    let best = null, explained = false, anyMeet = false;
    // Any of the low, middle or high speed cases may explain the hit.
    for (const y of vs) {
      if (y === x) continue;
      for (const k of CASES) {
        const w = { x: vel(y, k).x - vel(x, k).x, y: vel(y, k).y - vel(x, k).y };
        if (Math.hypot(w.x, w.y) < 0.3) continue;
        anyMeet = true;
        const rel = bearing({ x: -w.x, y: -w.y }) - x.heading;
        const d = angDiff(rel, ZONE_ANGLE[x.zone]);
        if (d <= 67.5) { explained = true; break; }
        if (!best || d < best.d) best = { y, rel, d };
      }
      if (explained) break;
    }
    if (!anyMeet) {
      out.push({ ids: [x.id], text: `With these directions and speeds, nothing would have reached ${name(x)}. Check its direction and what it was doing.` });
    } else if (!explained && best) {
      out.push({ ids: [x.id, best.y.id], text: `${Name(best.y)} would have come at ${name(x)} ${fromWords(best.rel)}, but ${name(x)} is marked as hit on the ${ZONE_WORDS[x.zone]}. Check the direction, what each vehicle was doing, or where it was hit.` });
    }
  }
  return out;
}
