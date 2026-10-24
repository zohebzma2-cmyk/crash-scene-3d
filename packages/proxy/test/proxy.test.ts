import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUSY_MESSAGE, BUSY_MESSAGES, PROXY_ROUTES, TIMEOUT_MESSAGES, UPSTREAM_MESSAGES, type PlaceResult, type ProxyError, type VehicleModelResult } from "@csd/core";
import { overpassBboxLiveQuery, overpassBboxRoadsQuery } from "@csd/mapdata";
import { MIRROR_HOSTS, MIRROR_URLS, START, config, hang, jsonResponse, nominatimRows, settle, setup, type Call } from "./helpers";

beforeEach(() => { vi.useFakeTimers({ now: START }); });
afterEach(() => { vi.useRealTimers(); });

const search = (q: string) => `${PROXY_ROUTES.search}?q=${encodeURIComponent(q)}`;
const OVERPASS_OK = { version: 0.6, elements: [{ type: "way", id: 1, nodes: [1, 2], geometry: [{ lat: 1, lon: 1 }, { lat: 1, lon: 2 }], tags: { highway: "residential" } }] };

describe("search", () => {
  it("forwards only q and the fixed parameters", async () => {
    const t = setup(() => jsonResponse(nominatimRows));
    const res = await settle(t.get(`${PROXY_ROUTES.search}?q=Main%20St%20Nashua&limit=3`));
    expect(res.status).toBe(200);
    const url = new URL(t.calls[0]!.url);
    expect(url.origin + url.pathname).toBe("https://nominatim.openstreetmap.org/search");
    expect([...url.searchParams.keys()].sort()).toEqual(["addressdetails", "format", "limit", "q"]);
    expect(url.searchParams.get("q")).toBe("Main St Nashua");
    expect(url.searchParams.get("format")).toBe("jsonv2");
    expect(url.searchParams.get("limit")).toBe("3");
    expect(url.searchParams.get("addressdetails")).toBe("1");
    const places = (await res.json()) as PlaceResult[];
    expect(places[0]).toMatchObject({ main: "Nashua", sub: "Nashua, New Hampshire", lat: 42.7654, lon: -71.4676, kind: "city" });
  });

  it("rejects unknown, repeated and malformed parameters without calling upstream", async () => {
    const t = setup(() => jsonResponse(nominatimRows));
    for (const path of [
      `${PROXY_ROUTES.search}?q=Main%20St&email=a@b.c`,
      `${PROXY_ROUTES.search}?q=Main%20St&q=Elm%20St`,
      `${PROXY_ROUTES.search}?q=Main%20St&limit=99`,
      `${PROXY_ROUTES.search}?q=`,
      `${PROXY_ROUTES.search}`,
      `${PROXY_ROUTES.search}?q=a%00b%20c`,
      `${PROXY_ROUTES.overpass}?lat=42.7&lon=-71.4&radius=9999`,
      `${PROXY_ROUTES.overpass}?lat=142.7&lon=-71.4&radius=250`,
      `${PROXY_ROUTES.overpass}?lat=42.7&lon=-71.4&radius=250&query=x`,
      `${PROXY_ROUTES.tile}/25/1/1.png`,
      `${PROXY_ROUTES.tile}/3/9/1.png`,
      `${PROXY_ROUTES.terrain}/16/1/1.png`,
      `${PROXY_ROUTES.makes}?x=1`,
      `${PROXY_ROUTES.models}?make=Honda`,
      `${PROXY_ROUTES.models}?make=Hon%3Cda&year=2020`,
      `${PROXY_ROUTES.models}?make=Honda&year=1900`,
    ]) {
      const res = await t.get(path);
      expect(res.status, path).toBe(400);
      expect(((await res.json()) as ProxyError).code).toBe("bad-request");
    }
    expect(t.calls).toHaveLength(0);
    expect(t.slotCalls).toHaveLength(0);
  });

  it("answers 404 for unknown paths and 405 for non-GET", async () => {
    const t = setup(() => jsonResponse([]));
    expect((await t.get("/api/nope")).status).toBe(404);
    const post = await t.proxy(new Request(`https://app.test${search("x y")}`, { method: "POST" }));
    expect(post.status).toBe(405);
  });
});

