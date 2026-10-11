// When the picture can't be drawn, the closest details that would draw (DESIGN.md section 18).
//
// suggestFixes runs the physics on small changes to what was entered and keeps only the ones that draw exactly as the
// button says: one vehicle's hit side, its direction (the same road-relative choices step 2 offers, or N/E/S/W without
// roads) or what it was doing; who hit whom (two hit sides swapped); a speed inside a "not sure" range; moving the pin
// onto the nearest road; then two hit sides together, and a direction, action or pin change with the hit sides it needs.
// A vehicle on the wrong way of a one-way street, or in a lane its road doesn't have, is repaired first. At most
// MAX_FIXES, smallest change first, the same every time. Pure TS, no DOM; it runs in a Web Worker in the app.
//
// Speed: each change is judged with drawsAsEntered() (the same answer as simulate(), without the picture), the search is
// capped by counts by vehicle count (never a clock, so it is deterministic), and only the fixes offered go through a full
// simulate(). Refusals these fields can't cure (input the physics can't read, a crash too long to play out at a typed
// speed) get no fixes; `focus` says which detail to edit by hand instead.
import type { RoadNetwork, RoadWay } from "../contracts/roads";
import type { Action, Scene, SceneVehicle, VehicleId, Zone } from "../contracts/scene";
import { ACTIONS, ZONES } from "../contracts/scene";
import type { PlainMessage } from "../contracts/simulation";
import type { Vec2 } from "../contracts/geometry";
import { ZONE_WORDS, boundWord, formatDistance, formatMphNumber, formatSpeedExact } from "../format";
import { MPH_TO_MPS, RANGE_HALF_MPH, RANGE_STEP_MPH } from "./constants";
import { angleBetween, dist, makePoly, norm, polyCrossings, project, toRad } from "./geo";
import { cleanNet, streetName, streetsAtPin } from "./lanes";
import { ZONE_ANGLE_RAD, speedCases } from "./model";
import { type FacingZone, buildGuide, zonesFacing } from "./placement";
import { toLatLon, toLocal } from "./projection";
import { type WorkMeter, drawsAsEntered, simulate } from "./simulate";
import { checkScene } from "./check";

/** At most this many fixes are offered. */
export const MAX_FIXES = 3;
/**
 * How far a one-tap fix may move the pin, m, from the centre of the road data it was checked against. The app reuses loaded
 * road data while the pin stays within 100 m of its centre (REUSE_RADIUS_M in apps/web/src/state/Roads.tsx), so a fix that
 * moves the pin less than this draws on the very same roads after the tap.
 */
export const PIN_FIX_MAX_M = 90;
/** A pin closer than this to the road is already on it, m. */
const PIN_FIX_MIN_M = 2;

/**
 * The search's work limits, the same for any number of vehicles: at most `checks` changes judged, and at most `units` of
 * work spent judging them (WorkMeter: a scene of three or four costs several times as much per change, so it gets fewer).
 * Counts, never a clock, so the fixes found are the same on every device. Chosen so the worst benchmark scene takes under
 * 300 ms off the main thread (docs/FIXER-BENCHMARK.md).
 */
export const FIX_LIMITS = Object.freeze({ checks: 140, units: 1_500_000 });
/** Work units charged per vehicle for working out which hit sides each vehicle could be reached on (no placing). */
const FACING_UNITS = 100;
/** Kept for callers that report the old cap: the most changes judged per search. */
export const MAX_FIX_TRIALS = FIX_LIMITS.checks;

export type FixField = "zone" | "direction" | "action" | "lane" | "speed" | "pin";

export interface FixChange {
  /** The vehicle changed; null for the pin. */
  readonly vehicleId: VehicleId | null;
  readonly field: FixField;
  /** Plain words for the value before and after ("Rear", "Front"). */
  readonly from: string;
  readonly to: string;
  /** The fields of the vehicle this change sets. */
  readonly patch: Partial<Pick<SceneVehicle, "zone" | "travel" | "action" | "speed">>;
  /** For the pin: where it goes. */
  readonly location?: { readonly lat: number; readonly lon: number };
}

export interface Fix {
  /** Stable id from the changes, e.g. "A.zone=front". */
  readonly id: string;
  /** One plain sentence for the button: "Change A's hit side to Right side". */
  readonly label: string;
  readonly changes: readonly FixChange[];
  /** How many details it changes (a swap of two hit sides is two). Fixes come smallest first. */
  readonly size: number;
  /** Among fixes of one size, smaller is a smaller change. */
  readonly cost: number;
  /**
   * What kind of change it is, with no scene details: the fields changed and whether each vehicle was marked as the one
   * doing the hitting (a front hit side) or the one hit, e.g. "zone:struck", "direction:striking+zone:struck", "swap",
   * "pin". The device remembers which kinds a claimant picks (local only) to rank them higher next time.
   */
  readonly kind: string;
  /** The plain checks (checkScene) have a note about the fixed scene. */
  readonly notes: boolean;
  /** The scene with the changes made; simulate() draws it. */
  readonly scene: Scene;
}

