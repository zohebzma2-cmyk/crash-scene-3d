// The one formatter: units, rounding and "about". Physics stays in SI;
// rounding happens only here (DESIGN.md section 14).
import { MPH_TO_MPS as MPH } from "./physics.js";
export const FT = 3.28084;

const r0 = (x) => Math.round(x);
const r1 = (x) => Math.round(x * 10) / 10;
const fmt1 = (x) => r1(x).toFixed(1);

/** @param {{lo:number,mid:number,hi:number}|number} m meters */
export function dist(m, { both = true, units = "us" } = {}) {
  const v = typeof m === "number" ? { lo: m, mid: m, hi: m } : m;
  const ranged = r0(v.lo * FT) !== r0(v.hi * FT);
  const ft = ranged ? `${r0(v.lo * FT)}–${r0(v.hi * FT)} ft` : `${r0(v.mid * FT)} ft`;
  const mm = ranged ? `${fmt1(v.lo)}–${fmt1(v.hi)} m` : `${fmt1(v.mid)} m`;
  if (both) return { text: `${ft} / ${mm}`, ranged };
  return { text: units === "metric" ? mm : ft, ranged };
}

/** @param {{lo:number,mid:number,hi:number}|number} mps */
export function speed(mps, { units = "us", both = false } = {}) {
  const v = typeof mps === "number" ? { lo: mps, mid: mps, hi: mps } : mps;
  const mph = (x) => r0(x / MPH), kmh = (x) => r0(x * 3.6);
  const ranged = mph(v.lo) !== mph(v.hi);
  const us = ranged ? `${mph(v.lo)}–${mph(v.hi)} mph` : `${mph(v.mid)} mph`;
  const si = ranged ? `${kmh(v.lo)}–${kmh(v.hi)} km/h` : `${kmh(v.mid)} km/h`;
  if (both) return { text: `${us} · ${si}`, ranged };
  return { text: units === "metric" ? si : us, ranged };
}

export const kg = (x) => `${Math.round(x).toLocaleString("en-US")} kg`;
export const lb = (x) => `${Math.round((x / 0.45359237) / 10) * 10}`.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + " lb";

export const COMPASS_WORD = { 0: "north", 90: "east", 180: "south", 270: "west" };
export const ACTION_WORD = { straight: "going straight", "turn-left": "turning left", "turn-right": "turning right", backing: "backing up", parked: "parked" };
export const ZONE_WORD = { front: "Front", "front-right": "Front right", right: "Right side", "rear-right": "Rear right", rear: "Rear", "rear-left": "Rear left", left: "Left side", "front-left": "Front left" };
export const ROAD_WORD = { dry: "dry", wet: "wet", snow: "snowy", ice: "icy" };
export const PLACE_WORD = { intersection: "Intersection", road: "Straight road", parking: "Parking lot" };

/** Street names that apply to the chosen place (none for a parking lot, one for a road). */
export function visibleStreets(loc) {
  if (loc.place === "parking") return {};
  if (loc.place === "road") return { ew: loc.streets?.ew };
  return { ew: loc.streets?.ew, ns: loc.streets?.ns };
}

/** "Heading east on Maple Ave" / "Facing north, backing up" / "Parked, facing west". */
export function directionCaption(v, streets) {
  const dir = COMPASS_WORD[v.heading];
  const street = v.heading % 180 === 0 ? streets?.ns : streets?.ew;
  const on = street ? ` on ${street}` : "";
  if (v.action === "parked") return `Parked, facing ${dir}${on}`;
  if (v.action === "backing") return `Facing ${dir}, backing up${on}`;
  if (v.action === "turn-left") return `Turning left, ending up heading ${dir}${on}`;
  if (v.action === "turn-right") return `Turning right, ending up heading ${dir}${on}`;
  return `Heading ${dir}${on}`;
}

export function vehicleName(v) {
  const ymm = [v.year, v.make, v.model].filter(Boolean).join(" ");
  return ymm || null;
}

/** The accident's local date and time as entered (no time zone is implied). */
export function fmtDateTime(date, time) {
  if (!date) return "";
  const d = new Date(`${date}T${time || "12:00"}`);
  if (Number.isNaN(d.getTime())) return "";
  const day = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(d);
  return time ? `${day}, ${new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(d)} local time` : `${day} (time not given)`;
}
export function fmtStamp(iso) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short" }).format(new Date(iso));
}