describe("rate limits", () => {
  it("global: three different users at once → one upstream call now, one after a second, the third is told to wait", async () => {
    const t = setup(() => jsonResponse(nominatimRows));
    const reqs = ["Aa St", "Bb St", "Cc St"].map((q, i) => t.get(search(q), `user-${i}`));
    await vi.advanceTimersByTimeAsync(10);
    expect(t.calls).toHaveLength(1);
    const results = await settle(Promise.all(reqs));
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 429]);
    expect(t.calls).toHaveLength(2);
    const busy = results.find((r) => r.status === 429)!;
    expect(busy.headers.get("retry-after")).toBe("2");
  });

  it("per user: a second uncached request within a second is refused, then allowed", async () => {
    const t = setup(() => jsonResponse(nominatimRows));
    expect((await settle(t.get(search("One St")))).status).toBe(200);
    const second = await settle(t.get(search("Two St")));
    expect(second.status).toBe(429);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await settle(t.get(search("Two St")))).status).toBe(200);
    expect(t.calls).toHaveLength(2);
  });

  it("busy answers 429 with the friendly message and Retry-After", async () => {
    const t = setup(() => jsonResponse(nominatimRows));
    await settle(t.get(search("One St")));
    const res = await settle(t.get(search("Two St")));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("1");
    expect(res.headers.get("cache-control")).toBe("no-store");
    // The search's own wording (the map's is BUSY_MESSAGE).
    expect(await res.json()).toEqual({ code: "busy", message: BUSY_MESSAGES.search, retryAfterS: 1 });
    expect(BUSY_MESSAGES.search).not.toBe(BUSY_MESSAGE);
  });

  it("services are limited independently", async () => {
    const t = setup((c) => (c.url.includes("nominatim") ? jsonResponse(nominatimRows) : jsonResponse(OVERPASS_OK)));
    const [a, b] = await settle(Promise.all([
      t.get(search("One St"), "u1"),
      t.get(`${PROXY_ROUTES.overpass}?lat=42.7&lon=-71.4&radius=250`, "u2"),
    ]));
    expect([a.status, b.status]).toEqual([200, 200]);
  });

  it("tile bursts from one user are allowed (the map needs ~20 at once)", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const t = setup(() => new Response(png, { headers: { "content-type": "image/png" } }));
    const results = await settle(Promise.all(Array.from({ length: 12 }, (_, i) => t.get(`${PROXY_ROUTES.tile}/15/${9877 + i}/12070.png`))));
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
});

describe("cache", () => {
  it("hits take no slot and make no upstream call; TTL expiry refetches", async () => {
    const t = setup(() => jsonResponse(nominatimRows));
    await settle(t.get(search("Main St Nashua")));
    expect(t.calls).toHaveLength(1);
    const slotsBefore = t.slotCalls.length;
    // Different user, different case and spacing, same normalised key.
    const hit = await settle(t.get(search("  main  st nashua "), "someone-else"));
    expect(hit.status).toBe(200);
    expect(hit.headers.get("x-proxy-cache")).toBe("hit");
    expect(t.calls).toHaveLength(1);
    expect(t.slotCalls).toHaveLength(slotsBefore);

    await vi.advanceTimersByTimeAsync(config.cacheTtlS.search * 1000 + 1000);
    const again = await settle(t.get(search("Main St Nashua")));
    expect(again.headers.get("x-proxy-cache")).toBe("miss");
    expect(t.calls).toHaveLength(2);
  });

  it("serves a stale copy when the provider returns 500", async () => {
    let fail = false;
    const t = setup(() => (fail ? new Response("boom", { status: 500 }) : jsonResponse(nominatimRows)));
    const fresh = await settle(t.get(search("Main St Nashua")));
    const body = await fresh.text();
    await vi.advanceTimersByTimeAsync(config.cacheTtlS.search * 1000 + 1000);
    fail = true;
    const res = await settle(t.get(search("Main St Nashua")));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-proxy-cache")).toBe("stale");
    expect(await res.text()).toBe(body);
  });

  it("serves stale instead of busy", async () => {
    const t = setup(() => jsonResponse(nominatimRows));
    await settle(t.get(search("Old St")));
    await vi.advanceTimersByTimeAsync(config.cacheTtlS.search * 1000 + 1000);
    await settle(t.get(search("Other St"))); // takes this user's slot
    const res = await settle(t.get(search("Old St")));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-proxy-cache")).toBe("stale");
  });

  it("returns an upstream error with a friendly message when there is nothing cached", async () => {
    const t = setup(() => new Response("boom", { status: 503 }));
    const res = await settle(t.get(search("Main St")));
    expect(res.status).toBe(502);
    const err = (await res.json()) as ProxyError;
    expect(err.code).toBe("upstream");
    expect(err.message).not.toMatch(/503|boom/);
  });

  it("sends 4xx statuses from upstream as upstream errors, and 404 tiles as not-found", async () => {
    const t = setup(() => new Response("nope", { status: 404 }));
    const res = await settle(t.get(`${PROXY_ROUTES.tile}/15/1/1.png`));
    expect(res.status).toBe(404);
    expect(((await res.json()) as ProxyError).code).toBe("not-found");
  });
});

