// The words and numbers every export prints, made once from the scene and the
// simulation result. Every distance, speed and weight goes through the core
// formatter; nothing here holds a measurement of its own.
import {
  DEFAULT_LIMIT_MPH, MPH_TO_MPS, PLACE_WORDS, PRESETS, RANGE_HALF_MPH, ROAD_WORDS, ZONE_WORDS,
  directionCaption, formatDistance, formatMassLb, formatOccurred, formatSpeed, formatStamp, paintLabel, paintOf, vehicleName,
} from "@csd/core";
import type { ExportStamp, Scene, SceneVehicle, SimulationResult, VehicleResult } from "@csd/core";
import { about } from "./about";

/** Moves shorter than this don't get a drawn line or a numbered marker (m, drawing rule). */
export const MIN_DRAWN_MOVE_M = 0.05;

export interface VehicleRow {
  readonly id: string;
  readonly name: string;
  readonly typeWeight: string;
  readonly direction: string;
  /** The speed used: what the claimant entered, or the range for "not sure". */
  readonly speed: string;
  /** When the vehicle was braking: the speed it slowed from, at the start of the window. */
  readonly brakingNote: string | null;
  readonly speedNote: string | null;
  /** The side hit, in full: "Front", or "Front as entered; the picture uses another side (see Details that may not fit together)". */
  readonly hitOn: string;
  /** The picked paint (its printable name and hex), or null for Not sure. Fills the body in the pictures and gets a swatch in the PDF table. */
  readonly paint: { readonly label: string; readonly hex: string } | null;
  /** The short form for a table cell: the side, with HIT_ON_MARK when the picture uses another side (hitOn then goes under the table). */
  readonly hitOnShort: string;
  /** The picture uses another side than the one entered. */
  readonly hitOnAdjusted: boolean;
}

/** Marks a table cell whose full wording is a note under the table. */
export const HIT_ON_MARK = "*";

export interface MeasureRow {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  /** Marker number drawn on the diagram, or null when the row has no marker. */
  readonly marker: number | null;
}

export interface ReportModel {
  readonly claimNumber: string;
  readonly place: string;
  readonly coordinates: string;
  readonly occurred: string;
  readonly road: string;
  readonly vehicles: readonly VehicleRow[];
  readonly measurements: readonly MeasureRow[];
  readonly assumptions: readonly string[];
  readonly warnings: readonly string[];
  readonly stampLocal: string;
  readonly stampUtc: string;
  readonly fingerprintShort: string;
  readonly fingerprintFull: string;
  /** "Not sure" speeds in plain words, for the picture's title card. */
  readonly unsureNotes: readonly string[];
  /** Where the picture had to use a different hit side than entered (the physics' zone-used notes), for every picture. */
  readonly adjustedNotes: readonly string[];
  /** Braking vehicles in plain words, for the picture's title card. */
  readonly brakingNotes: readonly string[];
  readonly anyRange: boolean;
}

/** Bidirectional-text controls (and other invisible controls) that could reorder or hide printed text. */
const BIDI_AND_CONTROLS = /[‪-‮⁦-⁩‎‏؜\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
/** Zero-width characters (space, non-joiner, joiner, word joiner, byte order mark): invisible, so they are left out rather than printed as "?". */
const ZERO_WIDTH = /[​-‍⁠﻿]/g;
/** Symbols the brand font's Latin set lacks, written as words so they never print as "?". */
const SYMBOL_WORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\s*\u2248\s*/g, " about "], [/\s*\u2264\s*/g, " at most "], [/\s*\u2265\s*/g, " at least "], [/\s*\u2192\s*/g, " to "], [/\s*\u2260\s*/g, " is not "],
];
/** Printable text from a user string: no bidi or control characters, and words for symbols the font lacks. */
export const printable = (s: string): string => SYMBOL_WORDS.reduce((t, [re, w]) => t.replace(re, w), s.replace(BIDI_AND_CONTROLS, "").replace(ZERO_WIDTH, "")).replace(/\s+/g, " ").trim();

