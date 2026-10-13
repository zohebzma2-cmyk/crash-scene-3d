// Fixtures mode serves the examples' cached map data (osm.json, terrain tiles) and never calls /api.
// It exists only in a dev server or a build made with VITE_FIXTURES=1: a normal production build
// neither honors ?fixtures=1 nor contains the map data. (?example=<name> still works there; it loads
// just that scene.json and uses the real services. See examples.ts.)
import { typeFromVpic, type CrossStreet, type CrossStreetsResult, type LatLon, type PlaceResult, type RoadNetwork, type Scene } from "@csd/core";
import { mapConfig } from "../config/map";
import { dist, nearestOnPolyline, polylineCrossings } from "../lib/geometry";
import { fakeToLatLon, fakeToLocal } from "./fakes";
import { exampleName, loadAllExamples } from "./examples";
import type { GeoService, RoadsService, VehiclesService } from "./types";
import { countingTiles, type RoadsDeps } from "./roads";
import { townLookups } from "./towns";
import { ServiceError } from "./types";
import { resolveMake } from "./vehicles";

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

/**
 * The synthetic road sites (apps/web/fixtures/roads/<site>/osm.json, written from packages/mapdata/test/synthetic-osm.ts):
 * made-up road shapes (a curved road, a roundabout, …) for the e2e specs. Fixture builds only; no terrain.
 */
const siteModules = (FIXTURE_BUILD ? import.meta.glob("../../fixtures/roads/*/osm.json", { import: "default" }) : {}) as Record<string, () => Promise<unknown>>;
let sitesPromise: Promise<FixtureOsm[]> | null = null;
const allSites = () => (sitesPromise ??= Promise.all(Object.values(siteModules).map(async (load) => (await load()) as FixtureOsm)));

/** The synthetic site whose centre is within about a kilometer of a point, or null. */
async function nearestSite(p: LatLon): Promise<FixtureOsm | null> {
  let best: { osm: FixtureOsm; d: number } | null = null;
  for (const osm of await allSites()) {
    if (!osm.center) continue;
    const d = dist(fakeToLocal({ origin: osm.center }, p), { x: 0, y: 0 });
    if (d < 1000 && (!best || d < best.d)) best = { osm, d };
  }
  return best?.osm ?? null;
}