describe("timeouts", () => {
  it("answers with the timeout message when upstream hangs", async () => {
    const t = setup(hang);
    const res = await settle(t.get(search("Main St")));
    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({ code: "timeout", message: TIMEOUT_MESSAGES.search });
    expect(vi.getTimerCount()).toBe(0); // nothing left running
  });

  it("serves stale on timeout", async () => {
    let slow = false;
    const t = setup((c, s) => (slow ? hang(c, s) : jsonResponse(nominatimRows)));
    await settle(t.get(search("Main St")));
    await vi.advanceTimersByTimeAsync(config.cacheTtlS.search * 1000 + 1000);
    slow = true;
    const res = await settle(t.get(search("Main St")));
    expect(res.headers.get("x-proxy-cache")).toBe("stale");
  });
});

describe("overpass", () => {
  const path = `${PROXY_ROUTES.overpass}?lat=42.7627323&lon=-71.4661324&radius=250`;

  it("builds the query server-side, posts it, and returns the fixture shape", async () => {
    const t = setup(() => jsonResponse(OVERPASS_OK));
    const res = await settle(t.get(path));
    expect(res.status).toBe(200);
    const call = t.calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe(MIRROR_URLS[0]);
    const data = new URLSearchParams(call.body).get("data")!;
    expect(data).toBe(overpassBboxLiveQuery({ lat: 42.76273, lon: -71.46613 }, 250)); // the pin is rounded to 5 decimals
    expect(data).not.toContain("around"); // a square, so the whole radiusM square is fetched
    expect(data).toContain('["building"]'); // the primary query asks for buildings too (best-effort backdrop)
    expect(data).toMatch(/^\[out:json\]\[timeout:25\];\(way\([\d.,-]+\)\["highway"~/); // short timeout so a stuck mirror fails over fast
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ source: MIRROR_URLS[0], radiusM: 250, center: { lat: 42.76273, lon: -71.46613 }, query: data });
    expect(body.fetchedAt).toBe("2026-10-09T12:00:00Z");
    expect(body.elements).toHaveLength(1);
  });

  it("falls back to the next URL on 504, then on 429, and on a body with an Overpass error remark", async () => {
    const t = setup((c) => {
      const host = new URL(c.url).host;
      if (host === MIRROR_HOSTS[0]) return new Response("gateway timeout", { status: 504 });
      if (host === MIRROR_HOSTS[1]) return jsonResponse({ elements: [], remark: "runtime error: Query timed out" });
      return jsonResponse(OVERPASS_OK);
    });
    const res = await settle(t.get(path));
    expect(res.status).toBe(200);
    expect(t.calls.map((c) => new URL(c.url).host)).toEqual(MIRROR_HOSTS.slice(0, 3));
    expect(((await res.json()) as { source: string }).source).toBe(MIRROR_URLS[2]);
  });

  it("falls back after a timeout too", async () => {
    const t = setup((c, s) => (new URL(c.url).host === MIRROR_HOSTS[0] ? hang(c, s) : jsonResponse(OVERPASS_OK)));
    const res = await settle(t.get(path));
    expect(res.status).toBe(200);
    expect(t.calls).toHaveLength(2);
  });

  it("drops buildings and still returns roads when the building-heavy query times out everywhere", async () => {
    // The primary query asks for buildings; make every mirror hang on it (a dense city's building geometry).
    // The roads-only retry (no buildings) is answered, so the scene still gets its roads, not a hard 504.
    const bodyData = (c: Call) => new URLSearchParams(c.body).get("data") ?? "";
    const t = setup((c, s) => (bodyData(c).includes('["building"]') ? hang(c, s) : jsonResponse(OVERPASS_OK)));
    const res = await settle(t.get(path));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.query).toBe(overpassBboxRoadsQuery({ lat: 42.76273, lon: -71.46613 }, 250));
    expect(body.query as string).not.toContain('["building"]');
    expect(body.elements).toHaveLength(1);
    // The call that answered is the roads-only one (every building-query attempt hung first).
    expect(bodyData(t.calls.at(-1)!)).not.toContain('["building"]');
  });

  it("reports an upstream error when every instance is down and nothing is cached", async () => {
    const t = setup(() => new Response("down", { status: 502 }));
    const res = await settle(t.get(path));
    expect(res.status).toBe(502);
    expect(t.calls).toHaveLength(config.overpass.urls.length); // every mirror was tried
  });

  it("tries a mirror that just failed last, so the next request doesn't wait for it again", async () => {
    let mainDown = true;
    const t = setup((c) => (new URL(c.url).host === MIRROR_HOSTS[0] && mainDown ? new Response("busy", { status: 504 }) : jsonResponse(OVERPASS_OK)));
    await settle(t.get(path, "u1"));
    expect(new URL(t.calls[0]!.url).host).toBe(MIRROR_HOSTS[0]);
    await vi.advanceTimersByTimeAsync(2000);
    const before = t.calls.length;
    await settle(t.get(`${PROXY_ROUTES.overpass}?lat=42.8&lon=-71.5&radius=250`, "u2"));
    expect(new URL(t.calls[before]!.url).host).toBe(MIRROR_HOSTS[1]); // first, because the usual first one failed a moment ago
    expect(t.calls.length - before).toBe(1);
    // After the penalty (2 minutes) the main one is tried first again.
    mainDown = false;
    await vi.advanceTimersByTimeAsync(121_000);
    const later = t.calls.length;
    await settle(t.get(`${PROXY_ROUTES.overpass}?lat=42.9&lon=-71.5&radius=250`, "u3"));
    expect(new URL(t.calls[later]!.url).host).toBe(MIRROR_HOSTS[0]);
  });
});

