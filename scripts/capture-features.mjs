// One manual recapture of the three public-road examples, through our local proxy.
// No environment files, tiles, terrain, geocoding or vehicle services are touched.
import { build } from "rolldown";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { minimizeExampleCache } from "./example-cache-policy.mjs";
const output = "/private/tmp/csd-feature-proxy.mjs";
await build({ input: "packages/proxy/src/index.ts", platform: "node", output: { file: output, format: "esm" } });
const { createProxy, defaultProviderConfig, memoryStore } = await import(pathToFileURL(output).href);
const config = defaultProviderConfig();
const proxy = createProxy(config, { fetch, store: memoryStore(), now: Date.now, userKey: () => "synthetic-fixture-capture" });
const server = createServer(async (req, res) => {
  if (!req.url?.startsWith("/api/geo/overpass?")) { res.writeHead(404).end(); return; }
  const response = await proxy(new Request(`http://127.0.0.1:4197${req.url}`));
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(4197, "127.0.0.1", resolve); });
try {
  for (const name of ["t-bone-intersection", "highway-rear-end", "parking-lot-backing"]) {
    const path = new URL(`../examples/${name}/osm.json`, import.meta.url);
    const old = JSON.parse(await readFile(path, "utf8"));
    const params = new URLSearchParams({ lat: String(old.center.lat), lon: String(old.center.lon), radius: String(old.radiusM) });
    const response = await fetch(`http://127.0.0.1:4197/api/geo/overpass?${params}`);
    if (!response.ok) throw new Error(`${name}: proxy HTTP ${response.status}`);
    const data = await response.json();
    const scene = JSON.parse(await readFile(new URL(`../examples/${name}/scene.json`, import.meta.url), "utf8"));
    await writeFile(path, JSON.stringify(minimizeExampleCache(data, scene.location)));
    console.log(`${name}: ${data.elements.length} OSM elements, ${data.elements.filter((e) => e.type === "node").length} nodes; ${data.fetchedAt}`);
    await new Promise((resolve) => setTimeout(resolve, 1100));
  }
} finally { await new Promise((resolve) => server.close(resolve)); }
