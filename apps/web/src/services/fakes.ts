// Stand-ins for the locked core/mapdata/exports functions. They exist so the screens can be
// built, tested and screenshotted before the real physics, Overpass parsing and exports land.
// They are deliberately crude (straight-line motion, no lane logic) and are used only in
// tests and in fixtures mode while the real function still throws "not implemented yet".
import {
  APPROACH_S, DEFAULT_LIMIT_MPH, DISCLAIMER_LONG, FRICTION, MPH_TO_MPS, PHYSICS_VERSION, PRESETS, RANGE_HALF_MPH,
  boundWord, canonicalJson, sha256Hex, shortFingerprint,
  type Building, type ExportBundle, type LanePath, type LatLon, type LocalFrame, type ParkingArea, type PlacedVehicle,
  type PlacementOutcome, type PlainMessage, type Pose, type Range, type RoadKind, type RoadNetwork, type RoadWay,
  type FixSuggestions, type Scene, type SceneVehicle, type SimulationOutcome, type SimulationResult, type StreetsAtPin, type TravelChoice,
  type VehicleResult, type Vec2, type Zone,
} from "@csd/core";
import { angleDiffDeg, bearingDeg, DEG, dist, nearestOnPolyline, offsetPolyline, unitFromBearing } from "../lib/geometry";
import { poseFromTrack } from "../lib/track";
import type { ExportInput } from "./types";

const M_PER_DEG = 111_320;

export function fakeToLocal(frame: LocalFrame, p: LatLon): Vec2 {
  return { x: (p.lon - frame.origin.lon) * M_PER_DEG * Math.cos(frame.origin.lat * DEG), y: (p.lat - frame.origin.lat) * M_PER_DEG };
}
export function fakeToLatLon(frame: LocalFrame, v: Vec2): LatLon {
  return { lat: frame.origin.lat + v.y / M_PER_DEG, lon: frame.origin.lon + v.x / (M_PER_DEG * Math.cos(frame.origin.lat * DEG)) };
}

/* ---------- Overpass JSON -> RoadNetwork (no segment merging) ---------- */

interface OsmWay { type: "way"; id: number; tags?: Record<string, string>; geometry?: Array<{ lat: number; lon: number }> }
const KINDS: Record<string, RoadKind> = {
  motorway: "motorway", motorway_link: "motorway", trunk: "trunk", trunk_link: "trunk", primary: "primary", primary_link: "primary",
  secondary: "secondary", secondary_link: "secondary", tertiary: "tertiary", tertiary_link: "tertiary", residential: "residential",
  living_street: "residential", unclassified: "unclassified", service: "service",
};
const signedArea = (pts: readonly Vec2[]) => pts.reduce((s, p, i) => { const q = pts[(i + 1) % pts.length] as Vec2; return s + (p.x * q.y - q.x * p.y); }, 0) / 2;

