import { describe, expect, it, vi } from "vitest";
import { BUSY_MESSAGE, PROXY_ROUTES } from "@csd/core";
import { createServices } from "../src/services";
import { fakeMergeSearchResults, fakeSplitCrossingQuery } from "../src/services/fakes";
import { createGeoService, crossStreetsUrl, searchUrl, suggestUrl } from "../src/services/geo";
import { ServiceError } from "../src/services/types";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const place = (label: string, lat = 42.76, lon = -71.46) => ({ label, main: label, sub: "Nashua, NH", lat, lon, kind: "road" });

function geo(handler: (url: string, init?: RequestInit) => Response | Promise<Response> = () => json([place("Main Street")])) {
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => handler(url, init));
  return { svc: createGeoService(fetchFn, { splitCrossing: fakeSplitCrossingQuery, mergeResults: fakeMergeSearchResults }), fetchFn };
}

describe("suggest (/api/geo/suggest)", () => {
  it("asks our own origin with the text, a limit and the rounded bias, as the proxy expects", async () => {
    const { svc, fetchFn } = geo();
    await svc.suggest("Main Str", { bias: { lat: 42.76273, lon: -71.46613 } });
    const url = new URL(String(fetchFn.mock.calls[0]?.[0]), "http://x");
    expect(url.pathname).toBe("/api/geo/suggest");
    expect(url.searchParams.get("q")).toBe("Main Str");
    expect(url.searchParams.get("limit")).toBe("6");
    expect(url.searchParams.get("lat")).toBe("42.76273");
    expect(url.searchParams.get("lon")).toBe("-71.46613");
    expect(suggestUrl("x y", null)).not.toContain("lat=");
  });

  it("needs 3 characters, and answers repeats from the session cache (a nearby bias is the same search)", async () => {
    const { svc, fetchFn } = geo();
    expect(await svc.suggest("Ma")).toEqual([]);
    expect(await svc.suggest("  ")).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
    await svc.suggest("Main Street", { bias: { lat: 42.7611, lon: -71.4611 } });
    await svc.suggest("main street", { bias: { lat: 42.7649, lon: -71.4649 } });   // same 0.01 degree cell
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await svc.suggest("Main Street", { bias: { lat: 42.9, lon: -71.4 } });        // somewhere else: a new search
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("merges duplicate street pieces and keeps at most the limit", async () => {
    const many = Array.from({ length: 9 }, (_, i) => place(`Street ${i}`, 42.7 + i * 0.01));
    const { svc } = geo(() => json([...many, place("Street 0", 42.7, -71.46)]));
    const out = await svc.suggest("Street");
    expect(out.length).toBe(6);
    expect(new Set(out.map((r) => r.label)).size).toBe(out.length);
  });

  it("aborts when asked: an AbortError for the caller to ignore, not a timeout message", async () => {
    const { svc } = geo((_u, init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))) as never);
    const ctrl = new AbortController();
    const p = svc.suggest("Slow street", { signal: ctrl.signal }).catch((e: unknown) => e);
    ctrl.abort();
    const e = await p;
    expect(e).toBeInstanceOf(DOMException);
    expect((e as DOMException).name).toBe("AbortError");
    const done = new AbortController();
    done.abort();
    await expect(svc.suggest("Already aborted", { signal: done.signal })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not cache a failure, and shows the busy message as text", async () => {
    let n = 0;
    const { svc, fetchFn } = geo(() => (++n === 1 ? json({ code: "busy", message: BUSY_MESSAGE }, 429) : json([place("Elm Street")])));
    await expect(svc.suggest("Elm Street")).rejects.toMatchObject({ message: BUSY_MESSAGE, code: "busy" });
    expect((await svc.suggest("Elm Street")).map((r) => r.label)).toEqual(["Elm Street"]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe("cross streets (/api/geo/cross-streets)", () => {
  const body = { street: "Birchwood Lane", crossings: [{ name: "Quarry Hill Road", lat: 44.2, lon: -72.6, points: [{ lat: 44.2, lon: -72.6 }], osmWayIds: [5], place: "Fairview" }, { nope: true }] };

  it("sends the street, the point and the exact OSM ways, and keeps only well-formed crossings", async () => {
    const { svc, fetchFn } = geo(() => json(body));
    const r = await svc.crossStreets("Birchwood Lane", { lat: 44.20123, lon: -72.60123 }, { ways: [11, 22] });
    const url = new URL(String(fetchFn.mock.calls[0]?.[0]), "http://x");
    expect(url.pathname).toBe("/api/geo/cross-streets");
    expect(url.searchParams.get("street")).toBe("Birchwood Lane");
    expect(url.searchParams.get("near")).toBe("44.20123,-72.60123");
    expect(url.searchParams.get("ways")).toBe("11,22");
    expect(r.crossings.map((c) => c.name)).toEqual(["Quarry Hill Road"]);
    expect(crossStreetsUrl("x", null)).not.toContain("near=");
  });

  it("caches per street, place and ways, and treats an empty street as nothing", async () => {
    const { svc, fetchFn } = geo(() => json(body));
    await svc.crossStreets("Birchwood Lane", { lat: 44.2, lon: -72.6 });
    await svc.crossStreets("birchwood lane", { lat: 44.2, lon: -72.6 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await svc.crossStreets("Birchwood Lane", { lat: 44.2, lon: -72.6 }, { ways: [1] });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(await svc.crossStreets("  ", null)).toEqual({ street: "", crossings: [] });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("an empty answer means nothing crosses, and an error stays an error", async () => {
    expect((await geo(() => json({ street: "X", crossings: [] })).svc.crossStreets("X Street", null)).crossings).toEqual([]);
    await expect(geo(() => json({ code: "upstream", message: "Overpass is busy." }, 502)).svc.crossStreets("X Street", null)).rejects.toBeInstanceOf(ServiceError);
  });
});

describe("fixtures mode (cached examples, no network)", () => {
  const near = { lat: 42.7627323, lon: -71.4661324 };       // the t-bone example's pin: Main Street at Park Street
  const fx = () => {
    const fetchSpy = vi.fn(async () => { throw new Error("no network in fixtures mode"); });
    return { services: createServices({ fixtures: true, fetch: fetchSpy as unknown as typeof fetch }), fetchSpy };
  };

  it("suggests the example streets with 'Town, State', nearest the bias first", async () => {
    const { services, fetchSpy } = fx();
    const out = await services.geo.suggest("main str", { bias: near });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]).toMatchObject({ main: "Main Street", sub: "Nashua, NH", category: "street" });
    expect(await services.geo.suggest("ma")).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("lists the streets that really cross Main Street, each with a crossing point on the road data", async () => {
    const { services, fetchSpy } = fx();
    const r = await services.geo.crossStreets("Main Street", near);
    const names = r.crossings.map((c) => c.name);
    expect(names).toContain("Park Street");
    expect(names).not.toContain("Main Street");
    const park = r.crossings.find((c) => c.name === "Park Street")!;
    // the example pin is the Main and Park crossing: the point is within a few meters of it
    const meters = Math.hypot((park.lat - near.lat) * 111_320, (park.lon - near.lon) * 111_320 * Math.cos((near.lat * Math.PI) / 180));
    expect(meters).toBeLessThan(15);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("knows the claim's town as a place ('Nashua, NH'), so the crossing search can start from it", async () => {
    const { services } = fx();
    const out = await services.geo.suggest("Nashua, NH");
    expect(out[0]).toMatchObject({ main: "Nashua", sub: "Nashua, NH", category: "place" });
    expect(Number.isFinite(out[0]?.lat)).toBe(true);
  });

  it("says nothing crosses a street that isn't there", async () => {
    const { services } = fx();
    expect((await services.geo.crossStreets("Nowhere Boulevard", near)).crossings).toEqual([]);
  });
});

describe("what we send the proxy", () => {
  it("uses the routes from @csd/core, so a rename there is one change", () => {
    expect(PROXY_ROUTES.suggest).toBe("/api/geo/suggest");
    expect(PROXY_ROUTES.crossStreets).toBe("/api/geo/cross-streets");
    expect(PROXY_ROUTES.crossing).toBe("/api/geo/crossing");
    expect(suggestUrl("main", null).startsWith(`${PROXY_ROUTES.suggest}?`)).toBe(true);
    expect(crossStreetsUrl("main", null).startsWith(`${PROXY_ROUTES.crossStreets}?`)).toBe(true);
  });

  it("suggest sends the map view as west,south,east,north, and a different view is a different search", async () => {
    const { svc, fetchFn } = geo();
    await svc.suggest("Main Street", { bbox: [-71.5, 42.7, -71.4, 42.8] });
    const url = new URL(String(fetchFn.mock.calls[0]?.[0]), "http://x");
    expect(url.searchParams.get("bbox")).toBe("-71.50000,42.70000,-71.40000,42.80000");
    expect(suggestUrl("main", null, null)).not.toContain("bbox=");
    await svc.suggest("Main Street", { bbox: [-71.5, 42.7, -71.4, 42.8] });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await svc.suggest("Main Street", { bbox: [-72.5, 41.7, -72.4, 41.8] });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("an 'A and B' search with no town sends the bias as lat and lon on /api/geo/crossing", async () => {
    const { svc, fetchFn } = geo(() => json([place("Main Street & Park Street")]));
    await svc.search("Main Street and Park Street", { bias: { lat: 42.7627323, lon: -71.4661324 } });
    const url = new URL(String(fetchFn.mock.calls[0]?.[0]), "http://x");
    expect(url.pathname).toBe(PROXY_ROUTES.crossing);
    expect(url.searchParams.get("a")).toBe("Main Street");
    expect(url.searchParams.get("b")).toBe("Park Street");
    expect(url.searchParams.get("lat")).toBe("42.76273");
    expect(url.searchParams.get("lon")).toBe("-71.46613");
    expect(searchUrl("Main Street and Park Street", fakeSplitCrossingQuery)).not.toContain("lat=");
  });
});
