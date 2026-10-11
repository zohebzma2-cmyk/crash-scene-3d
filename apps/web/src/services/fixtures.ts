// Fixtures mode serves the examples' cached map data (osm.json, terrain tiles) and never calls /api.
// It exists only in a dev server or a build made with VITE_FIXTURES=1: a normal production build
// neither honors ?fixtures=1 nor contains the map data. (?example=<name> still works there; it loads
// just that scene.json and uses the real services. See examples.ts.)
import { type CrossStreet, type CrossStreetsResult, type LatLon, type PlaceResult, type RoadNetwork, type Scene } from "@csd/core";
import { mapConfig } from "../config/map";
import { dist, nearestOnPolyline, polylineCrossings } from "../lib/geometry";
import { fakeToLatLon, fakeToLocal } from "./fakes";
import { exampleName, loadAllExamples } from "./examples";
import type { GeoService, RoadsService, VehiclesService } from "./types";
import type { RoadsDeps } from "./roads";
import { townLookups } from "./towns";
import { ServiceError } from "./types";

export interface FixtureEnv {
  readonly DEV?: boolean;
  readonly VITE_FIXTURES?: string;
}

/** Fixtures can exist at all only in a dev server or a VITE_FIXTURES=1 build. */
export const fixturesAllowed = (env: FixtureEnv = import.meta.env): boolean => env.DEV === true || env.VITE_FIXTURES === "1";

/** Is fixtures mode on for this page? ?fixtures=1 (or ?example=, for the bundled map data) only counts where fixtures are allowed. */
export function fixturesRequested(search: string, env: FixtureEnv = import.meta.env): boolean {
  if (!fixturesAllowed(env)) return false;
  const p = new URLSearchParams(search);
  return p.get("fixtures") === "1" || env.VITE_FIXTURES === "1" || p.has("example");
}

// The map data is only bundled where fixtures are allowed; elsewhere these are empty and the code is dropped.
const FIXTURE_BUILD = import.meta.env.DEV || import.meta.env.VITE_FIXTURES === "1";
const osmModules = (FIXTURE_BUILD ? import.meta.glob("../../../../examples/*/osm.json", { import: "default" }) : {}) as Record<string, () => Promise<unknown>>;
const terrainModules = (FIXTURE_BUILD ? import.meta.glob("../../../../examples/*/terrain/*.png", { query: "?url", import: "default" }) : {}) as Record<string, () => Promise<string>>;

export interface FixtureOsm {
  readonly fetchedAt?: string;
  readonly center?: LatLon;
  readonly radiusM?: number;
  readonly elements?: unknown[];
}

let scenesPromise: Promise<Map<string, Scene>> | null = null;
const allScenes = () => (scenesPromise ??= loadAllExamples());

/** Nearest example to a point within about a kilometer, or null. */
async function nearestExample(p: LatLon): Promise<string | null> {
  const scenes = await allScenes();
  let best: { name: string; d: number } | null = null;
  for (const [name, s] of scenes) {
    const d = dist(fakeToLocal({ origin: s.location }, p), { x: 0, y: 0 });
    if (d < 1000 && (!best || d < best.d)) best = { name, d };
  }
  return best?.name ?? null;
}

export function createFixtureRoads(deps: RoadsDeps): RoadsService {
  return {
    async load(center, radiusM = 250) {
      const name = await nearestExample(center);
      const frame = { origin: center };
      const key = name ? Object.keys(osmModules).find((k) => exampleName(k) === name) : undefined;
      const loader = key ? osmModules[key] : undefined;
      if (!name || !loader) return deps.parseOverpass({ elements: [] }, frame, radiusM, new Date().toISOString());
      const osm = (await loader()) as FixtureOsm;
      const net = deps.parseOverpass(osm, frame, radiusM, osm.fetchedAt ?? new Date().toISOString());
      const terrain = await deps.terrain(frame, radiusM, async (z, x, y) => {
        const tkey = Object.keys(terrainModules).find((k) => exampleName(k) === name && k.endsWith(`/${z}-${x}-${y}.png`));
        const url = tkey ? await (terrainModules[tkey] as () => Promise<string>)() : null;
        if (!url) throw new ServiceError("No cached terrain tile.", "not-found");
        const res = await fetch(url);
        return new Uint8Array(await res.arrayBuffer());
      });
      return terrain ? ({ ...net, terrain } satisfies RoadNetwork) : net;
    },
  };
}