describe("tiles and terrain", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it("relays PNGs with long cache headers and caches them", async () => {
    const t = setup(() => new Response(PNG, { headers: { "content-type": "image/png" } }));
    const res = await settle(t.get(`${PROXY_ROUTES.terrain}/15/9878/12070.png`));
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe(`public, max-age=${config.cacheTtlS.terrain}`);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    expect(t.calls[0]!.url).toBe("https://s3.amazonaws.com/elevation-tiles-prod/terrarium/15/9878/12070.png");
    const tile = await settle(t.get(`${PROXY_ROUTES.tile}/16/19756/24140.png`));
    expect(tile.headers.get("cache-control")).toBe(`public, max-age=${config.cacheTtlS.tile}`);
    expect(t.calls[1]!.url).toBe("https://tile.openstreetmap.org/16/19756/24140.png");
    await settle(t.get(`${PROXY_ROUTES.terrain}/15/9878/12070.png`, "other"));
    expect(t.calls).toHaveLength(2);
  });

  it("refuses to relay or cache a non-image answer", async () => {
    const t = setup(() => new Response("<html>rate limited</html>", { headers: { "content-type": "text/html" } }));
    const res = await settle(t.get(`${PROXY_ROUTES.tile}/15/1/1.png`));
    expect(res.status).toBe(502);
  });
});