export function fakeParseOverpass(json: unknown, frame: LocalFrame, radiusM: number, fetchedAt: string): RoadNetwork {
  const elements = ((json as { elements?: unknown[] } | null)?.elements ?? []) as OsmWay[];
  const ways: RoadWay[] = [];
  const buildings: Building[] = [];
  const parking: ParkingArea[] = [];
  const toLocal = (g: Array<{ lat: number; lon: number }>) => g.map((p) => fakeToLocal(frame, p));
  for (const el of elements) {
    if (el.type !== "way" || !el.geometry || el.geometry.length < 2) continue;
    const tags = el.tags ?? {};
    const pts = toLocal(el.geometry);
    if (tags.highway) {
      const isAisle = tags.highway === "service" && tags.service === "parking_aisle";
      const kind = isAisle ? "parking_aisle" : (KINDS[tags.highway] ?? "other");
      const oneway = ["yes", "1", "true"].includes(tags.oneway ?? "") || tags.junction === "roundabout";
      const lanes = Number(tags.lanes);
      const total = Number.isFinite(lanes) && lanes > 0 ? lanes : oneway ? 1 : 2;
      const width = Number(tags.width);
      const maxspeed = /(\d+)\s*mph/.exec(tags.maxspeed ?? "");
      ways.push({
        id: `w${el.id}`, name: tags.name ?? null, ref: tags.ref ?? null, kind, oneway,
        lanesForward: oneway ? total : Math.ceil(total / 2), lanesBackward: oneway ? 0 : Math.floor(total / 2),
        laneWidthM: Number.isFinite(width) && width > 0 ? width / total : 3.5,
        centerline: pts, speedLimitMph: maxspeed ? Number(maxspeed[1]) : null, osmWayIds: [el.id],
      });
    } else if (tags.building && pts.length >= 4) {
      const ring = pts.slice(0, -1);
      const footprint = signedArea(ring) < 0 ? [...ring].reverse() : ring;
      const h = Number(tags.height);
      const levels = Number(tags["building:levels"]);
      buildings.push({ id: `b${el.id}`, footprint, heightM: Number.isFinite(h) && h > 0 ? h : Number.isFinite(levels) && levels > 0 ? levels * 3 : 6, heightSource: Number.isFinite(h) && h > 0 ? "height-tag" : Number.isFinite(levels) && levels > 0 ? "levels-tag" : "default" });
    } else if (tags.amenity === "parking" && pts.length >= 4) {
      parking.push({ id: `p${el.id}`, outline: pts.slice(0, -1) });
    }
  }
  return { frame, radiusM, ways, buildings, parking, terrain: null, attribution: ["© OpenStreetMap contributors (ODbL)"], fetchedAt };
}

/* ---------- Streets at the pin ---------- */

export function fakeStreetsAtPin(net: RoadNetwork, pin: Vec2): StreetsAtPin {
  const near = net.ways
    .filter((w) => w.kind !== "parking_aisle" && w.name)
    .map((w) => ({ w, n: nearestOnPolyline(w.centerline, pin) }))
    .filter((d): d is { w: RoadWay; n: NonNullable<typeof d.n> } => d.n != null && d.n.distance <= 25)
    .sort((a, b) => a.n.distance - b.n.distance);
  const roads: Array<{ roadId: string; name: string | null; distanceM: number }> = [];
  const directions: TravelChoice[] = [];
  const legs: StreetsAtPin["legs"][number][] = [];
  const seen = new Set<string>();
  for (const { w, n } of near) {
    roads.push({ roadId: w.id, name: w.name, distanceM: n.distance });
    const a = w.centerline[n.segment] as Vec2;
    const b = w.centerline[n.segment + 1] as Vec2;
    const fwd = bearingDeg(a, b);
    for (const [bearing, allowed] of [[fwd, true], [(fwd + 180) % 360, !w.oneway]] as const) {
      if (!allowed) continue;
      const bound = boundWord(bearing);
      const label = `${bound} on ${w.name}`;
      if (seen.has(label)) continue;
      seen.add(label);
      directions.push({ roadId: w.id, roadName: w.name, roadDesc: null, bearingDeg: bearing, bound, label });
      legs.push({ roadId: w.id, name: w.name, outwardBearingDeg: (bearing + 180) % 360, junction: n.point });
    }
  }
  directions.sort((a, b) => (a.roadName ?? "").localeCompare(b.roadName ?? "") || a.bearingDeg - b.bearingDeg);
  return { pin, roads, legs, directions };
}

/* ---------- Placement and simulation (straight lines through the pin) ---------- */

const ZONE_ANGLE: Record<Zone, number> = { front: 0, "front-right": 45, right: 90, "rear-right": 135, rear: 180, "rear-left": 225, left: 270, "front-left": 315 };
const sizeOf = (v: SceneVehicle) => PRESETS[v.type];

/** Speed range in m/s: known = a point; unsure = limit +/- 5 mph. */
function speedRange(v: SceneVehicle): Range {
  if (v.action === "parked") return { lo: 0, mid: 0, hi: 0 };
  if (v.speed.kind === "known") { const s = v.speed.mph * MPH_TO_MPS; return { lo: s, mid: s, hi: s }; }
  const limit = v.speed.limitMph ?? DEFAULT_LIMIT_MPH;
  return { lo: Math.max(0, limit - RANGE_HALF_MPH) * MPH_TO_MPS, mid: limit * MPH_TO_MPS, hi: (limit + RANGE_HALF_MPH) * MPH_TO_MPS };
}