const STOP = new Set(["and", "the", "nh", "new", "hampshire", "usa", "us", "of", "at", "in"]);
const tokens = (s: string) => s.toLowerCase().replace(/&/g, " and ").split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !STOP.has(t));

/** Search over the example places: a query matches an example when most of its words are in the example's name. */
const STATE_ABBR: Record<string, string> = { "new hampshire": "NH", massachusetts: "MA", maine: "ME", vermont: "VT" };
const abbr = (state: string) => STATE_ABBR[state.toLowerCase()] ?? state;
/** "Nashua, New Hampshire" from a label's tail: the town and the state, as "Nashua, NH". */
function townState(label: string): string {
  const parts = label.split(",").map((p) => p.trim());
  const state = parts.length > 2 ? parts[parts.length - 1] ?? "" : "";
  const town = parts.length > 2 ? parts[parts.length - 2] ?? "" : parts[1] ?? "";
  return [town, abbr(state)].filter(Boolean).join(", ");
}
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
/** Does `name` start with each typed word (the last typed word may be partial)? */
const matches = (name: string, typed: string) => {
  const have = words(name);
  const want = words(typed);
  return want.length > 0 && want.every((w, i) => have.some((h) => (i === want.length - 1 ? h.startsWith(w) : h === w)));
};

export function createFixtureGeo(split: (q: string) => { a: string; b: string; near: string } | null, deps: RoadsDeps): GeoService {
  const nets = new Map<string, Promise<{ net: RoadNetwork; scene: Scene } | null>>();
  const netFor = (name: string) => {
    let p = nets.get(name);
    if (!p) {
      p = (async () => {
        const scene = (await allScenes()).get(name);
        const key = Object.keys(osmModules).find((k) => exampleName(k) === name);
        const loader = key ? osmModules[key] : undefined;
        if (!scene || !loader) return null;
        const osm = (await loader()) as FixtureOsm;
        return { net: deps.parseOverpass(osm, { origin: scene.location }, osm.radiusM ?? 250, osm.fetchedAt ?? new Date().toISOString()), scene };
      })();
      nets.set(name, p);
    }
    return p;
  };
  const allNets = async () => (await Promise.all([...(await allScenes()).keys()].map(netFor))).filter((x): x is { net: RoadNetwork; scene: Scene } => x != null);
  const suggest: GeoService["suggest"] = async (query, opts = {}) => {
      const q = query.trim();
      if (q.length < mapConfig.suggestMinChars) return [];
      const out: PlaceResult[] = [];
      for (const { net, scene } of await allNets()) {
        const ts = townState(scene.location.label);
        // A town on its own ("Nashua, NH", as the claim gives it) is a place too: the example's own spot stands for it.
        if (ts.toLowerCase() === q.toLowerCase() && !out.some((p) => p.label === ts)) out.push({ label: ts, main: ts.split(",")[0] ?? ts, sub: ts, lat: scene.location.lat, lon: scene.location.lon, kind: "road", category: "place" });
        const seen = new Set<string>();
        for (const w of net.ways) {
          if (!w.name || seen.has(w.name) || !matches(w.name, q)) continue;
          seen.add(w.name);
          const near = nearestOnPolyline(w.centerline, { x: 0, y: 0 });
          const at = near ? fakeToLatLon(net.frame, near.point) : scene.location;
          out.push({ label: `${w.name}, ${ts}`, main: w.name, sub: ts, lat: at.lat, lon: at.lon, kind: "road", category: "street", street: w.name, osmWayIds: w.osmWayIds });
        }
      }
      const bias = opts.bias;
      if (bias) out.sort((a, b) => dist(fakeToLocal({ origin: bias }, a), { x: 0, y: 0 }) - dist(fakeToLocal({ origin: bias }, b), { x: 0, y: 0 }));
      return out.slice(0, mapConfig.suggestLimit);
  };
  return {
    suggest,
    ...townLookups(suggest),
    async crossStreets(street, near): Promise<CrossStreetsResult> {
      const result = new Map<string, { name: string; points: LatLon[]; place: string }>();
      for (const { net, scene } of await allNets()) {
        const mine = net.ways.filter((w) => w.name && w.name.toLowerCase() === street.trim().toLowerCase());
        if (mine.length === 0) continue;
        for (const other of net.ways) {
          if (!other.name || other.name.toLowerCase() === street.trim().toLowerCase() || other.kind === "parking_aisle") continue;
          for (const m of mine) for (const p of polylineCrossings(m.centerline, other.centerline)) {
            const entry = result.get(other.name) ?? { name: other.name, points: [], place: townState(scene.location.label) };
            const ll = fakeToLatLon(net.frame, p);
            if (!entry.points.some((q) => Math.abs(q.lat - ll.lat) < 2e-5 && Math.abs(q.lon - ll.lon) < 2e-5)) entry.points.push(ll);
            result.set(other.name, entry);
          }
        }
      }
      const crossings: CrossStreet[] = [...result.values()].map((e) => {
        const sorted = near ? [...e.points].sort((a, b) => dist(fakeToLocal({ origin: near }, a), { x: 0, y: 0 }) - dist(fakeToLocal({ origin: near }, b), { x: 0, y: 0 })) : e.points;
        const first = sorted[0] as LatLon;
        return { name: e.name, lat: first.lat, lon: first.lon, points: sorted, osmWayIds: [], ...(e.points.length > 1 ? { place: e.place } : {}) };
      }).sort((a, b) => a.name.localeCompare(b.name));
      return { street: street.trim(), crossings };
    },
    async search(query) {
      const q = tokens(query);
      if (q.length === 0) return [];
      const crossing = split(query);
      const results: PlaceResult[] = [];
      for (const s of (await allScenes()).values()) {
        const label = s.location.label;
        const have = new Set(tokens(label));
        const hit = q.filter((t) => have.has(t)).length;
        if (hit / q.length < 0.6) continue;
        const parts = label.split(",").map((p) => p.trim());
        results.push({
          label, main: parts[0] ?? label, sub: parts.slice(1).join(", "), lat: s.location.lat, lon: s.location.lon,
          kind: s.location.place === "intersection" ? "intersection" : s.location.place === "parking" ? "parking" : "road",
          ...(crossing && s.location.place === "intersection" ? { streets: [crossing.a, crossing.b] as const } : {}),
        });
      }
      return results.slice(0, 5);
    },
  };
}