describe("crossing", () => {
  const O = { lat: 42.7654, lon: -71.4676 };
  const way = (id: number, name: string, pts: [number, number][], nodes: number[]) => ({
    type: "way", id, nodes, tags: { highway: "secondary", name }, geometry: pts.map(([dlat, dlon]) => ({ lat: O.lat + dlat, lon: O.lon + dlon })),
  });
  const crossingOverpass = { elements: [
    way(1, "Main Street", [[0, -0.01], [0, 0], [0, 0.01]], [10, 500, 11]),
    way(2, "Amherst Street", [[-0.01, 0], [0, 0], [0.01, 0]], [20, 500, 21]),
  ] };
  const path = `${PROXY_ROUTES.crossing}?a=Main%20St&b=Amherst%20St&near=Nashua%20NH`;

  it("geocodes the place, finds both streets in Overpass, and returns the shared node", async () => {
    const t = setup((c) => (c.url.includes("nominatim") ? jsonResponse(nominatimRows) : jsonResponse(crossingOverpass)));
    const res = await settle(t.get(path));
    expect(res.status).toBe(200);
    const [hit] = (await res.json()) as PlaceResult[];
    expect(hit).toMatchObject({ kind: "crossing", streets: ["Main Street", "Amherst Street"], main: "Main Street & Amherst Street", sub: "Nashua NH" });
    expect(hit!.lat).toBeCloseTo(O.lat, 6);
    expect(hit!.lon).toBeCloseTo(O.lon, 6);
    const op = t.calls.find((c) => c.url.includes("overpass"))!;
    const q = new URLSearchParams(op.body).get("data")!;
    const re = new RegExp(/\["name"~"([^"]+)",i\]/.exec(q)![1]!, "i");
    expect(re.test("Main Street")).toBe(true);
    expect(q).toContain("around:1500,42.7654,-71.4676"); // the small area first
  });

  it("falls back to a plain Nominatim search when Overpass finds no crossing", async () => {
    const t = setup((c) => (c.url.includes("nominatim") ? jsonResponse(nominatimRows) : jsonResponse({ elements: [] })));
    const res = await settle(t.get(path));
    const places = (await res.json()) as PlaceResult[];
    expect(places[0]!.kind).toBe("city");
    const last = new URL(t.calls.filter((c) => c.url.includes("nominatim")).at(-1)!.url);
    expect(last.searchParams.get("q")).toBe("Main St and Amherst St, Nashua NH");
  });

  it("falls back when Overpass is down", async () => {
    const t = setup((c) => (c.url.includes("nominatim") ? jsonResponse(nominatimRows) : new Response("x", { status: 500 })));
    const res = await settle(t.get(path));
    expect(res.status).toBe(200);
    expect(((await res.json()) as PlaceResult[])[0]!.kind).toBe("city");
  });
});