/** Vehicle center when its marked zone touches the impact point, plus a lane offset to the right. */
function impactCenter(v: SceneVehicle, pin: Vec2): Vec2 {
  const p = sizeOf(v);
  const L = p.length.value;
  const W = p.width.value;
  const facing = v.travel.bearingDeg;
  const f = unitFromBearing(facing);
  const r = unitFromBearing(facing + 90);
  const ang = ZONE_ANGLE[v.zone] * DEG;
  // Zone direction in the vehicle frame: forward component cos, right component sin.
  const zf = Math.cos(ang);
  const zr = Math.sin(ang);
  const lane = 1.75;
  const lateral = v.action === "parked" ? 0 : lane;
  return {
    x: pin.x - f.x * zf * (L / 2) - r.x * zr * (W / 2) + r.x * lateral,
    y: pin.y - f.y * zf * (L / 2) - r.y * zr * (W / 2) + r.y * lateral,
  };
}

export function fakePlaceVehicles(scene: Scene, _roads: RoadNetwork | null, pin: Vec2): PlacementOutcome {
  const vehicles: PlacedVehicle[] = scene.vehicles.map((v) => {
    const c = impactCenter(v, pin);
    const motion = v.action === "backing" ? (v.travel.bearingDeg + 180) % 360 : v.travel.bearingDeg;
    const u = unitFromBearing(motion);
    const headingRad = v.travel.bearingDeg * DEG;
    const spd = speedRange(v).mid;
    const path: LanePath | null = v.action === "parked" ? null : {
      roadId: v.travel.roadId ?? "template", laneIndex: v.travel.lane ?? 0,
      points: [{ x: c.x - u.x * 120, y: c.y - u.y * 120 }, { x: c.x + u.x * 40, y: c.y + u.y * 40 }],
    };
    return { id: v.id, path, impactPose: { xM: c.x, yM: c.y, headingRad, speedMps: spd } };
  });
  return { ok: true, impactPointM: pin, vehicles };
}

const FAKE_DT = 1 / 30;

export function fakeSimulate(scene: Scene, roads: RoadNetwork | null): SimulationOutcome {
  const pin = roads ? fakeToLocal(roads.frame, scene.location) : { x: 0, y: 0 };
  const placed = fakePlaceVehicles(scene, roads, pin);
  if (!placed.ok) return { ok: false, errors: placed.errors };
  const mu = FRICTION[scene.road.condition];
  const g = 9.80665;
  const info = scene.vehicles.map((v) => {
    const p = sizeOf(v);
    const placement = placed.vehicles.find((x) => x.id === v.id) as PlacedVehicle;
    const motion = unitFromBearing(v.action === "backing" ? (v.travel.bearingDeg + 180) % 360 : v.travel.bearingDeg);
    const sp = speedRange(v);
    return { v, p, placement, motion, sp, mass: p.mass.value };
  });
  const mass = info.reduce((s, i) => s + i.mass, 0);
  const vx = info.reduce((s, i) => s + i.mass * i.motion.x * i.sp.mid, 0) / mass;
  const vy = info.reduce((s, i) => s + i.mass * i.motion.y * i.sp.mid, 0) / mass;
  const vPost = Math.hypot(vx, vy);
  const slideT = vPost / (mu * g);
  const slideD = (vPost * vPost) / (2 * mu * g);
  const dir = vPost > 1e-6 ? { x: vx / vPost, y: vy / vPost } : { x: 0, y: 0 };
  const startTimeS = -APPROACH_S;
  const restTimeS = Math.max(1, Math.ceil(slideT * 10) / 10);
  const steps = Math.round((restTimeS - startTimeS) / FAKE_DT);
  const vehicles: VehicleResult[] = info.map(({ v, p, placement, motion, sp }) => {
    const imp = placement.impactPose;
    const track: Pose[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = startTimeS + i * FAKE_DT;
      if (t <= 0) track.push({ xM: imp.xM + motion.x * sp.mid * t, yM: imp.yM + motion.y * sp.mid * t, headingRad: imp.headingRad, speedMps: sp.mid });
      else {
        const tt = Math.min(t, slideT);
        const along = vPost * tt - 0.5 * mu * g * tt * tt;
        track.push({ xM: imp.xM + dir.x * along, yM: imp.yM + dir.y * along, headingRad: imp.headingRad, speedMps: Math.max(0, vPost - mu * g * tt) });
      }
    }
    const rest = track[track.length - 1] as Pose;
    const approach = sp.mid * APPROACH_S;
    return {
      id: v.id, type: v.type, massKg: p.mass.value, lengthM: p.length.value, widthM: p.width.value,
      inertiaKgM2: (p.mass.value * (p.length.value ** 2 + p.width.value ** 2)) / 12,
      path: placement.path, speedAtImpactMps: sp,
      approachDistanceM: { lo: sp.lo * APPROACH_S, mid: approach, hi: sp.hi * APPROACH_S },
      postImpactDistanceM: { lo: slideD, mid: slideD, hi: slideD },
      impactPose: imp, restPose: rest, track,
    };
  });
  const gaps = [] as SimulationResult["gaps"][number][];
  for (let i = 0; i < vehicles.length; i++) for (let j = i + 1; j < vehicles.length; j++) {
    const a = vehicles[i] as VehicleResult;
    const b = vehicles[j] as VehicleResult;
    const d = dist({ x: a.restPose.xM, y: a.restPose.yM }, { x: b.restPose.xM, y: b.restPose.yM });
    gaps.push({ a: a.id, b: b.id, restGapM: { lo: d, mid: d, hi: d } });
  }
  const result: SimulationResult = {
    physicsVersion: `${PHYSICS_VERSION}-fixtures-stand-in`, dtS: FAKE_DT, startTimeS, impactTimeS: 0, restTimeS,
    frictionCoefficient: mu, restitution: 0, impactPointM: pin, vehicles, gaps,
    assumptions: [{ id: "friction", text: `Road ${scene.road.condition}, as entered: friction ${mu} for the whole road.`, value: mu }],
    warnings: [],
  };
  return { ok: true, result };
}

