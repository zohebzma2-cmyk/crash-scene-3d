// The one formatter: SI in, display text out. Rounding happens only here
// (DESIGN.md section 14). Everything returned is plain text.
import type { Range } from "./contracts/geometry";
import type { Action, SceneVehicle, Zone, RoadCondition, PlaceKind } from "./contracts/scene";
import { MPH_TO_MPS, M_TO_FT } from "./physics/constants";

export type Units = "us" | "metric";
const asRange = (v: Range | number): Range => (typeof v === "number" ? { lo: v, mid: v, hi: v } : v);
const r0 = (x: number) => Math.round(x);
const f1 = (x: number) => (Math.round(x * 10) / 10).toFixed(1);

/** Distance in meters → "16–22 ft / 4.9–6.7 m" (both) or one unit. */
export function formatDistance(m: Range | number, opts: { both?: boolean; units?: Units } = {}): { text: string; ranged: boolean } {
  const v = asRange(m);
  const ranged = r0(v.lo * M_TO_FT) !== r0(v.hi * M_TO_FT);
  const ft = ranged ? `${r0(v.lo * M_TO_FT)}–${r0(v.hi * M_TO_FT)} ft` : `${r0(v.mid * M_TO_FT)} ft`;
  const m1 = ranged ? `${f1(v.lo)}–${f1(v.hi)} m` : `${f1(v.mid)} m`;
  if (opts.both ?? true) return { text: `${ft} / ${m1}`, ranged };
  return { text: opts.units === "metric" ? m1 : ft, ranged };
}

/** Speed in m/s → "25 mph" / "20–30 mph · 32–48 km/h". */
export function formatSpeed(mps: Range | number, opts: { both?: boolean; units?: Units } = {}): { text: string; ranged: boolean } {
  const v = asRange(mps);
  const mph = (x: number) => r0(x / MPH_TO_MPS);
  const kmh = (x: number) => r0(x * 3.6);
  const ranged = mph(v.lo) !== mph(v.hi);
  const us = ranged ? `${mph(v.lo)}–${mph(v.hi)} mph` : `${mph(v.mid)} mph`;
  const si = ranged ? `${kmh(v.lo)}–${kmh(v.hi)} km/h` : `${kmh(v.mid)} km/h`;
  if (opts.both) return { text: `${us} · ${si}`, ranged };
  return { text: opts.units === "metric" ? si : us, ranged };
}

/** A speed in mph as a bare number, to 0.1 mph, whole numbers without a decimal: "22", "22.3". */
export function formatMphNumber(mps: number): string {
  const mph = Math.round((mps / MPH_TO_MPS) * 10) / 10;
  return Number.isInteger(mph) ? String(mph) : f1(mph);
}

/** A speed exactly as it was typed or scanned: whole mph as "22 mph", otherwise to 0.1 mph as "22.3 mph". Never rounded to a grid. */
export function formatSpeedExact(mps: number): string {
  return `${formatMphNumber(mps)} mph`;
}

/** Mass in kilograms with thousands separators: "1,610 kg". */
export function formatMassKg(kg: number): string {
  return `${Math.round(kg).toLocaleString("en-US")} kg`;
}

/** Acceleration in m/s² as "3.4 m/s² (11.2 ft/s²)", or metric only. */
export function formatAcceleration(mps2: number, opts: { both?: boolean } = {}): string {
  const si = `${f1(mps2)} m/s²`;
  return (opts.both ?? true) ? `${si} (${f1(mps2 * M_TO_FT)} ft/s²)` : si;
}

export function formatMassLb(kg: number): string {
  return `${(Math.round(kg / 0.45359237 / 10) * 10).toLocaleString("en-US")} lb`;
}

export const ACTION_WORDS: Readonly<Record<Action, string>> = { straight: "going straight", "turn-left": "turning left", "turn-right": "turning right", backing: "backing up", parked: "parked" };
export const ZONE_WORDS: Readonly<Record<Zone, string>> = { front: "front", "front-right": "front right", right: "right side", "rear-right": "rear right", rear: "rear", "rear-left": "rear left", left: "left side", "front-left": "front left" };
export const ROAD_WORDS: Readonly<Record<RoadCondition, string>> = { dry: "dry", wet: "wet", snow: "snowy", ice: "icy" };
export const PLACE_WORDS: Readonly<Record<PlaceKind, string>> = { intersection: "Intersection", road: "Road", parking: "Parking lot" };

/** Nearest of the four bounds for a compass bearing in degrees. */
export function boundWord(bearingDeg: number): "northbound" | "eastbound" | "southbound" | "westbound" {
  const b = ((bearingDeg % 360) + 360) % 360;
  if (b < 45 || b >= 315) return "northbound";
  if (b < 135) return "eastbound";
  if (b < 225) return "southbound";
  return "westbound";
}
const FACING: Record<string, string> = { northbound: "north", eastbound: "east", southbound: "south", westbound: "west" };

/** Keep street names as written ("Main Street"), only trimming; never lowercase them. */
export function streetName(name: string | null | undefined): string | null {
  const t = (name ?? "").trim();
  return t ? t : null;
}

/**
 * Road-relative direction caption, e.g. "Northbound on Main Street",
 * "Backing up, facing east on Park Street", "Parked, facing south".
 * Sentence case for the first word only; street names keep their case.
 */
export function directionCaption(v: Pick<SceneVehicle, "action" | "travel">): string {
  const bound = boundWord(v.travel.bearingDeg);
  const on = streetName(v.travel.roadName) ? ` on ${streetName(v.travel.roadName)}` : "";
  switch (v.action) {
    case "parked": return `Parked, facing ${FACING[bound]}${on}`;
    case "backing": return `Backing up, facing ${FACING[bound]}${on}`;
    case "turn-left": return `Turning left, ending ${bound}${on}`;
    case "turn-right": return `Turning right, ending ${bound}${on}`;
    default: return `${bound.charAt(0).toUpperCase()}${bound.slice(1)}${on}`;
  }
}

/** "2019 Toyota RAV4", or null when nothing is entered. */
export function vehicleName(v: Pick<SceneVehicle, "year" | "make" | "model">): string | null {
  const s = [v.year ?? "", v.make.trim(), v.model.trim()].filter((x) => String(x).length > 0).join(" ");
  return s || null;
}

/** The accident's local date and time as entered; no time zone is implied. */
export function formatOccurred(date: string, time: string | null): string {
  const d = new Date(`${date}T${time ?? "12:00"}:00`);
  if (Number.isNaN(d.getTime())) return "";
  const day = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(d);
  return time ? `${day}, ${new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(d)} local time` : `${day} (time not given)`;
}

/** Save time for stamps: local with zone, e.g. "Oct 9, 2026, 4:28:19 PM EDT". */
export function formatStamp(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short" }).format(new Date(iso));
}

/**
 * Join clauses with commas. A clause that repeats the one before it is dropped, and a word that ends one
 * clause and starts the next ("going straight" + "straight on Main Street") is said once. Words inside a
 * clause are never touched, so a name such as "Walla Walla Road" survives.
 */
export function joinClauses(parts: readonly string[]): string {
  const out: string[] = [];
  for (const raw of parts) {
    let p = raw.replace(/\s+/g, " ").trim();
    if (!p) continue;
    const prev = out[out.length - 1];
    if (prev !== undefined) {
      if (prev.toLowerCase() === p.toLowerCase()) continue;
      const last = prev.split(" ").pop()?.toLowerCase();
      const [first, ...rest] = p.split(" ");
      if (last && first?.toLowerCase() === last && rest.length > 0) p = rest.join(" ");
    }
    out.push(p);
  }
  return out.join(", ");
}
