// @vitest-environment jsdom
// The whole search, the way Zoheb did it live, with the app's real geo service talking to the real proxy (real
// limits, in-memory store) over a fake upstream: type "Main St" slowly, pick Main Street in Nashua, type " and Pa",
// pick Park Street. No answer may be a 429, the first suggestion request must carry the claim town's bias, and
// the pin lands on the crossing. Real timers: the proxy really waits for the caller's Overpass slot.
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROXY_ROUTES } from "@csd/core";
import { createProxy, defaultProviderConfig, memoryStore } from "@csd/proxy";
import { createServices } from "../src/services";
import { all, click, flush, renderApp, setValue, text } from "./helpers";

let app: { unmount: () => void } | null = null;
afterEach(() => { app?.unmount(); app = null; vi.restoreAllMocks(); });

const input = () => document.querySelector<HTMLTextAreaElement>("form[role=search] textarea")!;
const type = async (t: string, wait = 350) => { setValue(input(), t); await flush(0); await flush(wait); };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
const feature = (props: Record<string, unknown>, lon: number, lat: number) => ({
  type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: { countrycode: "US", ...props },
});
const NASHUA = feature({ type: "city", osm_key: "place", osm_value: "city", name: "Nashua", state: "New Hampshire" }, -71.4677, 42.7656);
const MAIN_NASHUA = feature({ type: "street", osm_key: "highway", osm_value: "secondary", osm_type: "W", osm_id: 11, name: "Main Street", city: "Nashua", state: "New Hampshire" }, -71.467, 42.7644);
const MAIN_LYONS = feature({ type: "street", osm_key: "highway", osm_value: "trunk", osm_type: "W", osm_id: 99, name: "Main Street", city: "Lyons", state: "Colorado" }, -105.2663, 40.2235);
// Main Street (way 11) and Park Street (way 20) share node 2.
const CROSS = { elements: [
  { type: "way", id: 11, nodes: [1, 2, 3], geometry: [{ lat: 42.764, lon: -71.4677 }, { lat: 42.7651, lon: -71.4679 }, { lat: 42.766, lon: -71.4681 }], tags: { highway: "secondary", name: "Main Street" } },
  { type: "way", id: 20, nodes: [4, 2, 5], geometry: [{ lat: 42.7652, lon: -71.469 }, { lat: 42.7651, lon: -71.4679 }, { lat: 42.765, lon: -71.4668 }], tags: { highway: "residential", name: "Park Street" } },
] };

function liveServices() {
  const upstreamCalls: string[] = [];
  const upstream = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    upstreamCalls.push(u);
    if (u.includes("photon")) {
      const q = new URL(u).searchParams.get("q") ?? "";
      // Unbiased, "Main St" really does put Lyons, Colorado first.
      return json({ type: "FeatureCollection", features: q.startsWith("Nashua") ? [NASHUA] : [MAIN_LYONS, MAIN_NASHUA] });
    }
    if (u.includes("overpass")) return json((new URLSearchParams(String(init?.body ?? "")).get("data") ?? "").includes("way(id:") ? CROSS : { elements: [] });
    return new Response(PNG, { headers: { "content-type": "image/png" } }); // terrain

  }) as typeof fetch;
  const proxy = createProxy(defaultProviderConfig(), { fetch: upstream, store: memoryStore(), now: () => Date.now(), userKey: () => "claimant" });
  const answers: Array<{ path: string; status: number }> = [];
  // The browser's fetch to its own origin, answered by the proxy (no abort signal: jsdom's isn't Node's).
  const fetchFn = (async (input: string) => {
    const res = await proxy(new Request(`https://app.test${input}`, { headers: { accept: "application/json" } }));
    answers.push({ path: input, status: res.status });
    return res;
  }) as typeof fetch;
  return { services: createServices({ fixtures: false, fetch: fetchFn }), answers, upstreamCalls };
}

describe("a normal search through the real proxy", () => {
  it("never gets a 429, is biased to the claim's town from the first request, and pins the crossing", async () => {
    const { services, answers } = liveServices();
    app = await renderApp(services);
    // Slow typing: every keystroke after the third gets its own pause.
    for (const t of ["Mai", "Main", "Main S", "Main St"]) await type(t);
    const suggests = answers.filter((a) => a.path.startsWith(PROXY_ROUTES.suggest)).map((a) => new URL(a.path, "https://app.test").searchParams);
    expect(suggests[0]?.get("q")).toBe("Nashua, NH");
    expect(suggests.slice(1).every((p) => p.get("lat") === "42.76560" && p.get("lon") === "-71.46770")).toBe(true);
    expect(all("option").map((o) => text(o))).toEqual(["Main StreetNashua, NH", "Main StreetLyons, CO — far from the claim"]);

    click(all("option")[0]!);
    await flush(1500); // the roads preview and the cross streets: two Overpass requests, the second waits its turn
    for (const t of ["Main Street ", "Main Street a", "Main Street an", "Main Street and", "Main Street and ", "Main Street and Pa"]) await type(t, 120);
    await flush(400);
    expect(all("option").map((o) => o.querySelector(".r-main")?.textContent)).toEqual(["Park Street"]);
    click(all("option")[0]!);
    await flush(1500);

    expect(text()).toContain("42.76510, -71.46790");
    expect(answers.filter((a) => a.status === 429)).toEqual([]);
    expect(answers.every((a) => a.status === 200)).toBe(true);
    // No suggestion requests while " and" was typed after the picked street.
    expect(answers.filter((a) => a.path.startsWith(PROXY_ROUTES.suggest)).map((a) => new URL(a.path, "https://app.test").searchParams.get("q")))
      .toEqual(["Nashua, NH", "Mai", "Main", "Main S", "Main St"]);
    // One cross-streets request: none again for the label the pick put in the box.
    expect(answers.filter((a) => a.path.startsWith(PROXY_ROUTES.crossStreets))).toHaveLength(1);
    expect(answers.filter((a) => a.path.startsWith(PROXY_ROUTES.overpass))).toHaveLength(2); // the street's roads, the pin's roads
  }, 20_000);
});
