// "Break it on purpose" against the proxy: bad coordinates and tile numbers must be refused with
// a plain sentence before any provider is called, and an ocean pin must come back cleanly.
// The upstream fetch FAILS the test if it is ever reached with bad input.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROXY_ROUTES, type ProxyError } from "@csd/core";
import { parseOverpass } from "@csd/mapdata";
import { START, jsonResponse, settle, setup } from "./helpers";

beforeEach(() => { vi.useFakeTimers({ now: START }); });
afterEach(() => { vi.useRealTimers(); });

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../mapdata/test/fixtures/${name}.json`, import.meta.url), "utf8"));
const O = PROXY_ROUTES.overpass;

/** A proxy whose upstream fetch must never be reached. */
function guarded() {
  const t = setup((call) => {
    throw new Error(`upstream was called with bad input: ${call.method} ${call.url}`);
  });
  return t;
}

const TECHNICAL = /undefined|\bNaN\b|\[object|Invalid input|expected \w+, received|\bat \S+ \(|\.[cm]?[jt]sx?:\d|Error\b|\bzod\b|\$\.|\bstack\b|[<>"`{}]/;

async function expectRefused(t: ReturnType<typeof guarded>, path: string, status: number, message: string, code: ProxyError["code"] = "bad-request") {
  const res = await t.get(path);
  expect(res.status, path).toBe(status);
  expect(res.headers.get("content-type")).toContain("application/json");
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  const body = (await res.json()) as ProxyError;
  expect(body, path).toEqual({ code, message });
  expect(body.message, path).not.toMatch(TECHNICAL);
  expect(Object.keys(body).sort()).toEqual(["code", "message"]);
}

