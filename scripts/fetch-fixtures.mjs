// One-off capture of the cached map data for examples/ (run by hand; tests
// never call live APIs). Polite: descriptive User-Agent, ≥1 s between requests,
// fallback Overpass instance when the main one is busy.
// Usage: node scripts/fetch-fixtures.mjs
import { mkdir, readFile, writeFile } from "node:fs/promises";

// The contact lives in one place, ProviderConfig (packages/proxy/src/config.ts); read it from there
// so the User-Agent matches what the proxy sends.
const config = await readFile(new URL("../packages/proxy/src/config.ts", import.meta.url), "utf8");
const CONTACT = /DEFAULT_CONTACT = "([^"]+)"/.exec(config)?.[1];
if (!CONTACT) throw new Error("DEFAULT_CONTACT not found in packages/proxy/src/config.ts");
const UA = `InsurifyAI-CrashScene/1.0 (+${CONTACT})`;
const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
const TERRAIN = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
const RADIUS_M = 250;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;
async function polite() { const wait = last + 2000 - Date.now(); if (wait > 0) await sleep(wait); last = Date.now(); }

export function aroundQuery(lat, lon, r) {
  const hw = "motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|service";
  return `[out:json][timeout:60];(way(around:${r},${lat},${lon})["highway"~"^(${hw})$"];way(around:${r},${lat},${lon})["building"];way(around:${r},${lat},${lon})["amenity"="parking"];);out body geom;`;
}

async function overpass(query) {
  for (let attempt = 0; attempt < 6; attempt++) {
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

async function capture(name, center, extra) {
  const dir = new URL(`../examples/${name}/`, import.meta.url);
  await mkdir(new URL("terrain/", dir), { recursive: true });
  console.log(`${name}: Overpass around ${center.lat}, ${center.lon} (${RADIUS_M} m)`);
  const { json, url } = await overpass(aroundQuery(center.lat, center.lon, RADIUS_M));
  const fetchedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  await writeFile(new URL("osm.json", dir), JSON.stringify({ fetchedAt, source: url, center, radiusM: RADIUS_M, query: aroundQuery(center.lat, center.lon, RADIUS_M), ...json }));
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
- The claim, people and vehicles in scene.json are made up. The place is a public road; no house numbers or personal data.
${extra ?? ""}`);
  const ways = json.elements.filter((e) => e.type === "way");
  console.log(`  ${ways.filter((w) => w.tags?.highway).length} roads, ${ways.filter((w) => w.tags?.building).length} buildings, ${ways.filter((w) => w.tags?.amenity === "parking").length} parking areas, ${tiles.length} terrain tiles`);
}

async function findTurnpikePoint() {
  const { json } = await overpass('[out:json][timeout:60];way(around:5000,42.7576,-71.4676)["highway"="motorway"]["oneway"="yes"];out center tags;');
  const ways = json.elements.filter((e) => /everett|turnpike/i.test(e.tags?.name ?? "") || /US 3/.test(e.tags?.ref ?? ""));
  ways.sort((a, b) => (Number(b.tags?.lanes ?? 0) - Number(a.tags?.lanes ?? 0)));
  const w = ways[0];
  if (!w) throw new Error("no turnpike way found");
  console.log(`turnpike way ${w.id} ${w.tags.name ?? ""} ${w.tags.ref ?? ""} lanes=${w.tags.lanes ?? "?"} at ${w.center.lat}, ${w.center.lon}`);
  return { lat: Number(w.center.lat.toFixed(6)), lon: Number(w.center.lon.toFixed(6)) };
}

// Centers are points on the road itself (the pin), so the area is centered on the crash.
const only = process.argv[2];
if (!only || only === "t-bone") await capture("t-bone-intersection", { lat: 42.7627323, lon: -71.4661324 }, "- Crossing: Main Street and Park Street, Nashua NH (OSM node 41597445).\n");
if (!only || only === "highway") await capture("highway-rear-end", { lat: 42.7612264, lon: -71.4932055 }, "- F.E. Everett Turnpike (US 3) northbound, Nashua NH (on OSM way 909188998).\n");
if (only === "find-turnpike") await findTurnpikePoint();
// The parking example was re-captured on 2026-10-09 through the proxy itself (/api/geo/overpass and /api/geo/terrain, run
// in-process), around a pin on parking aisle w105821533 in the Target lot on Amherst Street (OSM parking area w105821547).
if (!only || only === "parking") await capture("parking-lot-backing", { lat: 42.7986815, lon: -71.5349255 }, "- Retail parking lot (Target, Amherst Street), Nashua NH: OSM parking area w105821547, pin on parking aisle w105821533.\n");
console.log("done");
