// A fake /api/vehicles for e2e: the REAL proxy code (createProxy with defaultProviderConfig, so the real
// limits, cache and messages) running in the test process, with a made-up vPIC behind it. Playwright routes the
// page's /api/vehicles/* requests to it. Nothing leaves the machine.
import type { BrowserContext, Page } from "@playwright/test";
import { createProxy, defaultProviderConfig, memoryStore } from "../packages/proxy/src/index";

/** Made-up vPIC lists (public make and model names only). */
const MAKES = ["CHEVROLET", "FORD", "HONDA", "TOYOTA"];
const MODELS: Record<string, Partial<Record<"car" | "mpv" | "truck" | "motorcycle", string[]>>> = {
  chevrolet: { car: ["Malibu"], mpv: ["Equinox"], truck: ["Silverado 1500", "Colorado"] },
  ford: { car: ["Fusion"], mpv: ["Escape"], truck: ["F-150"] },
  honda: { car: ["Accord", "Civic"], mpv: ["CR-V", "Odyssey"] },
  toyota: { car: ["Camry"], mpv: ["RAV4"], truck: ["Tacoma"] },
};
const TYPE_NAME = { car: "Passenger Car", mpv: "Multipurpose Passenger Vehicle (MPV)", truck: "Truck", motorcycle: "Motorcycle" } as const;

function fakeVpic(latencyMs: number): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL) => {
    await new Promise((r) => setTimeout(r, latencyMs));
    const url = new URL(String(input));
    const body = (results: unknown[]) => new Response(JSON.stringify({ Results: results }), { status: 200, headers: { "content-type": "application/json" } });
    if (url.pathname.includes("/GetMakesForVehicleType/")) return body(MAKES.map((MakeName) => ({ MakeName })));
    const m = /\/GetModelsForMakeYear\/make\/([^/]+)\/modelyear\/\d+\/vehicletype\/(\w+)$/.exec(url.pathname);
    if (m) {
      // vPIC matches the make text loosely ("chev" finds Chevrolet); so does this fake.
      const typed = decodeURIComponent(m[1]!).toLowerCase();
      const kind = m[2] as keyof typeof TYPE_NAME;
      const make = Object.keys(MODELS).find((k) => k.startsWith(typed));
      return body((make ? MODELS[make]?.[kind] ?? [] : []).map((Model_Name) => ({ Model_Name, VehicleTypeName: TYPE_NAME[kind] })));
    }
    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;
}

export interface ApiSeen { readonly path: string; readonly status: number }

/**
 * Route the page's /api/vehicles/* to a fresh real proxy (cold cache, real limits) over the fake vPIC.
 * Returns every answer it gave, and every vPIC call it made.
 */
export async function routeVehiclesToFakeProxy(page: Page | BrowserContext, opts: { latencyMs?: number } = {}): Promise<{ answers: ApiSeen[]; upstream: string[] }> {
  const upstream: string[] = [];
  const vpic = fakeVpic(opts.latencyMs ?? 150);
  const proxy = createProxy(defaultProviderConfig(), {
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => { upstream.push(String(input)); return vpic(input, init); }) as typeof globalThis.fetch,
    store: memoryStore(),
    now: () => Date.now(),
    // One browser is one person to the limiter.
    userKey: () => "e2e-claimant",
  });
  const answers: ApiSeen[] = [];
  await page.route("**/api/vehicles/**", async (route) => {
    const req = route.request();
    const res = await proxy(new Request(req.url(), { method: req.method() }));
    const u = new URL(req.url());
    answers.push({ path: `${u.pathname}${u.search}`, status: res.status });
    await route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers.entries()), body: Buffer.from(await res.arrayBuffer()) });
  });
  return { answers, upstream };
}

/** How the fake Photon answers one query: after `ms` (Infinity: never), with these GeoJSON features. */
export interface PhotonAnswer { readonly ms: number; readonly features: readonly unknown[] }

export interface FakeGeo {
  /** Photon's answer to a query other than the claim's town ("Nashua, NH", answered at once). */
  readonly photon: (q: string) => PhotonAnswer;
  /** While this says so, Photon's token buckets are empty: the proxy answers type-ahead with "busy". */
  readonly photonBusy?: () => boolean;
}

/** A GeoJSON feature as Photon sends it (public place and street names only). */
export const photonFeature = (props: Record<string, unknown>, lon: number, lat: number) => ({
  type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] },
  properties: { countrycode: "US", state: "New Hampshire", ...props },
});
const NASHUA = photonFeature({ type: "city", osm_key: "place", osm_value: "city", name: "Nashua" }, -71.4677, 42.7656);
/** The on-submit search's answer (Nominatim), whatever was typed: a street in Nashua. */
const NOMINATIM_ROWS = [{
  lat: "42.7627", lon: "-71.4661", display_name: "Elm Street, Nashua, Hillsborough County, New Hampshire, United States",
  name: "Elm Street", type: "residential", addresstype: "road", address: { road: "Elm Street", city: "Nashua", state: "New Hampshire" },
}];

function fakeGeoUpstream(geo: FakeGeo): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
    if (url.hostname.includes("nominatim")) return json(NOMINATIM_ROWS);
    if (!url.hostname.includes("photon")) return new Response("not part of this fake", { status: 500 });
    const q = url.searchParams.get("q") ?? "";
    const answer = q === "Nashua, NH" ? { ms: 50, features: [NASHUA] } : geo.photon(q);
    return new Promise<Response>((resolve, reject) => {
      const timer = Number.isFinite(answer.ms) ? setTimeout(() => resolve(json({ type: "FeatureCollection", features: answer.features })), answer.ms) : undefined;
      init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("aborted", "AbortError")); });
    });
  }) as typeof globalThis.fetch;
}

/**
 * Route the page's /api/geo/* to a fresh real proxy (its real 7 s type-ahead limit, cold cache, real limits) over a
 * fake Photon and Nominatim, for a page opened with ?geo=proxy. Returns every answer it gave and every upstream call.
 */
export async function routeGeoToFakeProxy(page: Page | BrowserContext, geo: FakeGeo): Promise<{ answers: ApiSeen[]; upstream: string[] }> {
  const upstream: string[] = [];
  const fake = fakeGeoUpstream(geo);
  const inner = memoryStore();
  const proxy = createProxy(defaultProviderConfig(), {
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => { upstream.push(String(input)); return fake(input, init); }) as typeof globalThis.fetch,
    // An empty Photon bucket says "try again in 5 s", longer than the proxy waits: the answer is "busy".
    store: { ...inner, takeToken: (k, n, l) => (geo.photonBusy?.() && k.includes("photon") ? Promise.resolve(5000) : inner.takeToken(k, n, l)) },
    now: () => Date.now(),
    userKey: () => "e2e-claimant",
  });
  const answers: ApiSeen[] = [];
  await page.route("**/api/geo/**", async (route) => {
    const req = route.request();
    const res = await proxy(new Request(req.url(), { method: req.method() }));
    const u = new URL(req.url());
    answers.push({ path: `${u.pathname}${u.search}`, status: res.status });
    await route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers.entries()), body: Buffer.from(await res.arrayBuffer()) });
  });
  return { answers, upstream };
}