/** Which detail to edit by hand when no one-tap fix exists (or the claimant prefers to). */
export interface FixFocus {
  readonly step: "location" | "vehicles";
  readonly vehicleId: VehicleId | null;
  readonly field: "zone" | "direction" | "action" | "speed" | "location" | null;
}

export interface FixSuggestions {
  /** One plain sentence: why the details as entered can't happen. Empty when they draw. */
  readonly why: string;
  readonly fixes: readonly Fix[];
  readonly focus: FixFocus;
  /** How many trial runs of the physics were made (checks, probes and full simulations). */
  readonly trials: number;
}

export interface FixOptions {
  /**
   * How strongly this device's claimant has preferred each kind of fix (Fix.kind) before: among fixes of the same size,
   * a higher score comes first. Local only; it never changes which fixes are found, only their order.
   */
  readonly prefer?: Readonly<Record<string, number>>;
  /** Other work limits than FIX_LIMITS: for the benchmark's "no limit" ceiling and for tests. The app never sets them. */
  readonly limits?: Partial<typeof FIX_LIMITS>;
}

/** Refusals no change of hit side, direction, action, speed or pin can cure: they are fixed by hand. */
const HAND_ONLY: Readonly<Record<string, FixFocus["field"]>> = {
  "too-few-vehicles": null, "too-many-vehicles": null, "bad-location": "location", "bad-pin": "location",
  "bad-road-condition": null, "bad-vehicle": null, "bad-direction": "direction", "bad-lane": "direction", "bad-speed": "speed",
  "cannot-work-out": null,
};

/** Where to send the claimant for each refusal when editing by hand. */
const FOCUS_FIELD: Readonly<Record<string, FixFocus["field"]>> = {
  ...HAND_ONLY,
  "no-road": "location", "too-long": "speed",
  "zones-cannot-touch": "zone", "bodies-overlap": "zone", "moving-apart": "direction", "not-moving-toward": "speed", "too-slow": "speed",
  "passes-through": "direction", "on-building": "direction", "wrong-way": "direction", "no-such-lane": "direction", "nothing-moving": "action",
  "no-workable-speed": "speed",
};

/** Refusals about one vehicle's own path on its road: repaired first. */
const LOCAL = new Set(["wrong-way", "no-such-lane"]);
const FRONT_ZONES: ReadonlySet<Zone> = new Set<Zone>(["front", "front-left", "front-right"]);

export const ACTION_LABELS: Readonly<Record<Action, string>> = {
  straight: "Going straight", "turn-left": "Turning left", "turn-right": "Turning right", backing: "Backing up", parked: "Parked",
};

/** Plain code-unit order: the same in every locale. */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const ucFirst = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const zoneWords = (z: Zone): string => ucFirst(ZONE_WORDS[z]);
const FACING: Readonly<Record<string, string>> = { northbound: "north", eastbound: "east", southbound: "south", westbound: "west" };

/** The first sentence of a refusal, without its "Check ..." advice. */
export function whySentence(errors: readonly PlainMessage[]): string {
  const text = errors[0]?.text ?? "";
  const first = /^(.*?[.!?])(\s|$)/.exec(text)?.[1] ?? text;
  return first.trim();
}

function focusFor(errors: readonly PlainMessage[], scene: Scene): FixFocus {
  const e = errors[0];
  const field = e ? FOCUS_FIELD[e.code] ?? null : null;
  const known = new Set(scene.vehicles?.map((v) => v.id) ?? []);
  const vehicleId = e?.vehicleIds.find((id) => known.has(id)) ?? null;
  return { step: field === "location" ? "location" : "vehicles", vehicleId: field === "location" ? null : vehicleId, field };
}

interface Candidate {
  readonly cost: number;
  readonly changes: readonly FixChange[];
  /** Two hit sides exchanged: who hit whom. */
  readonly swap?: boolean;
}

interface DirectionOption { readonly bearingDeg: number; readonly roadId: string | null; readonly roadName: string | null }

/** Results that depend only on the road data and the pin, worked out once per search. */
interface PinWorld {
  readonly net: RoadNetwork | null;
  readonly pin: Vec2;
  readonly dirs: DirectionOption[];
}

/** The direction choices step 2 offers: road-relative at the pin, else N/E/S/W. */
function directionOptions(net: RoadNetwork | null, pin: Vec2): DirectionOption[] {
  if (net) {
    const choices = streetsAtPin(net, pin).directions;
    if (choices.length) return choices.map((c) => ({ bearingDeg: c.bearingDeg, roadId: c.roadId, roadName: c.roadName }));
  }
  return [0, 90, 180, 270].map((bearingDeg) => ({ bearingDeg, roadId: null, roadName: null }));
}

const sameRoad = (t: SceneVehicle["travel"], o: DirectionOption): boolean =>
  (t.roadId != null && t.roadId === o.roadId) || (t.roadName != null && t.roadName === o.roadName) || (t.roadName == null && o.roadName == null);
const angleDeg = (a: number, b: number): number => (angleBetween(toRad(a), toRad(b)) * 180) / Math.PI;

