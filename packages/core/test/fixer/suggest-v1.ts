// FROZEN COPY of packages/core/src/physics/suggest.ts at 8dde902 (the fixer before round A), kept only so the benchmark
// can measure "before" and "after" on the same machine in the same run. Not used by the app. Do not edit.
// When the picture can't be drawn, the closest details that would draw (DESIGN.md section 18).
//
// suggestFixes runs the physics on small changes to what was entered: one vehicle's hit side, its direction (the same
// road-relative choices step 2 offers, or N/E/S/W without roads) or what it was doing, then two hit sides together.
// Only changes the simulation actually draws are kept, cheapest first, never more than MAX_FIXES. Pure TS, no DOM.
// Refusals these fields can't cure (input the physics can't read, no road near the pin, a crash too long to play
// out) get no fixes; `focus` says which detail to edit by hand instead.
import type { RoadNetwork } from "../../src/contracts/roads";
import type { Action, Scene, SceneVehicle, VehicleId, Zone } from "../../src/contracts/scene";
import { ACTIONS, ZONES } from "../../src/contracts/scene";
import type { PlainMessage } from "../../src/contracts/simulation";
import type { Vec2 } from "../../src/contracts/geometry";
import { ZONE_WORDS, boundWord, formatSpeedExact } from "../../src/format";
import { MPH_TO_MPS } from "../../src/physics/constants";
import { angleBetween, toRad } from "../../src/physics/geo";
import { cleanNet, streetsAtPin } from "../../src/physics/lanes";
import { checkScene } from "../../src/physics/check";
import { ZONE_ANGLE_RAD } from "../../src/physics/model";
import { buildGuide, placeDetailed } from "../../src/physics/placement";
import { toLocal } from "../../src/physics/projection";
import { simulate } from "../../src/physics/simulate";

/** At most this many fixes are offered. */
export const MAX_FIXES = 3;
/** At most this many full trial simulations per call (two vehicles; three or four get fewer), so it stays quick in the browser. */
export const MAX_FIX_TRIALS = 30;

export type FixField = "zone" | "direction" | "action" | "lane";

export interface FixChange {
  readonly vehicleId: VehicleId;
  readonly field: FixField;
  /** Plain words for the value before and after ("Rear", "Front"). */
  readonly from: string;
  readonly to: string;
  /** The fields of the vehicle this change sets. */
  readonly patch: Partial<Pick<SceneVehicle, "zone" | "travel" | "action">>;
}

export interface Fix {
  /** Stable id from the changes, e.g. "A.zone=front". */
  readonly id: string;
  /** One plain sentence for the button: "Change A's hit side to Right side". */
  readonly label: string;
  readonly changes: readonly FixChange[];
  /** Smaller is a smaller change. Fixes come sorted by it. */
  readonly cost: number;
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
  /** How many trial simulations were run. */
  readonly trials: number;
}

/** Refusals no change of hit side, direction or action can cure: they are fixed by hand. */
const HAND_ONLY: Readonly<Record<string, FixFocus["field"]>> = {
  "too-few-vehicles": null, "too-many-vehicles": null, "bad-location": "location", "bad-pin": "location", "no-road": "location",
  "bad-road-condition": null, "bad-vehicle": null, "bad-direction": "direction", "bad-lane": "direction", "bad-speed": "speed",
  "cannot-work-out": null, "too-long": "speed",
};

/** Where to send the claimant for each refusal when editing by hand. */
const FOCUS_FIELD: Readonly<Record<string, FixFocus["field"]>> = {
  ...HAND_ONLY,
  "zones-cannot-touch": "zone", "bodies-overlap": "zone", "moving-apart": "direction", "not-moving-toward": "speed", "too-slow": "speed",
  "passes-through": "direction", "on-building": "direction", "wrong-way": "direction", "no-such-lane": "direction", "nothing-moving": "action",
  "no-workable-speed": "speed",
};

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

