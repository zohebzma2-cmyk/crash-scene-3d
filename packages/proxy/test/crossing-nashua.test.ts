import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROXY_ROUTES, type PlaceResult, type ProxyError } from "@csd/core";
import { splitCrossingQuery } from "@csd/mapdata";
import { createProxy } from "../src";
import { kvOnBlobs, type BlobStoreLike } from "../src/blobs";
import { MIRROR_URLS, config, hang, jsonResponse, settle, setup, START, type Call } from "./helpers";

// Real responses recorded from Nominatim and Overpass for "Main St and Amherst St, Nashua NH"
// (see packages/mapdata/test/fixtures/ATTRIBUTION.md).
const dir = fileURLToPath(new URL("../../mapdata/test/fixtures/", import.meta.url));
const nominatim = JSON.parse(readFileSync(`${dir}nominatim-nashua-nh.json`, "utf8")) as unknown;
const overpass = JSON.parse(readFileSync(`${dir}overpass-main-amherst-nashua.json`, "utf8")) as {
  elements: { nodes: number[]; geometry: { lat: number; lon: number }[] }[];
};
const JUNCTION = (() => {
  for (const w of overpass.elements) {
    const i = w.nodes.indexOf(41353060);
    if (i >= 0) return w.geometry[i]!;
  }
  throw new Error("fixture has no junction node");
})();

beforeEach(() => { vi.useFakeTimers({ now: START }); });
afterEach(() => { vi.useRealTimers(); });

/** What the services say: recorded Nominatim for any search, recorded Overpass for any query. */
const recorded = (c: Call) => (c.url.includes("nominatim") ? jsonResponse(nominatim) : jsonResponse(overpass));

const crossingUrl = (typed: string) => {
  const parts = splitCrossingQuery(typed)!;
  return `${PROXY_ROUTES.crossing}?${new URLSearchParams({ a: parts.a, b: parts.b, near: parts.near })}`;
};

describe("the exact trial search against recorded service responses", () => {
  it("'Main St and Amherst St, Nashua NH' → the Main St / Amherst St junction, sent upstream as expected", async () => {
    const t = setup(recorded);
    const res = await settle(t.get("/api/geo/crossing?a=Main%20St&b=Amherst%20St&near=Nashua%20NH"));
    expect(res.status).toBe(200);
    const [hit, ...rest] = (await res.json()) as PlaceResult[];
    expect(rest).toEqual([]);
    expect(hit).toMatchObject({
      kind: "crossing", streets: ["Main Street", "Amherst Street"], label: "Main Street & Amherst Street, Nashua NH",
      lat: JUNCTION.lat, lon: JUNCTION.lon,
    });
    expect(hit!.approximate).toBeUndefined(); // a real shared OSM node, not a closest approach

    // What the proxy asked of Nominatim and Overpass.
    const geocode = new URL(t.calls[0]!.url);
    expect(geocode.origin + geocode.pathname).toBe("https://nominatim.openstreetmap.org/search");
    expect(Object.fromEntries(geocode.searchParams)).toEqual({ q: "Nashua NH", format: "jsonv2", limit: "1", addressdetails: "1" });
    const query = new URLSearchParams(t.calls[1]!.body).get("data")!;
    expect(t.calls[1]!.url).toBe(MIRROR_URLS[0]);
    expect(query).toContain("around:1500,42.7656251,-71.4677032");
    expect(query).toMatch(/\["name"~"mai",i\]/);
    expect(query).toMatch(/\["name"~"\(amh\|erst\)",i\]/);
    expect(query.length).toBeLessThan(600);
    expect(t.calls).toHaveLength(2); // nothing else: the plain-search fallback isn't needed
  });

  it.each([
    "Main St and Amherst St, Nashua NH",
    "Main St & Amherst St, Nashua NH",
    "Main Street and Amherst Street, Nashua NH",
    "main st & amherst st, nashua nh",
    "Main St / Amherst St, Nashua NH",
    "corner of Main St and Amherst St, Nashua, NH 03060",
  ])("%s → the junction", async (typed) => {
    const t = setup(recorded);
    const res = await settle(t.get(crossingUrl(typed)));
    expect(res.status).toBe(200);
    const [hit] = (await res.json()) as PlaceResult[];
    expect(hit).toMatchObject({ kind: "crossing", lat: JUNCTION.lat, lon: JUNCTION.lon, streets: ["Main Street", "Amherst Street"] });
  });

  it("without a place there is nothing to search around: the answer is an honest empty list from the plain search", async () => {
    const t = setup((c) => (c.url.includes("nominatim") ? jsonResponse([]) : jsonResponse(overpass)));
    const res = await settle(t.get(crossingUrl("Main Street and Amherst Street")));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
    expect(t.calls.every((c) => c.url.includes("nominatim"))).toBe(true);
  });
});

/** The real Nominatim finds the city, but returns nothing for the street pair itself. */
const cityOnly = (c: Call) => jsonResponse(new URL(c.url).searchParams.get("q") === "Nashua NH" ? nominatim : []);

