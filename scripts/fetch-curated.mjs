// One-off capture of the cached map data for the CURATED example locations (examples/<slug>/), run by
// hand with network access. Same shape and policy as scripts/fetch-fixtures.mjs (descriptive User-Agent,
// ≥2 s between requests, a long Overpass timeout, fallback instances when the main one is busy), so the
// bundled data a recruiter opens never waits on a live Overpass call.
//
// These are FAMOUS, verified-public, drivable intersections in major US cities, far from any personal
// address (see the privacy rule in CLAUDE.md). The scene.json beside each is made up; only the public
// road geometry and street names come from OSM.
//
// Usage: node scripts/fetch-curated.mjs [slug]        (no slug = all)
//   CURATED_NO_BUILDINGS=1   skip the (dense, heavy) building geometry: roads, parking and controls only.
import { mkdir, readFile, writeFile } from "node:fs/promises";

// The contact lives in one place, ProviderConfig (packages/proxy/src/config.ts); read it from there
// so the User-Agent matches what the proxy sends.
const config = await readFile(new URL("../packages/proxy/src/config.ts", import.meta.url), "utf8");
const CONTACT = /DEFAULT_CONTACT = "([^"]+)"/.exec(config)?.[1];
if (!CONTACT) throw new Error("DEFAULT_CONTACT not found in packages/proxy/src/config.ts");
const UA = `InsurifyAI-CrashScene/1.0 (+${CONTACT})`;
// OSM France answers street queries fast and reliably (see the comment in config.ts); the rest are fallbacks.
const OVERPASS = [
  "https://overpass.openstreetmap.fr/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const TERRAIN = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
const RADIUS_M = 250;
const NO_BUILDINGS = process.env.CURATED_NO_BUILDINGS === "1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;
async function polite() { const wait = last + 2000 - Date.now(); if (wait > 0) await sleep(wait); last = Date.now(); }

const DRIVABLE = "motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|service";

// Same shape as @csd/mapdata overpassAroundQuery (roads, buildings, parking, then the node/way features),
// so the bundled data carries the controls the scene draws. A long timeout: this is a one-off, run by hand.
export function aroundQuery(lat, lon, r) {
  const a = `around:${r},${lat},${lon}`;
  const buildings = NO_BUILDINGS ? "" : `way(${a})["building"];`;
  return `[out:json][timeout:60];(way(${a})["highway"~"^(${DRIVABLE})$"];${buildings}way(${a})["amenity"="parking"];node(${a})["highway"~"^(traffic_signals|stop|give_way|crossing|street_lamp)$"];node(${a})["traffic_sign"];way(${a})["footway"="crossing"];);out body geom;`;
}

async function overpass(query) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const url = OVERPASS[attempt % OVERPASS.length];
    await polite();
    try {
      const res = await fetch(url, { method: "POST", headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ data: query }) });
      const text = await res.text();
      if (res.ok && text.trimStart().startsWith("{")) return { json: JSON.parse(text), url };
      console.warn(`  ${url}: HTTP ${res.status}, retrying`);
    } catch (e) { console.warn(`  ${url}: ${e.message}, retrying`); }
  }
  throw new Error("Overpass unavailable after retries");
}

function tileOf(lat, lon, z) {
  const n = 2 ** z, x = Math.floor(((lon + 180) / 360) * n);
  const r = (lat * Math.PI) / 180, y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  return { x, y };
}

/**
 * Privacy (CLAUDE.md hard rule 1: never house numbers, no personal data). Strip addresses and contact info
 * from building tags before anything is written. Keep addr:city (consumed by packages/mapdata/src/cross.ts)
 * and all road geometry/tags. The road network needs none of what this removes.
 */
function scrubPersonal(json) {
  for (const el of json.elements || []) {
    if (!el.tags) continue;
    for (const k of Object.keys(el.tags)) {
      if ((k.startsWith("addr:") && k !== "addr:city") || k === "phone" || k === "email" || k.startsWith("contact:")) delete el.tags[k];
    }
  }
  return json;
}