interface Candidate { readonly cost: number; readonly changes: readonly FixChange[] }

interface DirectionOption { readonly bearingDeg: number; readonly roadId: string | null; readonly roadName: string | null }

/** The direction choices step 2 offers: road-relative at the pin, else N/E/S/W. */
function directionOptions(scene: Scene, roads: RoadNetwork | null): DirectionOption[] {
  if (roads) {
    const pin = toLocal(roads.frame, { lat: scene.location.lat, lon: scene.location.lon });
    const choices = streetsAtPin(roads, pin).directions;
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

function candidates(scene: Scene, roads: RoadNetwork | null, errors: readonly PlainMessage[]): Candidate[] {
  const named = new Set(errors.flatMap((e) => e.vehicleIds));
  const codes = new Set(errors.map((e) => e.code));
  const dirs = directionOptions(scene, roads);
  const out: Candidate[] = [];
  const zoneChanges = (v: SceneVehicle): Array<{ cost: number; change: FixChange }> => ZONES.filter((z) => z !== v.zone).map((z) => ({
    // Adjacent zones before opposite ones.
    cost: angleBetween(ZONE_ANGLE_RAD[z], ZONE_ANGLE_RAD[v.zone]) / Math.PI,
    change: { vehicleId: v.id, field: "zone", from: zoneWords(v.zone), to: zoneWords(z), patch: { zone: z } },
  }));
  scene.vehicles.forEach((v, order) => {
    // Vehicles the refusal names come first; then scene order.
    const who = (named.has(v.id) ? 0 : 0.5) + order * 0.01;
    for (const z of zoneChanges(v)) out.push({ cost: 1 + who + 0.2 * z.cost, changes: [z.change] });
    const current = directionWords(v, { bearingDeg: v.travel.bearingDeg, roadId: v.travel.roadId, roadName: v.travel.roadName }, true);
    // A backing or parked vehicle's direction is the way it faces: a backing vehicle facing against the traffic travels with it.
    const options = v.action === "backing" || v.action === "parked" ? [...dirs, ...dirs.map((o) => ({ ...o, bearingDeg: (o.bearingDeg + 180) % 360 }))] : dirs;
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
  });
  // Two hit sides together (the vehicles the refusal names, else the first two).
  const pair = scene.vehicles.filter((v) => named.has(v.id)).slice(0, 2);
  const [p, q] = pair.length === 2 ? pair : scene.vehicles.slice(0, 2);
  if (p && q) {
    for (const a of zoneChanges(p)) for (const b of zoneChanges(q)) out.push({ cost: 2 + 0.2 * (a.cost + b.cost), changes: [a.change, b.change] });
  }
  // Stable: cost, then the change ids.
  return out.sort((x, y) => x.cost - y.cost || cmp(idOf(x.changes), idOf(y.changes)));
}

const valueId = (c: FixChange): string => (c.field === "zone" ? String(c.patch.zone) : c.field === "action" ? String(c.patch.action) : c.field === "lane" ? "auto" : `${c.patch.travel?.roadId ?? "none"}@${Math.round(c.patch.travel?.bearingDeg ?? 0)}`);
const idOf = (changes: readonly FixChange[]): string => changes.map((c) => `${c.vehicleId}.${c.field}=${valueId(c)}`).join("+");

const FIELD_WORDS: Readonly<Record<FixField, string>> = { zone: "hit side", direction: "direction", action: "action", lane: "lane" };
function labelOf(changes: readonly FixChange[]): string {
  const parts = changes.map((c) => `${c.vehicleId}'s ${FIELD_WORDS[c.field]} to ${c.to}`);
  return `Change ${parts.join(" and ")}`;
}

function apply(scene: Scene, changes: readonly FixChange[]): Scene {
  return { ...scene, vehicles: scene.vehicles.map((v) => changes.filter((c) => c.vehicleId === v.id).reduce<SceneVehicle>((acc, c) => ({ ...acc, ...c.patch }), v)) };
}

/** Refusals about one vehicle's own path on its road. */
const LOCAL = new Set(["wrong-way", "no-such-lane"]);
/**
 * Work limits, by the number of vehicles (a scene of three or four costs several times as much per trial), so the search stays
 * short on the main thread: full simulations, quick placement checks, and looser placements that may each try many zones to
 * find the hit side a change needs. Deterministic: counts, never a clock.
 */
const limitsFor = (scene: Scene, maxTrials?: number) => {
  const heavy = scene.vehicles.length >= 3;
  return { trials: maxTrials ?? (heavy ? 20 : 30), placements: heavy ? 40 : 100, probes: heavy ? 2 : 6 };
};
/** At most this many starting points (the scene as entered, then path repairs) for the search. */
const MAX_BASES = 9;

/** Changes of one field replace earlier changes of the same field on the same vehicle; the order is kept. */
function merge(a: readonly FixChange[], b: readonly FixChange[]): FixChange[] {
  const out = [...a];
  for (const c of b) {
    const i = out.findIndex((x) => x.vehicleId === c.vehicleId && (x.field === c.field || (x.field === "lane" && c.field === "direction") || (x.field === "direction" && c.field === "lane")));
    if (i >= 0) out[i] = { ...c, from: out[i]!.from }; else out.push(c);
  }
  return out;
}

/**
 * For each vehicle with a refusal about its own path, its cheapest changes (lane, direction, action) that give it a usable path,
 * combined across those vehicles: the smallest repairs first, at most four combinations.
 */
function localRepairs(scene: Scene, net: RoadNetwork | null, pin: Vec2, errors: readonly PlainMessage[]): Candidate[] {
  const ids = [...new Set(errors.filter((e) => LOCAL.has(e.code)).flatMap((e) => e.vehicleIds))];
  if (ids.length === 0) return [];
  const all = candidates(scene, net, errors);
  const per = ids.map((id) => all
    .filter((c) => c.changes.length === 1 && c.changes[0]!.vehicleId === id && c.changes[0]!.field !== "zone")
    .filter((c) => { const v = apply(scene, c.changes).vehicles.find((x) => x.id === id)!; return !isMessage(buildGuide(v, net, pin)); })
    .slice(0, 2));
  if (per.some((p) => p.length === 0)) return [];
  let combos: Candidate[] = [{ cost: 0, changes: [] }];
  for (const options of per) combos = combos.flatMap((c) => options.map((o) => ({ cost: c.cost + o.cost, changes: [...c.changes, ...o.changes] })));
  return combos.sort((x, y) => x.cost - y.cost || cmp(idOf(x.changes), idOf(y.changes))).slice(0, 4);
}
const isMessage = (x: unknown): x is PlainMessage => typeof x === "object" && x !== null && "code" in x && "text" in x;

/**
 * Why the scene can't be drawn and up to MAX_FIXES small changes that do draw, smallest first. Deterministic.
 * A change is kept only when simulate() draws it as entered: a picture that would still swap a hit side (a
 * "zone-used" warning) is not kept, since the button would not say what the picture shows.
 */
export function suggestFixes(scene: Scene, roads: RoadNetwork | null, opts: { readonly maxTrials?: number } = {}): FixSuggestions {
  const first = simulate(scene, roads);
  if (first.ok) return { why: "", fixes: [], focus: { step: "vehicles", vehicleId: null, field: null }, trials: 1 };
  const errors = first.errors;
  const why = whySentence(errors);
  const focus = focusFor(errors, scene);
  if (errors.some((e) => e.code in HAND_ONLY)) return { why, fixes: [], focus, trials: 1 };
  const limits = limitsFor(scene, opts.maxTrials);
  const net = roads ? cleanNet(roads) : null;
  const pin = net ? toLocal(net.frame, { lat: scene.location.lat, lon: scene.location.lon }) : { x: 0, y: 0 };
  // Fixes neither the plain checks nor the picture have any note about come first; the others after, each group cheapest first.
  const clean: Fix[] = [], noted: Fix[] = [];
  let trials = 1, placements = 0, probes = 0;
  const tried = new Set<string>();
  /** A change of direction or action often needs a hit side to go with it: the side the placement would use. */
  const deferred: Candidate[] = [];
  const open = (): boolean => clean.length < MAX_FIXES && trials < limits.trials + 1 && placements < limits.placements;
  /** Try one candidate; returns why it doesn't draw (the placement's or the simulation's errors), [] when it draws, or null when not tried. */
  const run = (c: Candidate, allowFollowUp: boolean): readonly PlainMessage[] | null => {
    const id = idOf(c.changes);
    if (tried.has(id) || !open()) return null;
    tried.add(id);
    const patched = apply(scene, c.changes);
    // Quick screen: the entered zones have to place and close as they are (no zone swapped in by the fallback).
    placements++;
    const exact = placeDetailed(patched, net, pin, { exactZones: true });
    if (!exact.ok) {
      if (allowFollowUp && probes < limits.probes) {
        probes++;
        const loose = placeDetailed(patched, net, pin);
        if (loose.ok && loose.value.zonesUsed.length > 0) {
          const extra: FixChange[] = loose.value.zonesUsed.map((u) => ({ vehicleId: u.id, field: "zone", from: zoneWords(u.entered), to: zoneWords(u.used), patch: { zone: u.used } }));
          deferred.push({ cost: c.cost + extra.length, changes: merge(c.changes, extra) });
        }
      }
      return exact.errors;
    }
    trials++;
    const r = simulate(patched, roads);
    if (!r.ok) return r.errors;
    if (r.result.warnings.some((w) => w.code === "zone-used")) return [];
    const fix: Fix = { id, label: labelOf(c.changes), changes: c.changes, cost: c.cost, scene: patched };
    (r.result.warnings.length === 0 && checkScene(patched, roads).length === 0 ? clean : noted).push(fix);
    return [];
  };
  // Errors that belong to one vehicle's road (the wrong way on a one-way street, a lane the road doesn't have) are repaired first,
  // with the smallest change that gives that vehicle a usable path; every other candidate is then tried on top of those repairs.
  // A repair can uncover another vehicle's path problem, so repairs are applied in rounds (at most MAX_BASES starting points).
  const bases: Candidate[] = [{ cost: 0, changes: [] }];
  for (let b = 0; b < bases.length && open(); b++) {
    const base = bases[b]!;
    const baseScene = apply(scene, base.changes);
    // The repaired scene is tried as a fix itself; its errors (if any) steer the next round.
    const baseErrors = base.changes.length === 0 ? errors : run(base, true);
    if (baseErrors === null || baseErrors.length === 0) continue;
    if (baseErrors.some((e) => LOCAL.has(e.code))) {
      for (const r of localRepairs(baseScene, net, pin, baseErrors)) {
        if (bases.length < MAX_BASES) bases.push({ cost: base.cost + r.cost, changes: merge(base.changes, r.changes) });
      }
      continue;
    }
    if (baseErrors.some((e) => e.code in HAND_ONLY)) continue;
    for (const c of candidates(baseScene, roads, baseErrors)) {
      if (!open()) break;
      run({ cost: base.cost + c.cost, changes: merge(base.changes, c.changes) }, c.changes.length === 1);
    }
  }
  deferred.sort((x, y) => x.cost - y.cost || cmp(idOf(x.changes), idOf(y.changes)));
  for (const c of deferred) { if (!open()) break; run(c, false); }
  const byCost = (x: Fix, y: Fix): number => x.cost - y.cost || cmp(x.id, y.id);
  const fixes = [...clean.sort(byCost), ...noted.sort(byCost)].slice(0, MAX_FIXES);
  return { why, fixes, focus, trials };
}