export const fakePoseAt = poseFromTrack;

/* ---------- Plain checks (DESIGN.md section 18), road-aware only through the bearings ---------- */

const REAR = new Set<Zone>(["rear", "rear-left", "rear-right"]);
const ZONE_TEXT: Record<Zone, string> = { front: "front", "front-right": "front right", right: "right side", "rear-right": "rear right", rear: "rear", "rear-left": "rear left", left: "left side", "front-left": "front left" };
const who = (v: SceneVehicle) => (v.id === "A" ? "your car (A)" : `vehicle ${v.id}`);
const Who = (v: SceneVehicle) => (v.id === "A" ? "Your car (A)" : `Vehicle ${v.id}`);

function fromWords(rel: number): string {
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

/** Stand-in for suggestFixes until the physics is merged: no one-tap fixes, edit by hand. */
export function fakeSuggestFixes(_scene: Scene, _roads: RoadNetwork | null): FixSuggestions {
  return { why: "", fixes: [], focus: { step: "vehicles", vehicleId: null, field: null }, trials: 0 };
}

export function fakeCheckScene(scene: Scene, _roads: RoadNetwork | null): readonly PlainMessage[] {
  const out: PlainMessage[] = [];
  const vs = scene.vehicles;
  const motionBearing = (v: SceneVehicle) => (v.action === "backing" ? (v.travel.bearingDeg + 180) % 360 : v.travel.bearingDeg);
  const vel = (v: SceneVehicle, k: keyof Range): Vec2 => { const s = speedRange(v)[k]; const u = unitFromBearing(motionBearing(v)); return { x: u.x * s, y: u.y * s }; };
  const moving = vs.filter((v) => v.action !== "parked" && speedRange(v).hi > 0);
  if (moving.length === 0) {
    return [{ code: "nothing-moving", vehicleIds: vs.map((v) => v.id), text: "None of the vehicles is moving, so nothing would have hit anything. Set a speed for at least one vehicle, or check what each was doing." }];
  }
  const handled = new Set<string>();
  for (let i = 0; i < vs.length; i++) for (let j = i + 1; j < vs.length; j++) {
    const a = vs[i] as SceneVehicle;
    const b = vs[j] as SceneVehicle;
    if (!moving.includes(a) || !moving.includes(b)) continue;
    if (angleDiffDeg(motionBearing(a), motionBearing(b)) < 8 && !REAR.has(a.zone) && !REAR.has(b.zone)) {
      out.push({ code: "same-direction", vehicleIds: [a.id, b.id], text: `${Who(a)} and ${who(b)} were both going ${boundWord(motionBearing(a)).replace("bound", "")}. When two vehicles going the same way collide, one is usually hit in the rear, but neither is marked that way. Check the directions or where each was hit.` });
      handled.add(a.id); handled.add(b.id);
    }
  }
  for (const x of vs) {
    if (handled.has(x.id)) continue;
    let best: { y: SceneVehicle; rel: number; d: number } | null = null;
    let explained = false;
    let anyMeet = false;
    for (const y of vs) {
      if (y === x) continue;
      for (const k of ["lo", "mid", "hi"] as const) {
        const vx = vel(x, k);
        const vy = vel(y, k);
        const w = { x: vy.x - vx.x, y: vy.y - vx.y };
        if (Math.hypot(w.x, w.y) < 0.3) continue;
        anyMeet = true;
        const rel = bearingDeg({ x: 0, y: 0 }, { x: -w.x, y: -w.y }) - x.travel.bearingDeg;
        const d = angleDiffDeg(rel, ZONE_ANGLE[x.zone]);
        if (d <= 67.5) { explained = true; break; }
        if (!best || d < best.d) best = { y, rel, d };
      }
      if (explained) break;
    }
    if (!anyMeet) out.push({ code: "cannot-meet", vehicleIds: [x.id], text: `With these directions and speeds, nothing would have reached ${who(x)}. Check its direction and what it was doing.` });
    else if (!explained && best) out.push({ code: "zone-mismatch", vehicleIds: [x.id, best.y.id], text: `${Who(best.y)} would have come at ${who(x)} ${fromWords(best.rel)}, but ${who(x)} is marked as hit on the ${ZONE_TEXT[x.zone]}. Check the direction, what each vehicle was doing, or where it was hit.` });
  }
  return out;
}

/* ---------- Search results ---------- */

export function fakeMergeSearchResults<T extends { label: string; lat: number; lon: number; kind: string }>(results: readonly T[]): T[] {
  const out: T[] = [];
  for (const r of results) {
    const dup = out.find((o) => o.label.toLowerCase() === r.label.toLowerCase() && Math.abs(o.lat - r.lat) < 0.003 && Math.abs(o.lon - r.lon) < 0.003);
    if (!dup) out.push(r);
  }
  return out;
}

/** Minimal "X and Y, place" splitter used until mapdata's real one lands. */
export function fakeSplitCrossingQuery(q: string): { a: string; b: string; near: string } | null {
  const m = /^\s*(.+?)\s+(?:and|&)\s+(.+?)\s*(?:,\s*(.+))?$/i.exec(q);
  if (!m) return null;
  const a = m[1]?.trim();
  const rest = m[2]?.trim();
  if (!a || !rest) return null;
  // "Main St and Park St Nashua NH" without a comma: the second street ends at its type word.
  const typed = /^(.+?\b(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|way|ct|court|pl|place|pkwy|hwy|highway|tpke|turnpike)\b\.?)\s+(.+)$/i.exec(rest);
  const b = m[3] ? rest : (typed?.[1] ?? rest);
  const near = m[3]?.trim() ?? typed?.[2]?.trim() ?? "";
  return { a, b, near };
}

/* ---------- Exports: the scene file only ---------- */

export async function fakeBuildExports(input: ExportInput): Promise<ExportBundle> {
  const createdAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const text = canonicalJson({ ...input.scene, createdAt, disclaimer: DISCLAIMER_LONG, derived: { physicsVersion: input.sim.physicsVersion } });
  const hex = await sha256Hex(text);
  const stamp = { createdAt, fingerprintHex: hex, fingerprintShort: shortFingerprint(hex) };
  return { stamp, files: input.formats.includes("json") ? [{ name: `crash-scene-${input.scene.claim.number}.json`, mime: "application/json", bytes: new TextEncoder().encode(text) }] : [], skipped: [], notes: [] };
}

export { offsetPolyline };