function directionWords(v: SceneVehicle, o: DirectionOption, roadChanged: boolean): string {
  const bound = boundWord(o.bearingDeg);
  const on = roadChanged && o.roadName ? ` on ${o.roadName}` : "";
  return v.action === "parked" || v.action === "backing" ? `Facing ${FACING[bound]}${on}` : `${ucFirst(bound)}${on}`;
}

/** "at 25 mph", or for a "not sure" speed "at a speed the picture picks". */
function speedWords(v: SceneVehicle): string {
  return v.speed.kind === "known" ? `at ${formatSpeedExact(v.speed.mph * MPH_TO_MPS)}` : "at a speed the picture picks";
}

// ---------------------------------------------------------------- the pin

interface PinOption { readonly point: Vec2; readonly d: number; readonly words: string }

/** Drivable roads a pin may move onto: every way the road data has (parking aisles included). */
const roadWords = (w: RoadWay): string => streetName(w) ?? (w.kind === "parking_aisle" ? "the parking aisle" : "the nearest road");

const pinCache = new WeakMap<RoadNetwork, Map<string, PinOption[]>>();
/**
 * Where the pin could go: the nearest point of the two nearest streets ("onto Main Street"), and the nearest place two
 * streets cross ("to where Main Street meets Park Street"), each at least PIN_FIX_MIN_M away and no further than
 * PIN_FIX_MAX_M from the road data's centre. Nearest first, at most three.
 */
function pinOptions(net: RoadNetwork, pin: Vec2): PinOption[] {
  let table = pinCache.get(net);
  if (!table) { table = new Map(); pinCache.set(net, table); }
  const key = `${pin.x},${pin.y}`;
  const hit = table.get(key);
  if (hit) return hit;
  const reach = (p: Vec2): boolean => norm(p) <= PIN_FIX_MAX_M;
  const near = net.ways
    .map((w) => ({ w, poly: makePoly(w.centerline), pr: project(makePoly(w.centerline), pin) }))
    .filter((x) => x.pr.dist <= PIN_FIX_MAX_M * 2)
    .sort((a, b) => a.pr.dist - b.pr.dist || cmp(a.w.id, b.w.id));
  const out: PinOption[] = [];
  const streets = new Set<string>();
  for (const x of near) {
    const words = roadWords(x.w);
    if (streets.has(words) || streets.size >= 2) continue;
    streets.add(words);
    if (x.pr.dist >= PIN_FIX_MIN_M && reach(x.pr.point)) out.push({ point: x.pr.point, d: x.pr.dist, words: `onto ${words}` });
  }
  // Where two named streets cross, nearest the pin.
  const named = near.filter((x) => streetName(x.w) !== null).slice(0, 12);
  let best: PinOption | null = null;
  for (let i = 0; i < named.length; i++) {
    for (let j = i + 1; j < named.length; j++) {
      const a = named[i]!, b = named[j]!;
      if (streetName(a.w) === streetName(b.w)) continue;
      for (const c of polyCrossings(a.poly, b.poly)) {
        const d = dist(c.point, pin);
        if (d < PIN_FIX_MIN_M || !reach(c.point) || (best && d >= best.d)) continue;
        const [n1, n2] = [streetName(a.w)!, streetName(b.w)!].sort(cmp);
        best = { point: c.point, d, words: `to where ${n1} meets ${n2}` };
      }
    }
  }
  if (best && !out.some((o) => dist(o.point, best.point) < PIN_FIX_MIN_M)) out.push(best);
  out.sort((a, b) => a.d - b.d || cmp(a.words, b.words));
  const res = out.slice(0, 3);
  if (table.size > 64) table.clear();
  table.set(key, res);
  return res;
}

// ---------------------------------------------------------------- candidates

const zoneChange = (v: SceneVehicle, z: Zone): FixChange => ({ vehicleId: v.id, field: "zone", from: zoneWords(v.zone), to: zoneWords(z), patch: { zone: z } });
/** Adjacent zones before opposite ones: 0 (same) to 1 (opposite). */
const zoneStep = (a: Zone, b: Zone): number => angleBetween(ZONE_ANGLE_RAD[a], ZONE_ANGLE_RAD[b]) / Math.PI;

/** Speeds a "not sure" vehicle may be set to: inside its range (the limit ± RANGE_HALF_MPH), on the scan's grid. */
function speedOptions(v: SceneVehicle): Array<{ mph: number; off: number }> {
  const c = speedCases(v);
  if (!c.unsure || c.limitMph === null) return [];
  const out: Array<{ mph: number; off: number }> = [];
  for (const off of [-RANGE_HALF_MPH / 2, RANGE_HALF_MPH / 2, -RANGE_HALF_MPH, RANGE_HALF_MPH, 0]) {
    const mph = Math.round((c.limitMph + off) / RANGE_STEP_MPH) * RANGE_STEP_MPH;
    if (mph > 0 && !out.some((o) => o.mph === mph)) out.push({ mph, off });
  }
  return out;
}