describe("failures are reported, not hidden", () => {
  it("every Overpass mirror down and the plain search empty → a timeout/upstream error, not an empty 200", async () => {
    const t = setup((c) => (c.url.includes("nominatim") ? cityOnly(c) : new Response("<html>500</html>", { status: 500 })));
    const res = await settle(t.get(crossingUrl("Main St and Amherst St, Nashua NH")));
    expect(res.status).toBe(502);
    const err = (await res.json()) as ProxyError;
    expect(err.code).toBe("upstream");
    // The failed answer isn't cached either: once Overpass is back, the same search works.
    expect(t.setKeys.some((k) => k.startsWith("geo/crossing?"))).toBe(false);
  });

  it("Overpass hanging → the timeout error inside the 8 s deadline", async () => {
    const t = setup((c, s) => (c.url.includes("nominatim") ? cityOnly(c) : hang(c, s)));
    const res = await settle(t.get(crossingUrl("Main St and Amherst St, Nashua NH")));
    expect(res.status).toBe(504);
    expect(((await res.json()) as ProxyError).code).toBe("timeout");
    expect(Date.now() - START).toBeLessThanOrEqual(8100);
  });

  it("a plain search that does find something still wins over the error (the place itself)", async () => {
    const t = setup((c) => (c.url.includes("nominatim") ? jsonResponse(nominatim) : new Response("x", { status: 500 })));
    const res = await settle(t.get(crossingUrl("Main St and Amherst St, Nashua NH")));
    expect(res.status).toBe(200);
    expect(((await res.json()) as PlaceResult[])[0]!.kind).toBe("city");
  });
});

describe("the search area", () => {
  it("looks around the place first (1500 m), and only widens to 5000 m when nothing was found", async () => {
    let overpassCalls = 0;
    const t = setup((c) => {
      if (c.url.includes("nominatim")) return jsonResponse(nominatim);
      overpassCalls++;
      return overpassCalls === 1 ? jsonResponse({ elements: [] }) : jsonResponse(overpass);
    });
    const res = await settle(t.get(crossingUrl("Main St and Amherst St, Nashua NH")));
    const [hit] = (await res.json()) as PlaceResult[];
    expect(hit).toMatchObject({ kind: "crossing", lat: JUNCTION.lat, lon: JUNCTION.lon });
    const radii = t.calls.filter((c) => c.url.includes("overpass")).map((c) => /around:(\d+)/.exec(new URLSearchParams(c.body).get("data")!)![1]);
    expect(radii).toEqual(["1500", "5000"]);
  });

  it("does not widen when the first look already found the crossing", async () => {
    const t = setup(recorded);
    await settle(t.get(crossingUrl("Main St and Amherst St, Nashua NH")));
    expect(t.calls.filter((c) => c.url.includes("overpass"))).toHaveLength(1);
  });
});

// Netlify's local sandbox returns no ETag on Blobs reads. Found live: after the first search every
// later one was refused with 429 "busy" for good, because a slot that already existed could never
// be taken again.
describe("several searches in a row on a Blobs store whose reads have no ETag (netlify dev)", () => {
  function sandboxBlobs(): BlobStoreLike {
    const data = new Map<string, { data: string | ArrayBuffer; metadata: Record<string, unknown> }>();
    return {
      async getWithMetadata(key: string, opts: { type: "arrayBuffer" | "text" }) {
        const e = data.get(key);
        return e ? { data: opts.type === "text" ? String(e.data) : (e.data as ArrayBuffer), metadata: e.metadata } : null;
      },
      async set(key: string, value: string | ArrayBuffer, opts: { metadata?: Record<string, unknown>; onlyIfNew?: boolean; onlyIfMatch?: string } = {}) {
        if (opts.onlyIfNew && data.has(key)) return { modified: false };
        if (opts.onlyIfMatch !== undefined && opts.onlyIfMatch !== "" && !data.has(key)) return { modified: false };
        data.set(key, { data: value, metadata: opts.metadata ?? {} });
        return { modified: true };
      },
      async delete(key: string) { data.delete(key); },
    } as BlobStoreLike;
  }

  it("keeps answering", async () => {
    const calls: Call[] = [];
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = { url: String(input), method: init?.method ?? "GET", headers: new Headers(init?.headers), body: typeof init?.body === "string" ? init.body : undefined };
      calls.push(call);
      return recorded(call);
    }) as typeof globalThis.fetch;
    const geo = sandboxBlobs();
    const store = kvOnBlobs({ cache: sandboxBlobs(), slots: sandboxBlobs(), geoStore: () => geo, userStore: () => sandboxBlobs(), listStores: async () => [], deleteStore: async () => undefined, allowUnconditional: true });
    const proxy = createProxy(config, { fetch, store, now: () => Date.now(), userKey: () => "same-user" });
    for (const typed of ["Main St and Amherst St, Nashua NH", "Main Street & Amherst Street, Nashua NH", "Amherst St / Main St, Nashua NH"]) {
      const res = await settle(proxy(new Request(`https://app.test${crossingUrl(typed)}`)));
      expect(res.status, typed).toBe(200);
      expect(((await res.json()) as PlaceResult[])[0]!.kind, typed).toBe("crossing");
      await vi.advanceTimersByTimeAsync(2000);
    }
  });
});
