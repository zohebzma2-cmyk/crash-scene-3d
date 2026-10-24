import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUSY_MESSAGE, PROXY_ROUTES, TIMEOUT_MESSAGE, type PlaceResult, type ProxyError } from "@csd/core";
import { MIRROR_HOSTS, MIRROR_URLS, START, config, hang, jsonResponse, nominatimRows, settle, setup, type Call } from "./helpers";

beforeEach(() => { vi.useFakeTimers({ now: START }); });
afterEach(() => { vi.useRealTimers(); });

const DAY_MS = 86_400_000;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG2 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9]);
const png = (headers: Record<string, string> = {}, bytes: Uint8Array = PNG) => new Response(bytes as BodyInit, { headers: { "content-type": "image/png", ...headers } });
const TILE = `${PROXY_ROUTES.tile}/15/9878/12070.png`;
const TERRAIN = `${PROXY_ROUTES.terrain}/15/9878/12070.png`;
const search = (q: string) => `${PROXY_ROUTES.search}?q=${encodeURIComponent(q)}`;

describe("tile caching honours the provider's HTTP caching", () => {
  it("serves a fresh tile with no upstream call and no token, and tells the browser to cache it for 7 days", async () => {
    const t = setup(() => png({ etag: '"v1"', "last-modified": "Mon, 01 Jun 2026 00:00:00 GMT", "cache-control": "max-age=3600" }));
    const first = await settle(t.get(TILE, "u1"));
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("public, max-age=604800");
    expect(first.headers.get("etag")).toBe('"v1"');
    const tokensBefore = t.tokenCalls.length;
    expect(tokensBefore).toBe(2); // one per-user, one global, for the one real upstream call

    // Well past the provider's 1 hour, inside our 7 days: still fresh.
    await vi.advanceTimersByTimeAsync(6 * DAY_MS);
    const hit = await settle(t.get(TILE, "u2"));
    expect(hit.headers.get("x-proxy-cache")).toBe("hit");
    expect(new Uint8Array(await hit.arrayBuffer())).toEqual(PNG);
    expect(t.calls).toHaveLength(1);
    expect(t.tokenCalls).toHaveLength(tokensBefore);
    expect(t.slotCalls).toHaveLength(0);
  });

  it("revalidates an expired tile with If-None-Match; a 304 refreshes it without re-downloading", async () => {
    let revalidations = 0;
    const t = setup((c) => {
      if (c.headers.get("if-none-match")) {
        revalidations++;
        expect(c.headers.get("if-none-match")).toBe('"v1"');
        return new Response(null, { status: 304, headers: { etag: '"v1"' } });
      }
      return png({ etag: '"v1"', "cache-control": "max-age=3600" });
    });
    await settle(t.get(TILE, "u1"));
    await vi.advanceTimersByTimeAsync(8 * DAY_MS);

    const res = await settle(t.get(TILE, "u2"));
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG); // stored bytes, not re-downloaded
    expect(revalidations).toBe(1);
    expect(t.calls).toHaveLength(2);
    expect(Date.parse(res.headers.get("x-fetched-at")!)).toBeGreaterThanOrEqual(START + 8 * DAY_MS); // refreshed, not the original fetch time

    // The 304 made it fresh again for another 7 days: no further upstream call.
    await vi.advanceTimersByTimeAsync(3 * DAY_MS);
    const again = await settle(t.get(TILE, "u3"));
    expect(again.headers.get("x-proxy-cache")).toBe("hit");
    expect(t.calls).toHaveLength(2);
  });

  it("uses If-Modified-Since when the provider sent no ETag", async () => {
    const lm = "Mon, 01 Jun 2026 00:00:00 GMT";
    const t = setup((c) => (c.headers.get("if-modified-since") === lm ? new Response(null, { status: 304 }) : png({ "last-modified": lm })));
    await settle(t.get(TILE, "u1"));
    await vi.advanceTimersByTimeAsync(8 * DAY_MS);
    const res = await settle(t.get(TILE, "u2"));
    expect(res.status).toBe(200);
    expect(t.calls[1]!.headers.get("if-modified-since")).toBe(lm);
    expect(t.calls[1]!.headers.get("if-none-match")).toBeNull();
  });

  it("replaces the bytes only when the revalidation answers 200", async () => {
    let version = 1;
    const t = setup((c) => (version === 1 ? png({ etag: '"v1"' }) : (expect(c.headers.get("if-none-match")).toBe('"v1"'), png({ etag: '"v2"' }, PNG2))));
    await settle(t.get(TILE, "u1"));
    version = 2;
    await vi.advanceTimersByTimeAsync(8 * DAY_MS);
    const res = await settle(t.get(TILE, "u2"));
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG2);
    expect(res.headers.get("etag")).toBe('"v2"');
  });

  it("keeps a tile as long as the provider's max-age says when that is longer than 7 days", async () => {
    const t = setup(() => png({ "cache-control": "public, max-age=2592000" })); // 30 days
    await settle(t.get(TILE, "u1"));
    await vi.advanceTimersByTimeAsync(20 * DAY_MS);
    expect((await settle(t.get(TILE, "u2"))).headers.get("x-proxy-cache")).toBe("hit");
    expect(t.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(11 * DAY_MS);
    await settle(t.get(TILE, "u3"));
    expect(t.calls).toHaveLength(2);
  });

  it("also honours Expires", async () => {
    const t = setup(() => png({ expires: new Date(START + 20 * DAY_MS).toUTCString() }));
    await settle(t.get(TILE, "u1"));
    await vi.advanceTimersByTimeAsync(15 * DAY_MS);
    await settle(t.get(TILE, "u2"));
    expect(t.calls).toHaveLength(1);
  });

  it("never caches a response marked no-store", async () => {
    const t = setup(() => png({ "cache-control": "no-store" }));
    const a = await settle(t.get(TILE, "u1"));
    expect(a.status).toBe(200); // still served to this caller
    expect(await t.store.get(`tile/15/9878/12070`)).toBeNull();
    await settle(t.get(TILE, "u2"));
    expect(t.calls).toHaveLength(2);
  });

  it("keeps terrain tiles at least 30 days", async () => {
    const t = setup(() => png({ etag: '"t1"', "cache-control": "max-age=60" }));
    await settle(t.get(TERRAIN, "u1"));
    await vi.advanceTimersByTimeAsync(29 * DAY_MS);
    expect((await settle(t.get(TERRAIN, "u2"))).headers.get("x-proxy-cache")).toBe("hit");
    expect(t.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2 * DAY_MS);
    const res = await settle(t.get(TERRAIN, "u3"));
    expect(res.status).toBe(200);
    expect(t.calls).toHaveLength(2);
    expect(t.calls[1]!.headers.get("if-none-match")).toBe('"t1"');
  });

  it("answers the browser's own conditional request with a bodyless 304", async () => {
    const t = setup(() => png({ etag: '"v1"' }));
    await settle(t.get(TILE, "u1"));
    const res = await t.proxy(new Request(`https://app.test${TILE}`, { headers: { "x-user": "u1", "if-none-match": '"v1"' } }));
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
    expect(t.calls).toHaveLength(1);
  });
});