describe("2. bad coordinates through the proxy", () => {
  const CHECK = (...f: string[]) => `That request wasn't valid. Check: ${f.join(", ")}.`;

  it("overpass: out-of-range latitude and longitude are refused and never reach a provider", async () => {
    const t = guarded();
    for (const lat of ["91", "-91", "90.5", "180", "999", "-500"]) await expectRefused(t, `${O}?lat=${lat}&lon=-71.4&radius=250`, 400, CHECK("lat"));
    for (const lon of ["181", "-181", "180.01", "360", "999"]) await expectRefused(t, `${O}?lat=42.7&lon=${lon}&radius=250`, 400, CHECK("lon"));
    expect(t.calls).toEqual([]);
  });

  it("overpass: text, NaN, Infinity, exponents, signs, hex, other digits and swapped decimals", async () => {
    const t = guarded();
    for (const lat of ["north", "NaN", "Infinity", "-Infinity", "1e2", "4.2e1", "0x2A", "%2B42.7", "+42.7", "42.7.1", "42,7", "--42", "", " ", "42.7%20", "%E2%88%9242", "٤٢", "42.1234567890123", "1234", "null", "undefined", "true", "[42]", "{}"]) {
      await expectRefused(t, `${O}?lat=${lat}&lon=-71.4&radius=250`, 400, CHECK("lat"));
    }
    for (const lon of ["west", "NaN", "-Infinity", "1e2", "0x2A", "", "-71.4.4"]) await expectRefused(t, `${O}?lat=42.7&lon=${lon}&radius=250`, 400, CHECK("lon"));
    expect(t.calls).toEqual([]);
  });

  it("overpass: missing, repeated and unknown parameters; the fields named are the ones to fix", async () => {
    const t = guarded();
    await expectRefused(t, O, 400, CHECK("lat", "lon", "radius"));
    await expectRefused(t, `${O}?lon=-71.4&radius=250`, 400, CHECK("lat"));
    await expectRefused(t, `${O}?lat=42.7&radius=250`, 400, CHECK("lon"));
    await expectRefused(t, `${O}?lat=42.7&lon=-71.4`, 400, CHECK("radius"));
    await expectRefused(t, `${O}?lat=42.7&lat=43.1&lon=-71.4&radius=250`, 400, CHECK("lat"));
    await expectRefused(t, `${O}?lat=42.7&lon=-71.4&radius=250&query=out%3Bnode%5Bamenity%5D`, 400, CHECK("query"));
    await expectRefused(t, `${O}?lat=42.7&lon=-71.4&radius=250&data=x`, 400, CHECK("data"));
    expect(t.calls).toEqual([]);
  });

  it("overpass: radius outside 50-400 m, or not a whole number", async () => {
    const t = guarded();
    for (const radius of ["0", "49", "401", "99999", "-5", "250.5", "abc", "NaN", "1e2", "", "000000"]) {
      await expectRefused(t, `${O}?lat=42.7&lon=-71.4&radius=${radius}`, 400, CHECK("radius"));
    }
    expect(t.calls).toEqual([]);
  });

  it("overpass: both bad at once names both", async () => {
    const t = guarded();
    await expectRefused(t, `${O}?lat=north&lon=west&radius=250`, 400, CHECK("lat", "lon"));
    // swapped Nashua in a place that can't be a latitude (lat -122, lon 37)
    await expectRefused(t, `${O}?lat=-122.4&lon=37.7&radius=250`, 400, CHECK("lat"));
    expect(t.calls).toEqual([]);
  });

  it("overpass: the edges of the range are fine (a real request would be made)", async () => {
    const t = setup(() => jsonResponse({ elements: [] }));
    for (const [lat, lon] of [["90", "180"], ["-90", "-180"], ["0", "0"], ["-0", "-0"]]) {
      const res = await settle(t.get(`${O}?lat=${lat}&lon=${lon}&radius=50`, `u-${lat}${lon}`));
      expect(res.status, `${lat},${lon}`).toBe(200);
    }
  });

  it("tile and terrain: zoom, x and y out of range, negative, fractional, huge or not numbers", async () => {
    const t = guarded();
    const paths = [
      "/25/1/1.png", "/20/0/0.png", "/-1/0/0.png", "/3/8/0.png", "/3/0/8.png", "/3/-1/0.png", "/3/0/-1.png", "/0/1/0.png", "/0/0/1.png",
      "/3/1.5/1.png", "/3/1/1.5.png", "/3.0/1/1.png", "/3/NaN/1.png", "/3/1/Infinity.png", "/3/0x1/1.png", "/3/1e1/1.png",
      "/99999999/0/0.png", "/3/99999999/0.png", "/3/123456789/0.png", "/3/0/123456789.png", "/18446744073709551616/0/0.png",
      "/3/1/1.jpg", "/3/1/1", "/3/1/1.png/", "/3/1/1.png.png", "/3/1/1.PNG", "/3/1.png", "/3/1/1/1.png", "/a/b/c.png", "//1/1.png", "/3//1.png", "/3/1/.png",
      "/../../../etc/passwd", "/3/1/..%2f1.png", "/%2e%2e/%2e%2e/1.png", "/3/%00/1.png", "/3/1/1.png%00", "/3/1/1.png?x=1", "/3/1/1.png?z=2",
    ];
    for (const kind of [PROXY_ROUTES.tile, PROXY_ROUTES.terrain]) {
      for (const p of paths) {
        const res = await t.get(`${kind}${p}`);
        // 400 with the plain sentence for bad numbers; 404 only when the path never reaches a tile route
        expect([400, 404], `${kind}${p}`).toContain(res.status);
        const body = (await res.json()) as ProxyError;
        expect(body.message, `${kind}${p}`).toMatch(/^(That request wasn't valid\. Check: [\w, -]+\.|That wasn't found\.)$/);
        expect(body.message).not.toMatch(TECHNICAL);
      }
    }
    expect(t.calls).toEqual([]);
  });

  it("tile and terrain: the exact sentence for a bad tile number", async () => {
    const t = guarded();
    await expectRefused(t, `${PROXY_ROUTES.tile}/25/1/1.png`, 400, CHECK("tile"));
    await expectRefused(t, `${PROXY_ROUTES.tile}/3/8/0.png`, 400, CHECK("tile"));
    await expectRefused(t, `${PROXY_ROUTES.terrain}/16/1/1.png`, 400, CHECK("tile"));
    await expectRefused(t, `${PROXY_ROUTES.terrain}/15/32768/0.png`, 400, CHECK("tile"));
    await expectRefused(t, `${PROXY_ROUTES.tile}/3/1/1.png?lat=1`, 400, CHECK("lat"));
    await expectRefused(t, `${PROXY_ROUTES.tile}/`, 400, CHECK("tile"));
    expect(t.calls).toEqual([]);
  });

  it("tile and terrain: the last valid tile at each zoom edge is allowed through to the provider", async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    const t = setup(() => new Response(png, { status: 200, headers: { "content-type": "image/png" } }));
    const res = await settle(t.get(`${PROXY_ROUTES.tile}/3/7/7.png`, "edge-1"));
    expect(res.status).toBe(200);
    const terrain = await settle(t.get(`${PROXY_ROUTES.terrain}/15/32767/32767.png`, "edge-2"));
    expect(terrain.status).toBe(200);
    expect(t.calls.map((c) => new URL(c.url).pathname).length).toBe(2);
  });

  it("crossing, search and models: missing, too-long, control-character and markup input", async () => {
    const t = guarded();
    const long = "a".repeat(5_000);
    for (const p of [
      `${PROXY_ROUTES.crossing}`, `${PROXY_ROUTES.crossing}?a=Main%20Street`, `${PROXY_ROUTES.crossing}?a=Main%20Street&b=`,
      `${PROXY_ROUTES.crossing}?a=${long}&b=Park%20Street`, `${PROXY_ROUTES.crossing}?a=Main%00Street&b=Park%20Street`, `${PROXY_ROUTES.crossing}?a=Main&b=P&near=${long}`,
      `${PROXY_ROUTES.search}?q=${long}`, `${PROXY_ROUTES.search}?q=%07%08`, `${PROXY_ROUTES.search}?q=a`,
      `${PROXY_ROUTES.models}?make=%3Cscript%3E&year=2020`, `${PROXY_ROUTES.models}?make=Honda&year=NaN`, `${PROXY_ROUTES.models}?make=Honda&year=3000`,
    ]) {
      const res = await t.get(p);
      expect(res.status, p.slice(0, 80)).toBe(400);
      const body = (await res.json()) as ProxyError;
      expect(body.code).toBe("bad-request");
      expect(body.message).toMatch(/^That request wasn't valid\.( Check: [\w, -]+\.)?$/);
      expect(body.message).not.toMatch(TECHNICAL);
    }
    expect(t.calls).toEqual([]);
  });

  it("reflects only parameter NAMES, cut to letters, digits, _ and -, 20 characters at most; values are never reflected", async () => {
    const t = guarded();
    const res = await t.get(`${O}?lat=%3Cscript%3Ealert(1)%3C%2Fscript%3E&lon=-71.4&radius=250&%22%3E%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E=1`);
    const text = await res.text();
    expect(res.status).toBe(400);
    const message = (JSON.parse(text) as ProxyError).message;
    expect(message).toMatch(/^That request wasn't valid\. Check: lat, [\w-]{1,20}\.$/);
    expect(text).not.toMatch(/<|>|\(/);
    const value = await t.get(`${PROXY_ROUTES.search}?q=a%3Cscript%3Ealert(1)%3C%2Fscript%3E%00`);
    expect(value.status).toBe(400);
    expect(await value.text()).toBe(JSON.stringify({ code: "bad-request", message: "That request wasn't valid. Check: q." }));
    expect(t.calls).toEqual([]);
  });

  it("refuses non-GET methods and unknown paths in plain words, without a provider call", async () => {
    const t = guarded();
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const res = await t.proxy(new Request(`https://app.test${O}?lat=42.7&lon=-71.4&radius=250`, { method, ...(method === "GET" ? {} : { body: "lat=1" }) }));
      expect(res.status).toBe(405);
      expect(await res.json()).toEqual({ code: "bad-request", message: "Only GET is supported." });
    }
    for (const p of ["/api/nope", "/api/geo/overpass/", "/api/GEO/overpass", "/api/geo", "/api/../etc/passwd", "/", "/api/geo/overpassx?lat=1"]) {
      await expectRefused(t, p, 404, "That wasn't found.", "not-found");
    }
    expect(t.calls).toEqual([]);
  });

  it("a flood of bad requests uses no rate-limit slot, so the next good request goes straight through", async () => {
    const t = setup((call) => (call.url.includes("overpass") ? jsonResponse({ elements: [] }) : jsonResponse({}, 500)));
    for (let i = 0; i < 200; i++) {
      expect((await t.get(`${O}?lat=${91 + i}&lon=-71.4&radius=250`, "same-user")).status).toBe(400);
    }
    expect(t.calls).toHaveLength(0);
    expect(t.slotCalls).toHaveLength(0);
    expect(t.tokenCalls).toHaveLength(0);
    const ok = await settle(t.get(`${O}?lat=42.7&lon=-71.4&radius=250`, "same-user"));
    expect(ok.status).toBe(200);
    expect(t.calls).toHaveLength(1);
  });
});

describe("4. a crash in the ocean through the proxy", () => {
  const OCEAN_PATH = `${O}?lat=42.5&lon=-69.5&radius=250`;

  for (const name of ["gulf-of-maine-empty", "gulf-of-maine-coast-ferry"] as const) {
    it(`${name}: comes back as a normal 200 in the shape of the cached examples, and parses to no roads`, async () => {
      const t = setup(() => jsonResponse(fixture(name)));
      const res = await settle(t.get(OCEAN_PATH));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      const body = (await res.json()) as { elements: unknown[]; center: { lat: number; lon: number }; radiusM: number; fetchedAt: string; source: string };
      expect(body.center).toEqual({ lat: 42.5, lon: -69.5 });
      expect(body.radiusM).toBe(250);
      expect(body.fetchedAt).toBe("2026-10-09T12:00:00Z");
      expect(body.elements).toEqual((fixture(name) as { elements: unknown[] }).elements);
      // The chain the app runs: proxy answer -> RoadNetwork. Zero drivable ways, nothing thrown.
      const net = parseOverpass(body, { origin: body.center }, body.radiusM, body.fetchedAt);
      expect(net.ways).toEqual([]);
      expect(net.buildings).toEqual([]);
      expect(net.parking).toEqual([]);
      expect(t.calls).toHaveLength(1);
    });

    it(`${name}: is cached, so a second look at the same water does not call Overpass again`, async () => {
      const t = setup(() => jsonResponse(fixture(name)));
      expect((await settle(t.get(OCEAN_PATH))).status).toBe(200);
      const again = await settle(t.get(OCEAN_PATH, "someone-else"));
      expect(again.status).toBe(200);
      expect(again.headers.get("x-proxy-cache")).toBe("hit");
      expect(t.calls).toHaveLength(1);
    });
  }

  it("an Overpass answer that is not JSON, or has no elements list, is a plain 'try again', never a stack trace", async () => {
    for (const upstream of [
      () => new Response("<html><body>Too many requests</body></html>", { status: 200, headers: { "content-type": "text/html" } }),
      () => jsonResponse({ version: 0.6 }),
      () => jsonResponse({ elements: "none" }),
      () => new Response("", { status: 200 }),
    ]) {
      const t = setup(upstream);
      const res = await settle(t.get(OCEAN_PATH));
      expect(res.status).toBeGreaterThanOrEqual(500);
      const body = (await res.json()) as ProxyError;
      expect(Object.keys(body).sort()).toEqual(expect.arrayContaining(["code", "message"]));
      expect(body.message).not.toMatch(TECHNICAL);
      expect(body.message).toMatch(/^[A-Z][^\n]*\.$/);
    }
  });
});