const MAKES: Record<string, Array<{ name: string; type: "car" | "suv" | "pickup" | "van" | null; vpicType: string }>> = {
  Honda: [{ name: "Accord", type: "car", vpicType: "Passenger Car" }, { name: "CR-V", type: "suv", vpicType: "Multipurpose Passenger Vehicle (MPV)" }, { name: "Odyssey", type: "van", vpicType: "Multipurpose Passenger Vehicle (MPV)" }],
  Toyota: [{ name: "Camry", type: "car", vpicType: "Passenger Car" }, { name: "RAV4", type: "suv", vpicType: "Multipurpose Passenger Vehicle (MPV)" }, { name: "Tacoma", type: "pickup", vpicType: "Truck" }],
  Ford: [{ name: "Escape", type: "suv", vpicType: "Multipurpose Passenger Vehicle (MPV)" }, { name: "F-150", type: "pickup", vpicType: "Truck" }, { name: "Fusion", type: "car", vpicType: "Passenger Car" }],
  Chevrolet: [{ name: "Malibu", type: "car", vpicType: "Passenger Car" }, { name: "Silverado 1500", type: "pickup", vpicType: "Truck" }, { name: "Equinox", type: "suv", vpicType: "Multipurpose Passenger Vehicle (MPV)" }],
  Subaru: [{ name: "Outback", type: "suv", vpicType: "Multipurpose Passenger Vehicle (MPV)" }, { name: "Impreza", type: "car", vpicType: "Passenger Car" }],
};

export function createFixtureVehicles(): VehiclesService {
  return {
    makes: async () => Object.keys(MAKES).sort(),
    models: async (make) => {
      const key = Object.keys(MAKES).find((k) => k.toLowerCase() === make.trim().toLowerCase());
      return key ? (MAKES[key] ?? []).map((m) => ({ name: m.name, vpicType: m.vpicType, type: m.type })) : [];
    },
  };
}