async function capture(name, center, extra) {
  const dir = new URL(`../examples/${name}/`, import.meta.url);
  await mkdir(new URL("terrain/", dir), { recursive: true });
  console.log(`${name}: Overpass around ${center.lat}, ${center.lon} (${RADIUS_M} m)${NO_BUILDINGS ? " [no buildings]" : ""}`);
  const query = aroundQuery(center.lat, center.lon, RADIUS_M);
  const { json, url } = await overpass(query);
  scrubPersonal(json); // remove house numbers and contact info before writing (privacy)
  const fetchedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  await writeFile(new URL("osm.json", dir), JSON.stringify({ fetchedAt, source: url, center, radiusM: RADIUS_M, query, ...json }));
  // Terrain: the zoom-15 tile under the center plus its 8 neighbours (≈ 1.2 km square at this latitude).
  const z = 15, c = tileOf(center.lat, center.lon, z);
  const tiles = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const t = { z, x: c.x + dx, y: c.y + dy };
    await polite();
    const res = await fetch(TERRAIN.replace("{z}", t.z).replace("{x}", t.x).replace("{y}", t.y), { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`terrain ${t.z}/${t.x}/${t.y}: HTTP ${res.status}`);
    await writeFile(new URL(`terrain/${t.z}-${t.x}-${t.y}.png`, dir), new Uint8Array(await res.arrayBuffer()));
    tiles.push(t);
  }
  await writeFile(new URL("terrain/tiles.json", dir), JSON.stringify({ encoding: "terrarium", source: TERRAIN, tiles }, null, 2));
  await writeFile(new URL("ATTRIBUTION.md", dir), `# Data sources for this example

- Roads, buildings and parking: © OpenStreetMap contributors, available under the Open Database License (ODbL) 1.0. https://www.openstreetmap.org/copyright
  Fetched ${fetchedAt} from ${url}.
- Elevation: Terrarium tiles from the AWS Terrain Tiles open dataset (Mapzen/Tilezen; sources include USGS 3DEP and SRTM). https://registry.opendata.aws/terrain-tiles/
- The claim, people and vehicles in scene.json are made up. The place is a famous public intersection. House numbers and contact details have been stripped from the OSM building tags (scripts/fetch-curated.mjs): only public road geometry, street names and the town (addr:city) remain.
${extra ?? ""}`);
  const ways = json.elements.filter((e) => e.type === "way");
  console.log(`  ${ways.filter((w) => w.tags?.highway).length} roads, ${ways.filter((w) => w.tags?.building).length} buildings, ${ways.filter((w) => w.tags?.amenity === "parking").length} parking areas, ${tiles.length} terrain tiles`);
}

// Famous, verified-public, drivable intersections (signal-node coordinates on the crossing itself), each far
// from New Hampshire. Centers are on the road, so the 250 m scene square is centred on the intersection.
const SITES = {
  "nyc-5th-42nd": { center: { lat: 40.7534805, lon: -73.9808792 }, extra: "- Crossing: 5th Avenue and 42nd Street, Manhattan, New York (by the New York Public Library / Bryant Park; OSM node 42437358).\n" },
  "chicago-state-madison": { center: { lat: 41.8820455, lon: -87.6278089 }, extra: "- Crossing: State Street and Madison Street, Chicago (the origin of the city's address grid; OSM node 27446720).\n" },
  "la-hollywood-highland": { center: { lat: 34.1015452, lon: -118.3387179 }, extra: "- Crossing: Hollywood Boulevard and Highland Avenue, Los Angeles (Hollywood Walk of Fame; OSM node 24960543).\n" },
  "sf-haight-ashbury": { center: { lat: 37.7700148, lon: -122.4469519 }, extra: "- Crossing: Haight Street and Ashbury Street, San Francisco (Haight-Ashbury; OSM node 65327925).\n" },
};

const only = process.argv[2];
for (const [slug, s] of Object.entries(SITES)) {
  if (only && only !== slug) continue;
  await capture(slug, s.center, s.extra);
}
console.log("done");