describe("tile buckets", () => {
  const tiles = (user: number, n: number) => Array.from({ length: n }, (_, i) => `${PROXY_ROUTES.tile}/15/${1000 + i}/${2000 + user}.png`);
  const okTile = () => png();

  it("lets one user burst 40 tiles (one 1440 px map view)", async () => {
    const t = setup(okTile);
    const res = await settle(Promise.all(tiles(1, 40).map((p) => t.get(p, "u1"))));
    expect(res.every((r) => r.status === 200)).toBe(true);
    expect(t.calls).toHaveLength(40);
  });

  it("lets two users burst at the same time under the global cap", async () => {
    const t = setup(okTile);
    const res = await settle(Promise.all([...tiles(1, 40).map((p) => t.get(p, "u1")), ...tiles(2, 40).map((p) => t.get(p, "u2"))]));
    expect(res.every((r) => r.status === 200)).toBe(true);
    expect(t.calls).toHaveLength(80);
  });

  it("refuses a single user beyond burst 64 plus what refills while it waits, with the friendly 429", async () => {
    const t = setup(okTile);
    const res = await settle(Promise.all(tiles(1, 120).map((p) => t.get(p, "u1"))));
    const ok = res.filter((r) => r.status === 200).length;
    expect(ok).toBeGreaterThanOrEqual(64);
    expect(ok).toBeLessThanOrEqual(64 + 16 * 2); // refill 16/s over the ~1.2 s wait
    const busy = res.find((r) => r.status === 429)!;
    expect(await busy.json()).toMatchObject({ code: "busy", message: BUSY_MESSAGE });
    expect(Number(busy.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
  });

  it("caps all users together: the global tile bucket is 256, refilling 64/s", async () => {
    const t = setup(okTile);
    const users = [1, 2, 3, 4, 5, 6]; // 6 × 64 = 384 tiles at once, more than 256 + 64/s × 1.2 s
    const res = await settle(Promise.all(users.flatMap((u) => tiles(u, 64).map((p) => t.get(p, `u${u}`)))));
    const ok = res.filter((r) => r.status === 200).length;
    expect(ok).toBeGreaterThanOrEqual(256);
    expect(ok).toBeLessThanOrEqual(256 + 64 * 2);
    expect(res.some((r) => r.status === 429)).toBe(true);
  });

  it("gives terrain its own global bucket, separate from tiles", async () => {
    const t = setup(okTile);
    await settle(Promise.all([t.get(`${PROXY_ROUTES.tile}/15/1/1.png`, "u1"), t.get(`${PROXY_ROUTES.terrain}/15/1/1.png`, "u1")]));
    expect(t.tokenCalls).toContain("global:tiles");
    expect(t.tokenCalls).toContain("global:terrain");
    expect(t.tokenCalls.filter((k) => k.startsWith("user:u1:"))).toEqual(["user:u1:tiles", "user:u1:terrain"]);
  });
});

describe("search and crossing cache hygiene", () => {
  const crossingPath = `${PROXY_ROUTES.crossing}?a=Main%20St&b=Amherst%20St&near=Nashua%20NH`;
  const O = { lat: 42.7654, lon: -71.4676 };
  const way = (id: number, name: string, pts: [number, number][], nodes: number[]) => ({
    type: "way", id, nodes, tags: { highway: "secondary", name }, geometry: pts.map(([dlat, dlon]) => ({ lat: O.lat + dlat, lon: O.lon + dlon })),
  });
  const crossingJson = { elements: [
    way(1, "Main Street", [[0, -0.01], [0, 0], [0, 0.01]], [10, 500, 11]),
    way(2, "Amherst Street", [[-0.01, 0], [0, 0], [0.01, 0]], [20, 500, 21]),
  ] };

  it("does not cache the plain-search fallback when it stands in for an Overpass failure", async () => {
    let overpassUp = false;
    const t = setup((c) => (c.url.includes("nominatim") ? jsonResponse(nominatimRows) : overpassUp ? jsonResponse(crossingJson) : new Response("down", { status: 503 })));
    const failed = await settle(t.get(crossingPath, "u1"));
    expect(((await failed.json()) as PlaceResult[])[0]!.kind).toBe("city"); // the fallback answer
    overpassUp = true;
    await vi.advanceTimersByTimeAsync(2000);
    const recovered = await settle(t.get(crossingPath, "u2"));
    expect(((await recovered.json()) as PlaceResult[])[0]!.kind).toBe("crossing"); // not stuck with the error fallback
  });

  it("does cache the fallback when Overpass answered and found no crossing", async () => {
    const t = setup((c) => (c.url.includes("nominatim") ? jsonResponse(nominatimRows) : jsonResponse({ elements: [] })));
    await settle(t.get(crossingPath, "u1"));
    const calls = t.calls.length;
    const again = await settle(t.get(crossingPath, "u2"));
    expect(again.headers.get("x-proxy-cache")).toBe("hit");
    expect(t.calls).toHaveLength(calls);
  });

  it("marks crossings found by closest approach as approximate, and shared-node ones not", async () => {
    const apart = { elements: [
      way(1, "Main Street", [[0, -0.01], [0, -0.00002]], [10, 11]),
      way(2, "Amherst Street", [[-0.01, 0.00002], [0.01, 0.00002]], [20, 21]),
    ] };
    for (const [json, approximate] of [[apart, true], [crossingJson, undefined]] as const) {
      const t = setup((c) => (c.url.includes("nominatim") ? jsonResponse(nominatimRows) : jsonResponse(json)));
      const [hit] = (await (await settle(t.get(crossingPath))).json()) as PlaceResult[];
      expect(hit!.kind).toBe("crossing");
      expect(hit!.approximate).toBe(approximate);
    }
  });

  it("drops search entries older than 7 days instead of serving them stale", async () => {
    let fail = false;
    const t = setup(() => (fail ? new Response("x", { status: 500 }) : jsonResponse(nominatimRows)));
    await settle(t.get(search("Main St Nashua")));
    fail = true;
    await vi.advanceTimersByTimeAsync(3 * DAY_MS); // expired (1 day) but inside the 7-day keep window
    expect((await settle(t.get(search("Main St Nashua")))).headers.get("x-proxy-cache")).toBe("stale");
    await vi.advanceTimersByTimeAsync(5 * DAY_MS);
    const gone = await settle(t.get(search("Main St Nashua")));
    expect(gone.status).toBe(502);
    expect(await t.store.get("geo/search?limit=5&q=main%20st%20nashua")).toBeNull();
  });
});

describe("typed text and pins only go into geo/ entries (the dated store)", () => {
  it("keys search, crossing, crossing-overpass and overpass entries under geo/, and nothing else holds them", async () => {
    const O = { lat: 42.7654, lon: -71.4676 };
    const crossingJson = { elements: [
      { type: "way", id: 1, nodes: [10, 500], tags: { highway: "secondary", name: "Main Street" }, geometry: [{ lat: O.lat, lon: O.lon - 0.01 }, { lat: O.lat, lon: O.lon }] },
      { type: "way", id: 2, nodes: [20, 500], tags: { highway: "secondary", name: "Amherst Street" }, geometry: [{ lat: O.lat - 0.01, lon: O.lon }, { lat: O.lat, lon: O.lon }] },
    ] };
    const t = setup((c) => (c.url.includes("nominatim") ? jsonResponse(nominatimRows) : jsonResponse(crossingJson)));
    await settle(t.get(search("Secret Rd Nashua"), "u1"));
    await settle(t.get(`${PROXY_ROUTES.crossing}?a=Main%20St&b=Amherst%20St&near=Nashua`, "u2"));
    await settle(t.get(`${PROXY_ROUTES.overpass}?lat=42.7&lon=-71.4&radius=250`, "u3"));
    expect(t.setKeys.length).toBeGreaterThanOrEqual(5);
    for (const k of t.setKeys) expect(k.startsWith("geo/"), k).toBe(true);
    expect(t.setKeys.some((k) => k.startsWith("geo/crossing-overpass"))).toBe(true);
    expect(t.setKeys.some((k) => k.startsWith("geo/overpass"))).toBe(true);
  });

  it("rounds the pin to 5 decimals so nearby pins share one entry, and only the rounded spot is recorded", async () => {
    const t = setup(() => jsonResponse({ elements: [] }));
    const a = await settle(t.get(`${PROXY_ROUTES.overpass}?lat=42.762731&lon=-71.466131&radius=250`, "u1"));
    const b = await settle(t.get(`${PROXY_ROUTES.overpass}?lat=42.762734&lon=-71.466134&radius=250`, "u2"));
    expect(t.calls).toHaveLength(1);
    expect(b.headers.get("x-proxy-cache")).toBe("hit");
    const body = (await a.json()) as { center: { lat: number; lon: number }; query: string };
    expect(body.center).toEqual({ lat: 42.76273, lon: -71.46613 });
    expect(JSON.stringify(body)).not.toContain("42.762731");
    expect(t.setKeys).toEqual(["geo/overpass?features=1&lat=42.76273&lon=-71.46613&radius=250"]);
  });
});

describe("overall deadline", () => {
  const path = `${PROXY_ROUTES.overpass}?lat=42.7&lon=-71.4&radius=250`;
  const OK = { elements: [] };

  it("tries the mirrors with the time left, finishing inside 8 s", async () => {
    const t = setup((c, s) => (new URL(c.url).host === MIRROR_HOSTS[2] ? jsonResponse(OK) : hang(c, s)));
    const res = await settle(t.get(path));
    expect(res.status).toBe(200);
    expect(t.calls).toHaveLength(3);
    expect(Date.now() - START).toBeLessThanOrEqual(8000);
  });

  it("answers with a JSON timeout error by the deadline when everything hangs", async () => {
    const t = setup(hang);
    const res = await settle(t.get(path));
    expect(res.status).toBe(504);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toMatchObject({ code: "timeout", message: TIMEOUT_MESSAGE });
    // The primary (roads + buildings) query times out, then the roads-only retry runs with the time held back
    // for it and also times out: the request still answers by its own deadline, never past it.
    expect(Date.now() - START).toBeLessThanOrEqual(config.limits.timeoutMs + 200);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("crossing: Nominatim answers but every Overpass mirror hangs → plain-search results before 8 s, not a 504", async () => {
    const t = setup((c, s) => (c.url.includes("nominatim") ? jsonResponse(nominatimRows) : hang(c, s)));
    const res = await settle(t.get(`${PROXY_ROUTES.crossing}?a=Main%20St&b=Amherst%20St&near=Nashua%20NH`));
    expect(res.status).toBe(200);
    expect(((await res.json()) as PlaceResult[])[0]!.kind).toBe("city"); // the plain-search answer
    expect(Date.now() - START).toBeLessThan(config.limits.timeoutMs);
    // The error fallback isn't cached.
    expect(t.setKeys.some((k) => k.startsWith("geo/crossing?"))).toBe(false);
  });

  it("serves an old copy first when the provider times out, without trying the mirrors", async () => {
    let slow = false;
    const t = setup((c, s) => (slow ? hang(c, s) : jsonResponse(OK)));
    await settle(t.get(path));
    await vi.advanceTimersByTimeAsync(config.cacheTtlS.overpass * 1000 + 1000);
    slow = true;
    const before = t.calls.length;
    const res = await settle(t.get(path));
    expect(res.headers.get("x-proxy-cache")).toBe("stale");
    expect(t.calls.length - before).toBe(1);
  });

  it("counts slot waits against the same deadline (vPIC: 4 sequential calls fit)", async () => {
    const t = setup((c: Call) => jsonResponse({ Results: [{ MakeName: new URL(c.url).pathname.split("/").at(-1) }] }));
    const res = await settle(t.get(PROXY_ROUTES.makes));
    expect(res.status).toBe(200);
    expect(Date.now() - START).toBeLessThanOrEqual(8000);
  });
});

describe("in-flight sharing", () => {
  it("shares a successful upstream fetch between concurrent callers", async () => {
    const t = setup(() => jsonResponse(nominatimRows));
    const [a, b] = await settle(Promise.all([t.get(search("Same St"), "ua"), t.get(search("Same St"), "ub")]));
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(t.calls).toHaveLength(1);
  });

  it("does not hand one caller's 429 to another caller asking for the same thing", async () => {
    const t = setup(() => jsonResponse(nominatimRows));
    await settle(t.get(search("Warm Up St"), "ua")); // ua has now used its per-user slot
    const [a, b] = await settle(Promise.all([t.get(search("Same St"), "ua"), t.get(search("Same St"), "ub")]));
    expect(a.status).toBe(429); // ua is over its own limit
    expect(b.status).toBe(200); // ub is not, and must not inherit ua's refusal
  });
});

describe("response shaping", () => {
  it("keeps our own fields when the upstream JSON uses the same names", async () => {
    const t = setup(() => jsonResponse({ elements: [], fetchedAt: "evil", source: "evil", center: "evil", radiusM: -1, query: "evil" }));
    const res = await settle(t.get(`${PROXY_ROUTES.overpass}?lat=42.7&lon=-71.4&radius=250`));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.fetchedAt).toBe("2026-10-09T12:00:00Z");
    expect(body.source).toBe(MIRROR_URLS[0]);
    expect(body.radiusM).toBe(250);
    expect(body.center).toEqual({ lat: 42.7, lon: -71.4 });
    expect(String(body.query)).toContain("out body geom");
  });

  it("uses the agreed attribution text", () => {
    expect(config.geocoder.attribution).toBe("Search by Photon (komoot) · Nominatim · © OpenStreetMap contributors");
    expect(config.photon.attribution).toBe(config.geocoder.attribution);
  });
});

describe("error shape", () => {
  it("always answers a ProxyError JSON for upstream failures", async () => {
    const t = setup(() => new Response("<html>nginx</html>", { status: 502, headers: { "content-type": "text/html" } }));
    const res = await settle(t.get(search("Main St")));
    const err = (await res.json()) as ProxyError;
    expect(["upstream", "timeout"]).toContain(err.code);
    expect(err.message).not.toContain("nginx");
  });
});
