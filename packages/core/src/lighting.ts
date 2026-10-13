// Approximate solar position: NOAA General Solar Position Calculations (solareqns.PDF).
// Offline zone lookup + Intl historical DST rules; no scene data leaves the device.
// The zone lookup (tz-lookup, ~73 KB) is passed in, so this module stays light: `@csd/core/sun` binds it and
// is imported only where an estimate is shown (the 3D viewer's chunk, the lazily loaded scene questions).
import type { Scene } from "./contracts";
const RAD = Math.PI / 180;
const DAY_MS = 86400000;
function solarTerms(utc: number) {
  const d = new Date(utc), year = d.getUTCFullYear();
  const day = Math.floor((Date.UTC(year, d.getUTCMonth(), d.getUTCDate()) - Date.UTC(year, 0, 1)) / DAY_MS) + 1;
  const days = new Date(Date.UTC(year, 1, 29)).getUTCMonth() === 1 ? 366 : 365;
  const hour = d.getUTCHours() + d.getUTCMinutes() / 60;
  const g = 2 * Math.PI / days * (day - 1 + (hour - 12) / 24);
  const eq = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const dec = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  return { hour, eq, dec };
}
export interface SunEstimate {
  readonly elevationDeg: number;
  readonly azimuthDeg: number;
  readonly lighting: "daylight" | "dusk-dawn" | "dark";
  readonly zone: string;
  readonly sunrise: string | null;
  readonly sunset: string | null;
}
/** The IANA zone at a point (tz-lookup's signature); it may throw for an invalid point. */
export type ZoneLookup = (lat: number, lon: number) => string;
export function estimateSunWith(zoneAt: ZoneLookup, scene: Pick<Scene, "location" | "occurred">): SunEstimate | null {
  const { lat, lon } = scene.location, { date, time } = scene.occurred;
  if (!time || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
  try {
    const zone = zoneAt(lat, lon);
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    const wall = Date.parse(`${date}T${time}:00Z`);
    if (!Number.isFinite(wall) || new Date(wall).toISOString().slice(0, 10) !== date) return null;
    const localMs = (ms: number) => {
      const p = Object.fromEntries(fmt.formatToParts(ms).map((x) => [x.type, x.value]));
      return Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`);
    };
    let utc = wall;
    for (let i = 0; i < 4; i++) utc += wall - localMs(utc);
    if (localMs(utc) !== wall) return null;
    // Half-hour folds (Lord Howe) as well as hour and two-hour changes. Do not choose one
    // of two possible instants for a claimant who supplied only a local clock reading.
    for (const minutes of [-180, -150, -120, -90, -60, -30, 30, 60, 90, 120, 150, 180]) {
      if (localMs(utc + minutes * 60000) === wall) return null;
    }
    const { hour, eq, dec } = solarTerms(utc);
    const ha = (hour * 60 + eq + 4 * lon) / 4 * RAD - Math.PI;
    const phi = lat * RAD;
    const elevationDeg = Math.asin(Math.max(-1, Math.min(1, Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha)))) / RAD;
    const azimuthDeg = (Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi)) / RAD + 540) % 360;
    let sunrise: string | null = null, sunset: string | null = null;
    const midnight = Math.floor(utc / DAY_MS) * DAY_MS;
    const clock = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" });
    // Pick events belonging to the pin's LOCAL calendar day, including zones across the
    // date line. Polar days/nights have no sunrise/sunset; don't make up a clock time.
    for (let offset = -1; offset <= 1; offset++) {
      const base = midnight + offset * DAY_MS;
      const terms = solarTerms(base + (720 - 4 * lon) * 60000);
      const cosRise = Math.cos(90.833 * RAD) / (Math.cos(phi) * Math.cos(terms.dec)) - Math.tan(phi) * Math.tan(terms.dec);
      if (cosRise < -1 || cosRise > 1) continue;
      const h = Math.acos(cosRise) / RAD, noon = 720 - 4 * lon - terms.eq;
      const rise = base + (noon - h * 4) * 60000, set = base + (noon + h * 4) * 60000;
      if (new Date(localMs(rise)).toISOString().slice(0, 10) === date) sunrise = clock.format(rise);
      if (new Date(localMs(set)).toISOString().slice(0, 10) === date) sunset = clock.format(set);
    }
    return { elevationDeg, azimuthDeg, lighting: elevationDeg > 0 ? "daylight" : elevationDeg >= -6 ? "dusk-dawn" : "dark", zone, sunrise, sunset };
  } catch { return null; }
}