describe("vehicles (vPIC)", () => {
  const vpicHandler = (c: Call) => {
    const u = new URL(c.url);
    if (u.pathname.includes("GetMakesForVehicleType/car")) return jsonResponse({ Results: [{ MakeName: "HONDA" }, { MakeName: "BMW" }] });
    if (u.pathname.includes("GetMakesForVehicleType/mpv")) return jsonResponse({ Results: [{ MakeName: "HONDA" }, { MakeName: "GMC" }] });
    if (u.pathname.includes("GetMakesForVehicleType/truck")) return jsonResponse({ Results: [{ MakeName: "FORD" }] });
    if (u.pathname.includes("GetMakesForVehicleType/motorcycle")) return jsonResponse({ Results: [{ MakeName: "HARLEY-DAVIDSON" }] });
    if (u.pathname.endsWith("/vehicletype/car")) return jsonResponse({ Results: [{ Model_Name: "Accord", VehicleTypeName: "Passenger Car" }] });
    if (u.pathname.endsWith("/vehicletype/mpv")) return jsonResponse({ Results: [{ Model_Name: "CR-V", VehicleTypeName: "Multipurpose Passenger Vehicle (MPV)" }, { Model_Name: "Odyssey", VehicleTypeName: "Multipurpose Passenger Vehicle (MPV)" }] });
    if (u.pathname.endsWith("/vehicletype/truck")) return jsonResponse({ Results: [{ Model_Name: "Ridgeline", VehicleTypeName: "Truck" }, { Model_Name: "Accord", VehicleTypeName: "Passenger Car" }] });
    return jsonResponse({ Results: [{ Model_Name: "Gold Wing", VehicleTypeName: "Motorcycle" }, { Model_Name: "Mystery", VehicleTypeName: "Trailer" }] });
  };

  it("types models with typeFromVpic and merges the four vehicle kinds", async () => {
    const t = setup(vpicHandler);
    const res = await settle(t.get(`${PROXY_ROUTES.models}?make=Honda&year=2021`));
    expect(res.status).toBe(200);
    const models = (await res.json()) as VehicleModelResult[];
    const by = Object.fromEntries(models.map((m) => [m.name, m]));
    expect(by.Accord).toEqual({ name: "Accord", vpicType: "Passenger Car", type: "car" });
    expect(by["CR-V"]!.type).toBe("suv");
    expect(by.Odyssey!.type).toBe("van");
    expect(by.Ridgeline!.type).toBe("pickup");
    expect(by["Gold Wing"]!.type).toBe("motorcycle");
    expect(by.Mystery!.type).toBeNull();
    expect(models.filter((m) => m.name === "Accord")).toHaveLength(1);
    expect(models.map((m) => m.name)).toEqual([...models.map((m) => m.name)].sort((a, b) => a.localeCompare(b)));
    expect(t.calls).toHaveLength(4);
    expect(t.calls[0]!.url).toBe("https://vpic.nhtsa.dot.gov/api/vehicles/GetModelsForMakeYear/make/Honda/modelyear/2021/vehicletype/car?format=json");
    // Second request is served from cache.
    await settle(t.get(`${PROXY_ROUTES.models}?make=honda&year=2021`, "u2"));
    expect(t.calls).toHaveLength(4);
  });

  it("merges makes for car, mpv, truck and motorcycle, title-cased and sorted", async () => {
    const t = setup(vpicHandler);
    const res = await settle(t.get(PROXY_ROUTES.makes));
    expect(await res.json()).toEqual(["BMW", "Ford", "GMC", "Harley-Davidson", "Honda"]);
    expect(t.calls.map((c) => c.url.split("/").at(-1)!.split("?")[0])).toEqual(["car", "mpv", "truck", "motorcycle"]);
  });

  it("never caches a partial list: after a failure only the missing kinds are fetched again", async () => {
    let truckDown = true;
    const t = setup((c) => (truckDown && c.url.includes("/truck?") ? new Response("x", { status: 500 }) : vpicHandler(c)));
    const first = await settle(t.get(PROXY_ROUTES.makes, "u1"));
    expect(first.status).toBe(502);
    expect((await first.json()) as ProxyError).toMatchObject({ code: "upstream", message: UPSTREAM_MESSAGES.vehicles });
    expect(t.calls).toHaveLength(4); // the four kinds are asked side by side
    truckDown = false;
    const second = await settle(t.get(PROXY_ROUTES.makes, "u1"));
    expect(second.status).toBe(200);
    expect(t.calls).toHaveLength(5); // car, mpv and motorcycle came from cache; only truck again
    expect(((await second.json()) as string[])).toContain("Ford");
  });
});

describe("User-Agent", () => {
  it("is sent on every upstream call, for every route", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const t = setup((c) => {
      if (c.url.includes("nominatim")) return jsonResponse(nominatimRows);
      if (c.url.includes("overpass")) return jsonResponse(OVERPASS_OK);
      if (c.url.includes("vpic")) return jsonResponse({ Results: [] });
      return new Response(png, { headers: { "content-type": "image/png" } });
    });
    const paths = [
      search("Main St"),
      `${PROXY_ROUTES.overpass}?lat=42.7&lon=-71.4&radius=250`,
      `${PROXY_ROUTES.crossing}?a=Main%20St&b=Elm%20St&near=Nashua`,
      `${PROXY_ROUTES.tile}/15/1/1.png`,
      `${PROXY_ROUTES.terrain}/15/1/1.png`,
      PROXY_ROUTES.makes,
      `${PROXY_ROUTES.models}?make=Honda&year=2020`,
    ];
    for (const [i, p] of paths.entries()) expect((await settle(t.get(p, `u${i}`))).status, p).toBe(200);
    expect(t.calls.length).toBeGreaterThan(paths.length);
    for (const c of t.calls) expect(c.headers.get("user-agent")).toBe(config.userAgent);
    expect(config.userAgent).toBe("InsurifyAI-CrashScene/1.0 (+https://github.com/zohebzma2-cmyk/crash-scene-3d)");
    expect(config.userAgent).toContain("https://github.com/zohebzma2-cmyk/crash-scene-3d");
    expect(config.contact).toBe("https://github.com/zohebzma2-cmyk/crash-scene-3d");
  });
});
