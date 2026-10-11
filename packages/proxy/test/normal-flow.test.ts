// One claimant's normal search, request by request as the app sends it, against the real limits
// (defaultProviderConfig) on a fake clock: nothing may come back 429. Zoheb's first live session got a 429
// on cross-streets because picking a street asks for the roads around it and, a third of a second later,
// for its cross streets: two Overpass requests, and the caller's 1 req/s slot refused the second at once.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROXY_ROUTES } from "@csd/core";
import { START, config, jsonResponse, settle, setup, type Call } from "./helpers";

beforeEach(() => { vi.useFakeTimers({ now: START }); });
afterEach(() => { vi.useRealTimers(); });

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const photonStreet = {
  type: "FeatureCollection",
  features: [{
    type: "Feature", geometry: { type: "Point", coordinates: [-71.467, 42.7644] },
    properties: { countrycode: "US", state: "New Hampshire", type: "street", osm_key: "highway", osm_value: "secondary", osm_type: "W", osm_id: 11, name: "Main Street", city: "Nashua" },
  }],
};
const upstream = (c: Call) => {
  if (c.url.includes("photon")) return jsonResponse(photonStreet);
  if (c.url.includes("overpass")) return jsonResponse({ elements: [] });
  return new Response(PNG, { headers: { "content-type": "image/png" } });
};

const suggest = (q: string, bias = true) => `${PROXY_ROUTES.suggest}?${new URLSearchParams({ q, limit: "6", ...(bias ? { lat: "42.76560", lon: "-71.46770" } : {}) })}`;
const overpass = (lat: number, lon: number) => `${PROXY_ROUTES.overpass}?lat=${lat}&lon=${lon}&radius=250`;
const crossStreets = `${PROXY_ROUTES.crossStreets}?${new URLSearchParams({ street: "Main Street", near: "42.76440,-71.46700", ways: "11" })}`;
const terrain = (x: number, y: number) => `${PROXY_ROUTES.terrain}/15/${x}/${y}.png`;
const tile = (x: number, y: number) => `${PROXY_ROUTES.tile}/17/${x}/${y}.png`;

/** Send `path` at `ms` after the start (fake clock), without waiting for the answer. */
function claimant(t: ReturnType<typeof setup>) {
  const sent: Array<{ path: string; res: Promise<Response> }> = [];
  return {
    sent,
    async at(ms: number, ...paths: string[]) {
      const wait = START + ms - Date.now();
      if (wait > 0) await vi.advanceTimersByTimeAsync(wait);
      for (const path of paths) sent.push({ path, res: t.get(path, "claimant") });
    },
  };
}

describe("a normal search never hits 429", () => {
  it("claim town, slow typing, pick a street, its roads and cross streets, pick the crossing, the pin's roads and tiles", async () => {
    const t = setup(upstream);
    const c = claimant(t);
    // Typing starts: the claim's town is looked up once.
    await c.at(0, suggest("Nashua, NH", false));
    // "Main St" typed slowly enough that every keystroke after the third gets its own 300 ms pause (worst case).
    await c.at(350, suggest("Mai"));
    await c.at(700, suggest("Main"));
    await c.at(1050, suggest("Main S"));
    await c.at(1400, suggest("Main St"));
    // Pick "Main Street": the roads around it at once, its cross streets after the 300 ms debounce, then terrain.
    await c.at(2000, overpass(42.7644, -71.467));
    await c.at(2300, crossStreets);
    await c.at(2400, ...[0, 1, 2, 3].map((i) => terrain(9877 + (i % 2), 12070 + Math.floor(i / 2))));
    // " and Park" is typed (no requests: the crossings are already loaded), Park Street is picked quickly:
    // the roads at the pin, its terrain, and a map view of tiles.
    await c.at(3200, overpass(42.7651, -71.4679));
    await c.at(3300, ...[0, 1, 2, 3].map((i) => terrain(9878 + (i % 2), 12070 + Math.floor(i / 2))));
    await c.at(3400, ...Array.from({ length: 35 }, (_, i) => tile(39500 + (i % 7), 48280 + Math.floor(i / 7))));

    const res = await settle(Promise.all(c.sent.map((s) => s.res)));
    const refused = c.sent.map((s, i) => `${s.path} → ${res[i]!.status}`).filter((_, i) => res[i]!.status !== 200);
    expect(refused).toEqual([]);

    // Overpass still sees at most one request a second, in total.
    const overpassAt = t.calls.filter((call) => call.url.includes("overpass")).map((call) => call.body);
    expect(overpassAt).toHaveLength(3);
  });

  it("the cross-streets request 300 ms after the street's roads waits for the caller's Overpass slot instead of a 429", async () => {
    const seen: number[] = [];
    const t = setup((call) => { if (call.url.includes("overpass")) seen.push(Date.now()); return upstream(call); });
    const c = claimant(t);
    await c.at(0, overpass(42.7644, -71.467));
    await c.at(300, crossStreets);
    const res = await settle(Promise.all(c.sent.map((s) => s.res)));
    expect(res.map((r) => r.status)).toEqual([200, 200]);
    expect(seen).toHaveLength(2);
    expect(seen[1]! - seen[0]!).toBeGreaterThanOrEqual(config.limits.perUserMinIntervalMs);
  });

  it("a caller who really floods Overpass is still told to wait", async () => {
    const t = setup(upstream);
    const c = claimant(t);
    await c.at(0, ...[0, 1, 2, 3, 4].map((i) => overpass(42.76 + i / 100, -71.46)));
    const res = await settle(Promise.all(c.sent.map((s) => s.res)));
    expect(res.filter((r) => r.status === 200).length).toBeLessThanOrEqual(3);
    expect(res.some((r) => r.status === 429)).toBe(true);
  });
});