export function createFixtureRoads(deps: RoadsDeps): RoadsService {
  return {
    async load(center, radiusM = 250, onProgress) {
      const name = await nearestExample(center);
      const frame = { origin: center };
      const key = name ? Object.keys(osmModules).find((k) => exampleName(k) === name) : undefined;
      const loader = key ? osmModules[key] : undefined;
      if (!name || !loader) {
        const site = await nearestSite(center);
        return deps.parseOverpass(site ?? { elements: [] }, frame, radiusM, site?.fetchedAt ?? new Date().toISOString());
      }
      const osm = (await loader()) as FixtureOsm;
      const net = deps.parseOverpass(osm, frame, radiusM, osm.fetchedAt ?? new Date().toISOString());
      const terrain = await deps.terrain(frame, radiusM, countingTiles(center, radiusM, async (z, x, y) => {
        const tkey = Object.keys(terrainModules).find((k) => exampleName(k) === name && k.endsWith(`/${z}-${x}-${y}.png`));
        const url = tkey ? await (terrainModules[tkey] as () => Promise<string>)() : null;
        if (!url) throw new ServiceError("No cached terrain tile.", "not-found");
        const res = await fetch(url);
        return new Uint8Array(await res.arrayBuffer());
      }, onProgress));
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
      // "Main Street, Nashua NH": the street part is matched against the streets of that town only.
      const comma = q.indexOf(",");
      const streetPart = comma >= 0 ? q.slice(0, comma) : q;
      const townPart = comma >= 0 ? q.slice(comma + 1) : "";
      const sameText = (a: string, b: string) => words(a).join(" ") === words(b).join(" ");
      for (const { net, scene } of await allNets()) {
        const ts = townState(scene.location.label);
        // A town on its own ("Nashua, NH" or "Nashua NH") is a place too: the example's own spot stands for it.
        if (sameText(ts, q) && !out.some((p) => p.label === ts)) out.push({ label: ts, main: ts.split(",")[0] ?? ts, sub: ts, lat: scene.location.lat, lon: scene.location.lon, kind: "road", category: "place" });
        if (townPart && !sameText(ts, townPart)) continue;
        const seen = new Set<string>();
        for (const w of net.ways) {
          if (!w.name || seen.has(w.name) || !matches(w.name, streetPart)) continue;
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

// An offline slice of NHTSA vPIC for fixtures mode and the e2e tests: real makes and models with the model
// years they were sold (approximate), typed the way the proxy types them (typeFromVpic). Makes without
// models here still show in the list, as do a few obscure ones that share prefixes, so ranking is exercised.
const CAR = "Passenger Car";
const MPV = "Multipurpose Passenger Vehicle (MPV)";
const TRUCK = "Truck";
const MOTO = "Motorcycle";
type FixtureModel = readonly [name: string, vpicType: string, from: number, to?: number];
const MODELS: Readonly<Record<string, readonly FixtureModel[]>> = {
  Chevrolet: [["Silverado 1500", TRUCK, 1999], ["Silverado 2500HD", TRUCK, 2001], ["4500HD", TRUCK, 2019], ["Colorado", TRUCK, 2004], ["Malibu", CAR, 1997, 2025], ["Equinox", MPV, 2005], ["Tahoe", MPV, 1995], ["Corvette", CAR, 1981], ["Camaro", CAR, 1981, 2024], ["Express", TRUCK, 1996]],
  Honda: [["Accord", CAR, 1981], ["Civic", CAR, 1981], ["CR-V", MPV, 1997], ["HR-V", MPV, 2016], ["Odyssey", MPV, 1995], ["Pilot", MPV, 2003], ["Ridgeline", TRUCK, 2006], ["Gold Wing", MOTO, 1981]],
  Ford: [["F-150", TRUCK, 1981], ["F-250", TRUCK, 1981], ["F-350", TRUCK, 1981], ["F-650", TRUCK, 2000], ["E-450", TRUCK, 1992], ["Maverick", TRUCK, 2022], ["Escape", MPV, 2001], ["Explorer", MPV, 1991], ["Mustang", CAR, 1981], ["Fusion", CAR, 2006, 2020], ["Ranger", TRUCK, 1983], ["Transit", TRUCK, 2015]],
  Volkswagen: [["Jetta", CAR, 1981], ["Golf", CAR, 1985], ["Passat", CAR, 1990], ["Beetle", CAR, 1998, 2019], ["Tiguan", MPV, 2009], ["Atlas", MPV, 2018]],
  "Harley-Davidson": [["Street Glide", MOTO, 2006], ["Road King", MOTO, 1994], ["Sportster", MOTO, 1981], ["Fat Boy", MOTO, 1990]],
  Toyota: [["Camry", CAR, 1983], ["Corolla", CAR, 1981], ["RAV4", MPV, 1996], ["Highlander", MPV, 2001], ["4Runner", MPV, 1984], ["Sienna", MPV, 1998], ["Tacoma", TRUCK, 1995], ["Tundra", TRUCK, 2000]],
  Subaru: [["Outback", MPV, 1995], ["Impreza", CAR, 1993], ["Forester", MPV, 1998]],
  Ram: [["1500", TRUCK, 2011], ["2500", TRUCK, 2011], ["ProMaster", TRUCK, 2014]],
  Nissan: [["Altima", CAR, 1993], ["Rogue", MPV, 2008], ["Frontier", TRUCK, 1998], ["Titan", TRUCK, 2004]],
  Tesla: [["Model 3", CAR, 2017], ["Model S", CAR, 2012], ["Model Y", MPV, 2020], ["Cybertruck", TRUCK, 2024]],
  Isuzu: [["NPR", TRUCK, 1984], ["NQR", TRUCK, 1995]],
  GMC: [["Sierra 1500", TRUCK, 1999], ["Canyon", TRUCK, 2004], ["Savana", TRUCK, 1996], ["Yukon", MPV, 1992], ["Acadia", MPV, 2007]],
  Chrysler: [["Pacifica", MPV, 2004], ["300", CAR, 2005]],
  Kia: [["Carnival", MPV, 2022], ["Sedona", MPV, 2002, 2021], ["Sorento", MPV, 2003], ["Forte", CAR, 2010]],
  Dodge: [["Grand Caravan", MPV, 1987, 2020], ["Durango", MPV, 1998], ["Charger", CAR, 2006]],
  Jeep: [["Gladiator", TRUCK, 2020], ["Wrangler", MPV, 1987], ["Grand Cherokee", MPV, 1993]],
  Hyundai: [["Santa Cruz", TRUCK, 2022], ["Elantra", CAR, 1992], ["Tucson", MPV, 2005]],
  "Mercedes-Benz": [["Sprinter", TRUCK, 2010], ["Metris", MPV, 2016, 2023], ["C-Class", CAR, 1994]],
};
const OTHER_MAKES = [
  "Acura", "Audi", "BMW", "Buick", "Cadillac", "Champion Bus", "Chang Jiang",
  "Land Rover", "Lexus", "Mazda", "Merch Motorcycle Co.", "Mercury", "Mini", "Ram Transcorp", "Toyo Motors", "Volvo",
];

export function createFixtureVehicles(): VehiclesService {
  const names = [...Object.keys(MODELS), ...OTHER_MAKES].sort((a, b) => a.localeCompare(b));
  return {
    makes: async () => names,
    canonicalMake: (text) => resolveMake(text, names),
    models: async (make, year) => {
      const key = resolveMake(make, Object.keys(MODELS));
      return (key ? MODELS[key] ?? [] : [])
        .filter(([, , from, to]) => year >= from && year <= (to ?? year))
        .map(([name, vpicType]) => ({ name, vpicType, type: typeFromVpic(vpicType, name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
  };
}