/** A copy of the scene with every user string made printable. Only used for what we print; the scene file keeps the original. */
export function printableScene(scene: Scene): Scene {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return printable(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(scene) as Scene;
}

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const shortPlace = (t: string, parts: number) => t.split(",").slice(0, parts).join(",").trim();

/** Place line: the searched place, or the pin with the place it was moved from. */
export function placeLine(loc: Scene["location"], parts = 3): string {
  if (loc.label.trim()) return shortPlace(loc.label, parts);
  if (loc.nearLabel.trim()) return `Pin placed by the claimant, near ${shortPlace(loc.nearLabel, 1)}`;
  return "Pin placed by the claimant";
}

export function vehicleResult(sim: SimulationResult, id: string): VehicleResult {
  const rv = sim.vehicles.find((v) => v.id === id);
  if (!rv) throw new Error(`The simulation result has no vehicle ${id}.`);
  return rv;
}

/**
 * What the claimant entered about a vehicle's speed, in mph, with the same
 * rules the physics uses (DESIGN.md section 8): a known speed is used as is;
 * "not sure" runs at the limit given (or the default city limit) plus and minus a few mph.
 */
export function speedInputs(v: SceneVehicle): {
  source: "claimant" | "not-sure";
  postedLimitMph: number | null;
  postedLimitSource: "claimant" | "default-25" | null;
  rangeMph: { lo: number; mid: number; hi: number };
  usedMph: number;
} {
  if (v.speed.kind === "known") {
    const mph = v.speed.mph;
    return { source: "claimant", postedLimitMph: null, postedLimitSource: null, rangeMph: { lo: mph, mid: mph, hi: mph }, usedMph: mph };
  }
  const limit = v.speed.limitMph ?? DEFAULT_LIMIT_MPH;
  return {
    source: "not-sure",
    postedLimitMph: limit,
    postedLimitSource: v.speed.limitMph === null ? "default-25" : "claimant",
    rangeMph: { lo: limit - RANGE_HALF_MPH, mid: limit, hi: limit + RANGE_HALF_MPH },
    usedMph: limit,
  };
}

/** Allowance when comparing the speeds the physics drew with the ones entered (mph). */
const SPEED_TOLERANCE_MPH = 0.05;

/** Did the physics narrow a "not sure" range? True when the drawn low or high end differs from the entered limit plus or minus the range (the middle is not compared). */
export function rangeNarrowed(v: SceneVehicle, rv: VehicleResult): boolean {
  if (v.speed.kind !== "unsure") return false;
  const entered = speedInputs(v).rangeMph;
  const shown = rv.speedAtImpactMps;
  return Math.abs(shown.lo / MPH_TO_MPS - entered.lo) > SPEED_TOLERANCE_MPH || Math.abs(shown.hi / MPH_TO_MPS - entered.hi) > SPEED_TOLERANCE_MPH;
}

/** Float noise allowance for the distance threshold below. */
const EPS = 1e-6;

/**
 * The typed speed is the speed at impact. A braking vehicle slowed into the crash,
 * so the second line says what it slowed from: the first sample of its track.
 */
function brakingNote(v: SceneVehicle, rv: VehicleResult): string | null {
  const start = rv.track[0];
  if (!v.braking || v.action === "parked" || !start) return null;
  return `Braking: slowed from ${about(formatSpeed(start.speedMps).text)}`;
}

/** The "not sure" note: the limit wording comes from the scene, the picture speed and any narrowing from the physics result. */
function speedNote(v: SceneVehicle, rv: VehicleResult): string | null {
  if (v.action === "parked") return "Parked";
  if (v.speed.kind !== "unsure") return null;
  const used = about(formatSpeed(rv.speedAtImpactMps.mid).text);
  const base = v.speed.limitMph === null
    ? `Not sure. Around ${DEFAULT_LIMIT_MPH} mph, a typical city limit (limit not known). Picture uses ${used}.`
    : `Not sure. Around the ${v.speed.limitMph} mph limit the claimant gave. Picture uses ${used}.`;
  return rangeNarrowed(v, rv) ? `${base} Narrowed to the speeds where the crash works; see the notes below.` : base;
}

/** Keys of the measurements drawn as numbered markers, in marker order. */
export function markerKeys(sim: SimulationResult): string[] {
  const keys = sim.vehicles.filter((rv) => rv.postImpactDistanceM.hi >= MIN_DRAWN_MOVE_M).map((rv) => `moved-${rv.id}`);
  const gap = sim.gaps[0];
  if (gap) keys.push(`gap-${gap.a}-${gap.b}`);
  return keys;
}

/** "last N s" for the approach window (N is the window the physics ran, from startTimeS), or "under 1 s" when it rounds to nothing. */
export function approachPhrase(sim: SimulationResult): string {
  const s = Math.round(-sim.startTimeS);
  return s < 1 ? "under 1 s" : `last ${s} s`;
}

export function buildModel(rawScene: Scene, sim: SimulationResult, stamp: ExportStamp): ReportModel {
  const scene = printableScene(rawScene);
  const loc = scene.location;
  // A hit side the picture couldn't use as entered is said on every export, not only in the notes (red team, 2026-10-10).
  const zoneUsed = sim.warnings.filter((w) => w.code === "zone-used");
  const vehicles: VehicleRow[] = scene.vehicles.map((v) => {
    const rv = vehicleResult(sim, v.id);
    const side = cap(ZONE_WORDS[v.zone]);
    const adjusted = zoneUsed.some((w) => w.vehicleIds.includes(v.id));
    return {
      id: v.id,
      name: vehicleName(v) ?? (v.role === "claimant" ? "Claimant's vehicle" : "Other vehicle"),
      typeWeight: `${PRESETS[v.type].label}, ${about(formatMassLb(rv.massKg))}`,
      direction: directionCaption(v),
      speed: v.action === "parked" ? formatSpeed(0, { both: true }).text : about(formatSpeed(rv.speedAtImpactMps, { both: true }).text),
      brakingNote: brakingNote(v, rv),
      speedNote: speedNote(v, rv),
      paint: (() => { const p = paintOf(v); return p ? { label: printable(paintLabel(p)), hex: p.hex.toLowerCase() } : null; })(),
      // The warnings that explain it usually sit on page 2 now, so the note names their section.
      hitOn: adjusted ? `${side} as entered; the picture uses another side (see Details that may not fit together)` : side,
      hitOnShort: adjusted ? `${side} ${HIT_ON_MARK}` : side,
      hitOnAdjusted: adjusted,
    };
  });

  const markers = new Map(markerKeys(sim).map((k, i) => [k, i + 1]));
  const rows: MeasureRow[] = [];
  const add = (key: string, label: string, v: Parameters<typeof formatDistance>[0], value = about(formatDistance(v).text)) =>
    rows.push({ key, label, value, marker: markers.get(key) ?? null });
  for (const rv of sim.vehicles) {
    const stayed = rv.postImpactDistanceM.hi < MIN_DRAWN_MOVE_M - EPS;
    add(`moved-${rv.id}`, `${rv.id} moved after impact`, rv.postImpactDistanceM, stayed ? "didn't move" : undefined);
  }
  for (const g of sim.gaps) add(`gap-${g.a}-${g.b}`, `${g.a} to ${g.b} at final rest, center to center`, g.restGapM);
  for (const rv of sim.vehicles) {
    if (rv.approachDistanceM.hi >= MIN_DRAWN_MOVE_M) add(`approach-${rv.id}`, `${rv.id}, ${approachPhrase(sim)} before impact`, rv.approachDistanceM);
  }

  const unsureNotes = scene.vehicles
    .filter((v) => v.speed.kind === "unsure" && v.action !== "parked")
    // The range the physics drew (the same one the PDF's speed column shows).
    .map((v) => {
      const at = vehicleResult(sim, v.id).speedAtImpactMps;
      return `${v.id} speed at impact not known: ${about(formatSpeed(at).text)}. Picture uses ${about(formatSpeed(at.mid).text)}.`;
    });

  const brakingNotes = scene.vehicles.flatMap((v) => {
    const note = brakingNote(v, vehicleResult(sim, v.id));
    return note ? [`${v.id} ${note.charAt(0).toLowerCase()}${note.slice(1)}`] : [];
  });

  const anyRange = [...sim.vehicles.flatMap((v) => [v.postImpactDistanceM, v.approachDistanceM]), ...sim.gaps.map((g) => g.restGapM)]
    .some((r) => formatDistance(r).ranged);

  return {
    claimNumber: scene.claim.number.trim(),
    place: placeLine(loc),
    coordinates: `${loc.lat.toFixed(5)}, ${loc.lon.toFixed(5)}`,
    occurred: formatOccurred(scene.occurred.date, scene.occurred.time) || "Not given",
    road: `${PLACE_WORDS[loc.place]} · ${ROAD_WORDS[scene.road.condition]}`,
    vehicles,
    measurements: rows,
    assumptions: sim.assumptions.map((a) => printable(a.text)),
    warnings: sim.warnings.map((w) => printable(w.text)),
    // TODO(server export): formatStamp uses the runtime's time zone. A server-side export must be given the claimant's time zone.
    stampLocal: formatStamp(stamp.createdAt),
    stampUtc: stamp.createdAt,
    fingerprintShort: stamp.fingerprintShort,
    fingerprintFull: stamp.fingerprintHex,
    unsureNotes,
    adjustedNotes: zoneUsed.map((w) => w.text),
    brakingNotes,
    anyRange,
  };
}

/** Safe file-name piece from the claim number. */
export function fileClaim(claimNumber: string): string {
  const s = printable(claimNumber).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/\.{2,}/g, ".").replace(/^[-.]+|[-.]+$/g, "");
  // Cut to length, then trim again: the cut can leave a trailing "." or "-" (a name ending in "." would give "..json").
  return s.slice(0, 60).replace(/[-.]+$/, "") || "scene";
}

/** Each painted vehicle's hex by letter, for the diagram planner (vehicles left as Not sure are absent). */
export function paintByLetter(model: Pick<ReportModel, "vehicles">): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const v of model.vehicles) if (v.paint) out[v.id] = v.paint.hex;
  return out;
}
