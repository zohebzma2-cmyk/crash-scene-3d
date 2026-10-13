// Minimal typed view of Overpass JSON (`out body geom`), plus tolerant tag parsing.
import type { LatLon } from "@csd/core";

export interface OsmWay {
  readonly id: number;
  readonly nodes: readonly (number | undefined)[];
  readonly geometry: readonly LatLon[];
  readonly tags: Readonly<Record<string, string>>;
}

/** Pull the ways (with geometry) out of an Overpass response; throws if it isn't one. */
export function osmWays(json: unknown): OsmWay[] {
  if (typeof json !== "object" || json === null || !Array.isArray((json as { elements?: unknown }).elements)) {
    throw new Error("Not an Overpass response (no elements array).");
  }
  const out: OsmWay[] = [];
  for (const raw of (json as { elements: unknown[] }).elements) {
    if (typeof raw !== "object" || raw === null) continue;
    const e = raw as Record<string, unknown>;
    if (e.type !== "way" || typeof e.id !== "number" || !Array.isArray(e.geometry)) continue;
    const geometry: LatLon[] = [];
    for (const g of e.geometry as unknown[]) {
      // Overpass writes null for nodes outside a clipped bbox; skip them.
      if (typeof g !== "object" || g === null) continue;
      const { lat, lon } = g as { lat?: unknown; lon?: unknown };
      if (typeof lat === "number" && typeof lon === "number") geometry.push({ lat, lon });
    }
    // A clipped example endpoint has no OpenStreetMap node ID. Preserve its slot so
    // interior node IDs still join adjacent ways and orient connected controls.
    const nodes = Array.isArray(e.nodes) ? (e.nodes as unknown[]).map(n => typeof n === "number" ? n : undefined) : [];
    const tags: Record<string, string> = {};
    if (typeof e.tags === "object" && e.tags !== null) {
      for (const [k, v] of Object.entries(e.tags as Record<string, unknown>)) if (typeof v === "string") tags[k] = v;
    }
    out.push({ id: e.id, nodes: nodes.length === geometry.length ? nodes : [], geometry, tags });
  }
  return out;
}

const KM_PER_MI = 1.609344;
const M_PER_FT = 0.3048;

/** A length tag ("12", "12 m", "40 ft", "40'") in metres, or null. */
export function parseLengthM(v: string | undefined): number | null {
  if (v === undefined) return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(m|meters?|metres?|ft|feet|')?\s*$/i.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] ?? "m").toLowerCase();
  return unit === "ft" || unit === "feet" || unit === "'" ? n * M_PER_FT : n;
}

/** A maxspeed tag in mph: "25 mph" as is, bare numbers and "50 km/h" converted from km/h. Null for "none", "signals", … */
export function parseSpeedMph(v: string | undefined): number | null {
  if (v === undefined) return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh|kph)?\s*$/i.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] ?? "km/h").toLowerCase();
  return unit === "mph" ? n : Math.round(n / KM_PER_MI);
}

/** A count tag ("2", "2;3" → 2). Null when missing or not a positive-or-zero integer. */
export function parseCount(v: string | undefined): number | null {
  if (v === undefined) return null;
  const m = /^\s*(\d+)/.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 0 && n <= 20 ? n : null;
}