/** The single changes worth trying on this scene, given why it is refused. */
function singles(scene: Scene, world: PinWorld, errors: readonly PlainMessage[]): Candidate[] {
  const named = new Set(errors.flatMap((e) => e.vehicleIds));
  const codes = new Set(errors.map((e) => e.code));
  const out: Candidate[] = [];
  const unsure = scene.vehicles.filter((v) => speedCases(v).unsure);
  scene.vehicles.forEach((v, order) => {
    // Vehicles the refusal names come first; then scene order.
    const who = (named.has(v.id) ? 0 : 0.5) + order * 0.01;
    for (const z of ZONES) if (z !== v.zone) out.push({ cost: 1 + who + 0.2 * zoneStep(z, v.zone), changes: [zoneChange(v, z)] });
    const current = directionWords(v, { bearingDeg: v.travel.bearingDeg, roadId: v.travel.roadId, roadName: v.travel.roadName }, true);
    // A backing or parked vehicle's direction is the way it faces: a backing vehicle facing against the traffic travels with it.
    const options = v.action === "backing" || v.action === "parked" ? [...world.dirs, ...world.dirs.map((o) => ({ ...o, bearingDeg: (o.bearingDeg + 180) % 360 }))] : world.dirs;
    const seen = new Set<string>();
    for (const o of options) {
      const key = `${o.roadId ?? o.roadName ?? ""}@${boundWord(o.bearingDeg)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const road = sameRoad(v.travel, o);
      if (road && angleDeg(o.bearingDeg, v.travel.bearingDeg) <= 25) continue;
      out.push({
        // Same road before a different road; a smaller turn before a bigger one.
        cost: 1.25 + who + (road ? 0 : 0.1) + 0.1 * (angleDeg(o.bearingDeg, v.travel.bearingDeg) / 180),
        changes: [{ vehicleId: v.id, field: "direction", from: current, to: directionWords(v, o, !road), patch: { travel: { ...v.travel, bearingDeg: o.bearingDeg, roadId: o.roadId, roadName: o.roadName, lane: null } } }],
      });
    }
    ACTIONS.filter((a) => a !== v.action).forEach((a, i) => {
      // A parked vehicle starting to move moves at the speed stored with it, which the claimant never saw: the label says it.
      const to = v.action === "parked" && a !== "parked" ? `${ACTION_LABELS[a]} ${speedWords(v)}` : ACTION_LABELS[a];
      out.push({ cost: 1.5 + who + 0.01 * i, changes: [{ vehicleId: v.id, field: "action", from: ACTION_LABELS[v.action], to, patch: { action: a } }] });
    });
    if (codes.has("no-such-lane") && v.travel.lane != null && named.has(v.id)) {
      out.push({ cost: 1, changes: [{ vehicleId: v.id, field: "lane", from: `lane ${v.travel.lane + 1}`, to: "the usual lane", patch: { travel: { ...v.travel, lane: null } } }] });
    }
    // A speed inside the "not sure" range the claimant gave. The scan already moves every "not sure" speed together, so a
    // single one only helps when several are "not sure" (each its own speed), or when the crash plays out too long.
    if (v.action !== "parked" && speedCases(v).unsure && (unsure.length >= 2 || codes.has("too-long"))) {
      const c = speedCases(v);
      const range = `${formatMphNumber(c.lo)} to ${formatSpeedExact(c.hi)}`;
      for (const s of speedOptions(v)) {
        out.push({
          cost: 1.6 + who + 0.01 * Math.abs(s.off),
          changes: [{ vehicleId: v.id, field: "speed", from: `not sure (${range})`, to: `${formatSpeedExact(s.mph * MPH_TO_MPS)}, inside its "not sure" range of ${range}`, patch: { speed: { kind: "known", mph: s.mph } } }],
        });
      }
    }
  });
  // The pin onto the nearest road (or where two streets meet).
  if (world.net) {
    for (const p of pinOptions(world.net, world.pin)) {
      const ll = toLatLon(world.net.frame, p.point);
      const location = { lat: Math.round(ll.lat * 1e7) / 1e7, lon: Math.round(ll.lon * 1e7) / 1e7 };
      const move: FixChange = { vehicleId: null, field: "pin", from: "where it is", to: `about ${formatDistance(p.d, { both: false }).text} ${p.words}`, patch: {}, location };
      const cost = 1.8 + Math.min(0.19, p.d / 1000);
      out.push({ cost, changes: [move] });
      // With the pin on the road, each vehicle's direction lined up with the nearest one step 2 would offer there.
      const there = directionOptions(world.net, toLocal(world.net.frame, location));
      const lineUp: FixChange[] = [];
      for (const v of scene.vehicles) {
        const facing = v.action === "backing" || v.action === "parked" ? [...there, ...there.map((o) => ({ ...o, bearingDeg: (o.bearingDeg + 180) % 360 }))] : there;
        const best = [...facing].sort((a, b) => angleDeg(a.bearingDeg, v.travel.bearingDeg) - angleDeg(b.bearingDeg, v.travel.bearingDeg) || cmp(a.roadId ?? "", b.roadId ?? ""))[0];
        if (!best || angleDeg(best.bearingDeg, v.travel.bearingDeg) > 60 || (best.roadId === v.travel.roadId && angleDeg(best.bearingDeg, v.travel.bearingDeg) <= 1)) continue;
        const current = directionWords(v, { bearingDeg: v.travel.bearingDeg, roadId: v.travel.roadId, roadName: v.travel.roadName }, true);
        lineUp.push({ vehicleId: v.id, field: "direction", from: current, to: directionWords(v, best, true), patch: { travel: { ...v.travel, bearingDeg: best.bearingDeg, roadId: best.roadId, roadName: best.roadName, lane: null } } });
      }
      if (lineUp.length) out.push({ cost: cost + 0.3 * lineUp.length, changes: [move, ...lineUp] });
    }
  }
  return out;
}

/** Two hit sides exchanged (who hit whom), then two hit sides changed together: for the vehicles the refusal names first. */
function pairs(scene: Scene, errors: readonly PlainMessage[]): Candidate[] {
  const named = new Set(errors.flatMap((e) => e.vehicleIds));
  const vs = scene.vehicles;
  const out: Candidate[] = [];
  const pairList: Array<[SceneVehicle, SceneVehicle, number]> = [];
  for (let i = 0; i < vs.length; i++) {
    for (let j = i + 1; j < vs.length; j++) {
      const k = (named.has(vs[i]!.id) ? 0 : 1) + (named.has(vs[j]!.id) ? 0 : 1);
      if (k < 2 || (named.size === 0 && i === 0 && j === 1)) pairList.push([vs[i]!, vs[j]!, k * 0.1 + (i + j) * 0.01]);
    }
  }
  if (pairList.length === 0 && vs.length >= 2) pairList.push([vs[0]!, vs[1]!, 0.2]);
  for (const [p, q, who] of pairList) {
    if (p.zone !== q.zone) out.push({ cost: 1.9 + who, swap: true, changes: [zoneChange(p, q.zone), zoneChange(q, p.zone)] });
    for (const a of ZONES) {
      if (a === p.zone) continue;
      for (const b of ZONES) if (b !== q.zone) out.push({ cost: 2 + who + 0.2 * (zoneStep(a, p.zone) + zoneStep(b, q.zone)), changes: [zoneChange(p, a), zoneChange(q, b)] });
    }
  }
  return out;
}

/**
 * Three or four vehicles: the paths of two vehicles changed together (direction or action each; with the hit sides that fit
 * added during the search). Each vehicle's five cheapest path changes, for the pairs the refusal names first.
 */
function pathPairs(scene: Scene, world: PinWorld, errors: readonly PlainMessage[]): Candidate[] {
  if (scene.vehicles.length < 3) return [];
  const named = new Set(errors.flatMap((e) => e.vehicleIds));
  const one = singles(scene, world, errors)
    .filter((c) => c.changes.length === 1 && (c.changes[0]!.field === "direction" || c.changes[0]!.field === "action"))
    .sort((x, y) => x.cost - y.cost || cmp(idOf(x.changes), idOf(y.changes)));
  const per = new Map<VehicleId, Candidate[]>();
  for (const c of one) {
    const id = c.changes[0]!.vehicleId!;
    const list = per.get(id) ?? [];
    if (list.length < 5) list.push(c);
    per.set(id, list);
  }
  const vs = scene.vehicles;
  const out: Candidate[] = [];
  for (let i = 0; i < vs.length; i++) {
    for (let j = i + 1; j < vs.length; j++) {
      if (!named.has(vs[i]!.id) && !named.has(vs[j]!.id)) continue;
      for (const a of per.get(vs[i]!.id) ?? []) for (const b of per.get(vs[j]!.id) ?? []) out.push({ cost: a.cost + b.cost, changes: [...a.changes, ...b.changes] });
    }
  }
  return out;
}

const valueId = (c: FixChange): string => {
  switch (c.field) {
    case "zone": return String(c.patch.zone);
    case "action": return String(c.patch.action);
    case "lane": return "auto";
    case "speed": return c.patch.speed?.kind === "known" ? String(c.patch.speed.mph) : "unsure";
    case "pin": return `${c.location?.lat},${c.location?.lon}`;
    default: return `${c.patch.travel?.roadId ?? "none"}@${Math.round(c.patch.travel?.bearingDeg ?? 0)}`;
  }
};
const idOf = (changes: readonly FixChange[]): string => changes.map((c) => `${c.vehicleId ?? "pin"}.${c.field}=${valueId(c)}`).join("+");

const FIELD_WORDS: Readonly<Record<FixField, string>> = { zone: "hit side", direction: "direction", action: "action", lane: "lane", speed: "speed", pin: "pin" };
/** "a", "a and b", "a, b and c". */
const listOf = (xs: readonly string[]): string => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

function labelOf(c: Candidate): string {
  if (c.swap) {
    const [a, b] = c.changes as [FixChange, FixChange];
    return `Swap who hit whom: ${a.vehicleId}'s hit side to ${a.to} and ${b.vehicleId}'s hit side to ${b.to}`;
  }
  const pin = c.changes.find((x) => x.field === "pin");
  const parts = c.changes.filter((x) => x.field !== "pin").map((x) => `${x.vehicleId}'s ${FIELD_WORDS[x.field]} to ${x.to}`);
  if (!pin) return `Change ${listOf(parts)}`;
  const move = `Move the pin ${pin.to}`;
  return parts.length ? `${move} and change ${listOf(parts)}` : move;
}

function kindOf(c: Candidate, scene: Scene): string {
  if (c.swap) return "swap";
  const role = (id: VehicleId | null): string => {
    const v = scene.vehicles.find((x) => x.id === id);
    return v && FRONT_ZONES.has(v.zone) ? "striking" : "struck";
  };
  return [...new Set(c.changes.map((x) => (x.field === "pin" ? "pin" : `${x.field}:${role(x.vehicleId)}`)))].sort(cmp).join("+");
}

function apply(scene: Scene, changes: readonly FixChange[]): Scene {
  const pin = changes.find((c) => c.field === "pin")?.location;
  const loc = scene.location;
  return {
    ...scene,
    // Moving the pin works like dragging it: the place searched for becomes the place it was moved from.
    location: pin ? { ...loc, lat: pin.lat, lon: pin.lon, nearLabel: loc.label ? loc.label : loc.nearLabel, label: "", source: "pin" } : loc,
    vehicles: scene.vehicles.map((v) => changes.filter((c) => c.vehicleId === v.id).reduce<SceneVehicle>((acc, c) => ({ ...acc, ...c.patch }), v)),
  };
}

/** Changes of one field replace earlier changes of the same field on the same vehicle (lane and direction count as one); the order is kept. */
function merge(a: readonly FixChange[], b: readonly FixChange[]): FixChange[] {
  const out = [...a];
  for (const c of b) {
    const i = out.findIndex((x) => x.vehicleId === c.vehicleId && (x.field === c.field || (x.field === "lane" && c.field === "direction") || (x.field === "direction" && c.field === "lane")));
    if (i >= 0) out[i] = { ...c, from: out[i]!.from }; else out.push(c);
  }
  return out;
}

const isMessage = (x: unknown): x is PlainMessage => typeof x === "object" && x !== null && "code" in x && "text" in x;

/**
 * For each vehicle with a refusal about its own path, its cheapest changes (lane, direction, action) that give it a usable path,
 * combined across those vehicles: the smallest repairs first, at most four combinations.
 */
function localRepairs(scene: Scene, world: PinWorld, errors: readonly PlainMessage[]): Candidate[] {
  const ids = [...new Set(errors.filter((e) => LOCAL.has(e.code)).flatMap((e) => e.vehicleIds))];
  if (ids.length === 0) return [];
  const all = singles(scene, world, errors).sort((x, y) => x.cost - y.cost || cmp(idOf(x.changes), idOf(y.changes)));
  const per = ids.map((id) => all
    .filter((c) => c.changes.length === 1 && c.changes[0]!.vehicleId === id && c.changes[0]!.field !== "zone" && c.changes[0]!.field !== "speed")
    .filter((c) => { const v = apply(scene, c.changes).vehicles.find((x) => x.id === id)!; return !isMessage(buildGuide(v, world.net, world.pin)); })
    .slice(0, 2));
  if (per.some((p) => p.length === 0)) return [];
  let combos: Candidate[] = [{ cost: 0, changes: [] }];
  for (const options of per) combos = combos.flatMap((c) => options.map((o) => ({ cost: c.cost + o.cost, changes: [...c.changes, ...o.changes] })));
  return combos.sort((x, y) => x.cost - y.cost || cmp(idOf(x.changes), idOf(y.changes))).slice(0, 4);
}

/** At most this many starting points (the scene as entered, then path repairs) for the search. */
const MAX_BASES = 9;
/** The search stops once it has this many fixes that draw (the pool the device's preferences reorder). */
const POOL = 6;

interface Queued { readonly c: Candidate; readonly size: number; readonly id: string; readonly fit: boolean }
const byQueue = (x: Queued, y: Queued): number => x.size - y.size || x.c.cost - y.c.cost || cmp(x.id, y.id);

/** Refusals where other hit sides may be what is needed: the sides can't touch, or touch in a way that doesn't close. */
const FIT_CODES = new Set(["zones-cannot-touch", "bodies-overlap", "moving-apart", "not-moving-toward", "too-slow", "no-workable-speed"]);

/**
 * Why the scene can't be drawn and up to MAX_FIXES small changes that do draw, smallest first. Deterministic for the same
 * scene, roads and preferences. A change is kept only when simulate() draws it as entered: a picture that would still swap
 * a hit side (a "zone-used" warning) is not kept, since the button would not say what the picture shows.
 */
export function suggestFixes(scene: Scene, roads: RoadNetwork | null, opts: FixOptions = {}): FixSuggestions {
  const first = simulate(scene, roads);
  if (first.ok) return { why: "", fixes: [], focus: { step: "vehicles", vehicleId: null, field: null }, trials: 1 };
  const errors = first.errors;
  const why = whySentence(errors);
  const focus = focusFor(errors, scene);
  if (errors.some((e) => e.code in HAND_ONLY)) return { why, fixes: [], focus, trials: 1 };
  // A crash too long to play out can only be shortened by a slower "not sure" speed; a typed speed is never changed.
  if (errors.some((e) => e.code === "too-long") && !scene.vehicles.some((v) => v.action !== "parked" && speedCases(v).unsure)) return { why, fixes: [], focus, trials: 1 };
  const limits = { ...FIX_LIMITS, ...opts.limits };
  const net = roads ? cleanNet(roads) : null;
  const pinOf = (s: Scene): Vec2 => (net ? toLocal(net.frame, { lat: s.location.lat, lon: s.location.lon }) : { x: 0, y: 0 });
  const world: PinWorld = { net, pin: pinOf(scene), dirs: directionOptions(net, pinOf(scene)) };
  const worldFor = (s: Scene, changes: readonly FixChange[]): PinWorld => (changes.some((c) => c.field === "pin") ? { net, pin: pinOf(s), dirs: directionOptions(net, pinOf(s)) } : world);
  const meter: WorkMeter = { units: 0 };
  let checks = 0;
  const spent = (): boolean => checks >= limits.checks || meter.units >= limits.units;

  // Each change is judged once: does it draw exactly as entered, and if not, why not.
  const verdicts = new Map<string, readonly PlainMessage[]>();
  const judge = (changes: readonly FixChange[]): readonly PlainMessage[] => {
    const id = idOf(changes);
    const hit = verdicts.get(id);
    if (hit) return hit;
    checks++;
    const d = drawsAsEntered(apply(scene, changes), roads, meter);
    const errs = d.ok ? [] : d.errors;
    verdicts.set(id, errs);
    return errs;
  };

  /**
   * The hit sides that would fit this change: each vehicle whose marked side no other vehicle could reach there takes the
   * reachable side nearest to the one marked, or the one met most squarely. No placing, so it costs next to nothing.
   */
  // Which hit sides each vehicle could be reached on depends on the paths and speeds, never on the hit sides: worked out once
  // per set of other changes.
  const facingMemo = new Map<string, Array<readonly FacingZone[]> | null>();
  const facingFor = (changes: readonly FixChange[]): Array<readonly FacingZone[]> | null => {
    const key = idOf(changes.filter((c) => c.field !== "zone"));
    if (facingMemo.has(key)) return facingMemo.get(key)!;
    meter.units += FACING_UNITS * scene.vehicles.length;
    const patched = apply(scene, changes);
    const facing = zonesFacing(patched, net, pinOf(patched));
    facingMemo.set(key, facing);
    return facing;
  };
  /**
   * Three or four vehicles: could every vehicle touch another with these hit sides? Each one's side has to be reachable by
   * some vehicle, or it has to be able to reach some other vehicle's side. A change that fails this can't place (the
   * placement would leave a vehicle touching nothing), so it is skipped without a check.
   */
  const couldTouch = (changes: readonly FixChange[]): boolean => {
    if (scene.vehicles.length < 3) return true;
    const facing = facingFor(changes);
    if (!facing) return true;
    const vs = apply(scene, changes).vehicles;
    return vs.every((v, i) => facing[i]!.some((z) => z.zone === v.zone)
      || vs.some((w, j) => j !== i && facing[j]!.some((z) => z.zone === w.zone && z.from.includes(v.id))));
  };

  const fits = (changes: readonly FixChange[]): FixChange[][] => {
    const patched = apply(scene, changes);
    const facing = facingFor(changes);
    if (!facing) return [];
    const out: FixChange[][] = [];
    for (const pick of ["nearest", "squarest"] as const) {
      const extra: FixChange[] = [];
      patched.vehicles.forEach((v, i) => {
        const zs = facing[i]!;
        if (zs.length === 0 || zs.some((z) => z.zone === v.zone)) return;
        const z = pick === "squarest" ? zs[0]!.zone : [...zs].sort((a, b) => zoneStep(a.zone, v.zone) - zoneStep(b.zone, v.zone) || a.off - b.off)[0]!.zone;
        extra.push(zoneChange(v, z));
      });
      if (extra.length && !out.some((o) => idOf(o) === idOf(extra))) out.push(extra);
    }
    return out;
  };
  const zoneCost = (extra: readonly FixChange[]): number => extra.reduce((sum, x) => sum + 1 + 0.2 * zoneStep(x.patch.zone!, scene.vehicles.find((v) => v.id === x.vehicleId)!.zone), 0);

  // ---- starting points: the scene as entered, then repairs of a vehicle's own path (the wrong way, a lane the road
  // doesn't have), in rounds, since a repair can uncover another vehicle's path problem.
  interface Base { readonly c: Candidate; readonly errors: readonly PlainMessage[] }
  const bases: Base[] = [];
  const baseQueue: Candidate[] = [{ cost: 0, changes: [] }];
  for (let b = 0; b < baseQueue.length && b < MAX_BASES && !spent(); b++) {
    const base = baseQueue[b]!;
    const errs = judge(base.changes);
    bases.push({ c: base, errors: errs });
    if (errs.some((e) => LOCAL.has(e.code))) {
      const baseScene = apply(scene, base.changes);
      for (const r of localRepairs(baseScene, worldFor(baseScene, base.changes), errs)) {
        if (baseQueue.length < MAX_BASES) baseQueue.push({ cost: base.cost + r.cost, changes: merge(base.changes, r.changes) });
      }
    }
  }

  // ---- every candidate on every starting point, smallest first
  const queue: Queued[] = [];
  const seen = new Set<string>();
  const enqueue = (c: Candidate, fit: boolean): Queued | null => {
    const id = idOf(c.changes);
    if (seen.has(id) || c.changes.length === 0) return null;
    seen.add(id);
    const q: Queued = { c, size: c.changes.length, id, fit };
    queue.push(q);
    return q;
  };
  for (const { c: base, errors: errs } of bases) {
    if (base.changes.length && errs.length === 0) enqueue(base, false);
    if (errs.length === 0 || errs.some((e) => e.code in HAND_ONLY || LOCAL.has(e.code))) continue;
    const baseScene = apply(scene, base.changes);
    // With no road near the pin, only moving the pin can help.
    const noRoad = errs.some((e) => e.code === "no-road");
    for (const c of singles(baseScene, worldFor(baseScene, base.changes), errs)) {
      const field = c.changes[0]!.field;
      if (noRoad && field !== "pin") continue;
      enqueue({ cost: base.cost + c.cost, changes: merge(base.changes, c.changes) }, field !== "zone" && field !== "speed");
    }
    if (noRoad) continue;
    for (const c of pairs(baseScene, errs)) enqueue({ ...c, cost: base.cost + c.cost, changes: merge(base.changes, c.changes), swap: c.swap && base.changes.length === 0 }, false);
    for (const c of pathPairs(baseScene, worldFor(baseScene, base.changes), errs)) enqueue({ cost: base.cost + c.cost, changes: merge(base.changes, c.changes) }, true);
    // The hit sides that would fit, everything else as entered.
    if (errs.some((e) => FIT_CODES.has(e.code))) {
      for (const extra of fits(base.changes)) enqueue({ cost: base.cost + zoneCost(extra), changes: merge(base.changes, extra) }, false);
    }
  }
  queue.sort(byQueue);

  // ---- the search: judge each candidate in order until enough fixes draw or the work runs out
  const found: Array<{ c: Candidate; size: number; id: string }> = [];
  for (let i = 0; i < queue.length; i++) {
    if (spent() || found.length >= POOL) break;
    const q = queue[i]!;
    // Three fixes found and the rest are all bigger: nothing left can come before them.
    if (found.length >= MAX_FIXES && q.size > found[MAX_FIXES - 1]!.size) break;
    const touches = couldTouch(q.c.changes);
    const errs = touches ? judge(q.c.changes) : null;
    if (errs && errs.length === 0) { found.push({ c: q.c, size: q.size, id: q.id }); continue; }
    // A direction, action, lane or pin that only works with other hit sides is tried with them.
    if (q.fit && (!errs || errs.some((e) => FIT_CODES.has(e.code)))) {
      for (const extra of fits(q.c.changes)) {
        const changes = merge(q.c.changes, extra);
        const id = idOf(changes);
        if (seen.has(id)) continue;
        seen.add(id);
        const item: Queued = { c: { cost: q.c.cost + zoneCost(extra), changes }, size: changes.length, id, fit: false };
        // Insert in order among the candidates still to come.
        let at = i + 1;
        while (at < queue.length && byQueue(queue[at]!, item) <= 0) at++;
        queue.splice(at, 0, item);
      }
    }
  }

  // ---- the fixes offered. Each one was judged by drawsAsEntered(), which gives simulate()'s own answer (it draws, with no hit
  // side swapped in); the Review step's full simulate() then draws it. Notes from the plain checks rank a fix lower among fixes
  // of its size; this device's preferred kinds come before the rest of the same size.
  const prefer = opts.prefer ?? {};
  const score = (kind: string): number => { const s = prefer[kind]; return typeof s === "number" && Number.isFinite(s) ? s : 0; };
  const fixes: Fix[] = found.map((f) => {
    const patched = apply(scene, f.c.changes);
    return { id: f.id, label: labelOf(f.c), changes: f.c.changes, size: f.size, cost: f.c.cost, kind: kindOf(f.c, scene), notes: checkScene(patched, roads).length > 0, scene: patched };
  });
  fixes.sort((x, y) => x.size - y.size || Number(x.notes) - Number(y.notes) || score(y.kind) - score(x.kind) || x.cost - y.cost || cmp(x.id, y.id));
  return { why, fixes: fixes.slice(0, MAX_FIXES), focus, trials: checks };
}
