// The vPIC routes against a fake upstream that answers with real vPIC bodies captured once
// (test/fixtures/vpic; the motorcycle makes list trimmed to a few dozen of its ~1,700 names).
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAKE_ALIASES, POPULAR_MAKES, PROXY_ROUTES, rankNames, type VehicleModelResult } from "@csd/core";
import { START, jsonResponse, settle, setup, type Call } from "./helpers";

beforeEach(() => { vi.useFakeTimers({ now: START }); });
afterEach(() => { vi.useRealTimers(); });

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/vpic/${name}`, import.meta.url), "utf8"));
const EMPTY = { Count: 0, Message: "Response returned successfully", Results: [] };

/** A fake vPIC: makes per kind, Chevrolet 2019 trucks and Honda 2019 MPVs from the captures, nothing else. */
function vpic(c: Call): Response {
  const u = new URL(c.url);
  const m = /GetMakesForVehicleType\/(\w+)$/.exec(u.pathname);
  if (m) return jsonResponse(fixture(`makes-${m[1]}.json`));
  if (/make\/Chevrolet\/modelyear\/2019\/vehicletype\/truck$/i.test(u.pathname)) return jsonResponse(fixture("models-chevrolet-2019-truck.json"));
  if (/make\/Honda\/modelyear\/2019\/vehicletype\/mpv$/i.test(u.pathname)) return jsonResponse(fixture("models-honda-2019-mpv.json"));
  return jsonResponse(EMPTY);
}
const kindOf = (c: Call) => new URL(c.url).pathname.split("/").at(-1);

describe("/api/vehicles/makes", () => {
  it("merges car, MPV, truck and motorcycle makes once, title-cased, deduplicated and sorted, then serves them from cache", async () => {
    const t = setup(vpic);
    const res = await settle(t.get(PROXY_ROUTES.makes, "u1"));
    expect(res.status).toBe(200);
    const makes = (await res.json()) as string[];
    expect(t.calls.map(kindOf)).toEqual(["car", "mpv", "truck", "motorcycle"]);
    for (const name of ["Chevrolet", "Volkswagen", "Mercedes-Benz", "BMW", "GMC", "Kia", "Land Rover", "Harley-Davidson", "Toyota", "Ram"]) expect(makes, name).toContain(name);
    expect(new Set(makes.map((m) => m.toUpperCase())).size).toBe(makes.length);
    expect(makes).toEqual([...makes].sort((a, b) => a.localeCompare(b)));
    // Another user, later: no upstream call.
    vi.setSystemTime(START + 3 * 24 * 3600 * 1000);
    const again = await settle(t.get(PROXY_ROUTES.makes, "u2"));
    expect(again.status).toBe(200);
    expect(again.headers.get("x-proxy-cache")).toBe("hit");
    expect(again.headers.get("cache-control")).toBe(`public, max-age=${30 * 24 * 3600}`);
    expect(t.calls).toHaveLength(4);
  });

  it("only lists makes of the four kinds (never a trailer- or bus-only builder)", async () => {
    const t = setup((c) => (/GetMakesForVehicleType\/(trailer|bus)/.test(c.url) ? jsonResponse({ Results: [{ MakeName: "TRAILERS ONLY" }] }) : vpic(c)));
    const makes = (await (await settle(t.get(PROXY_ROUTES.makes))).json()) as string[];
    expect(makes).not.toContain("Trailers Only");
    expect(t.calls.some((c) => /trailer|bus/.test(c.url))).toBe(false);
  });

  it("chevy, vw and harley rank their makes first in the real list", async () => {
    const t = setup(vpic);
    const makes = (await (await settle(t.get(PROXY_ROUTES.makes))).json()) as string[];
    const top = (q: string) => rankNames(q, makes, { aliases: MAKE_ALIASES, popular: POPULAR_MAKES })[0]?.name;
    expect(top("chevy")).toBe("Chevrolet");
    expect(top("vw")).toBe("Volkswagen");
    expect(top("harley")).toBe("Harley-Davidson");
    expect(top("toyta")).toBe("Toyota");
    expect(top("benz")).toBe("Mercedes-Benz");
  });

  it("answers an error, caches nothing, when vPIC sends a body without Results", async () => {
    let broken = true;
    const t = setup((c) => (broken && c.url.includes("/mpv?") ? new Response("<html>maintenance</html>", { status: 200, headers: { "content-type": "text/html" } }) : vpic(c)));
    const first = await settle(t.get(PROXY_ROUTES.makes, "u1"));
    expect(first.status).toBeGreaterThanOrEqual(500);
    const body = (await first.json()) as { code: string; message: string };
    expect(body.code).toBe("upstream");
    broken = false;
    vi.setSystemTime(START + 5000);
    const second = await settle(t.get(PROXY_ROUTES.makes, "u1"));
    expect(second.status).toBe(200);
    expect(((await second.json()) as string[])).toContain("Honda");
  });
});

describe("/api/vehicles/models", () => {
  it("Chevrolet 2019 after the makes list: asks vPIC only about the kinds Chevrolet is listed under, and types Silverado as a pickup", async () => {
    const t = setup(vpic);
    await settle(t.get(PROXY_ROUTES.makes, "u1"));
    const before = t.calls.length;
    vi.setSystemTime(START + 5000);
    const res = await settle(t.get(`${PROXY_ROUTES.models}?make=Chevrolet&year=2019`, "u1"));
    expect(res.status).toBe(200);
    const asked = t.calls.slice(before).map(kindOf);
    expect(asked).toEqual(["car", "mpv", "truck"]);
    const models = (await res.json()) as VehicleModelResult[];
    expect(models.map((m) => m.name)).toEqual(["Colorado", "Express", "Silverado", "Silverado HD", "Silverado LD"]);
    expect(models.find((m) => m.name === "Silverado")).toEqual({ name: "Silverado", vpicType: "Truck", type: "pickup" });
    expect(models.find((m) => m.name === "Express")?.type).toBe("van");
    // Same make and year, any spelling or user: cached.
    const again = await settle(t.get(`${PROXY_ROUTES.models}?make=chevrolet&year=2019`, "u2"));
    expect(again.headers.get("x-proxy-cache")).toBe("hit");
    expect(t.calls.length).toBe(before + 3);
  });

  it("a motorcycle-only make costs one upstream call", async () => {
    const t = setup(vpic);
    await settle(t.get(PROXY_ROUTES.makes, "u1"));
    const before = t.calls.length;
    vi.setSystemTime(START + 5000);
    expect((await settle(t.get(`${PROXY_ROUTES.models}?make=Harley-Davidson&year=2019`, "u1"))).status).toBe(200);
    expect(t.calls.slice(before).map(kindOf)).toEqual(["motorcycle"]);
  });

  it("without the makes index, or for a make it doesn't list, asks about all four kinds", async () => {
    const t = setup(vpic);
    const res = await settle(t.get(`${PROXY_ROUTES.models}?make=Honda&year=2019`, "u1"));
    expect(t.calls.map(kindOf)).toEqual(["car", "mpv", "truck", "motorcycle"]);
    const models = (await res.json()) as VehicleModelResult[];
    expect(models.find((m) => m.name === "CR-V")?.type).toBe("suv");
    expect(models.find((m) => m.name === "Odyssey")?.type).toBe("van");
    await settle(t.get(PROXY_ROUTES.makes, "u2"));
    const before = t.calls.length;
    vi.setSystemTime(START + 9000);
    expect((await settle(t.get(`${PROXY_ROUTES.models}?make=Zephyr&year=2019`, "u3"))).status).toBe(200);
    expect(t.calls.slice(before).map(kindOf)).toEqual(["car", "mpv", "truck", "motorcycle"]);
  });

  it("skips rows without a model name, and a broken body is an error that isn't cached", async () => {
    let broken = true;
    const t = setup((c) => {
      if (c.url.includes("/vehicletype/truck")) return broken ? new Response("not json", { status: 200 }) : jsonResponse({ Results: [{ Model_Name: 42 }, { Model_Name: " ", VehicleTypeName: "Truck" }, { Model_Name: "Ridgeline", VehicleTypeName: "Truck" }] });
      return jsonResponse(EMPTY);
    });
    const first = await settle(t.get(`${PROXY_ROUTES.models}?make=Honda&year=2020`, "u1"));
    expect(first.status).toBeGreaterThanOrEqual(500);
    broken = false;
    vi.setSystemTime(START + 5000);
    const second = await settle(t.get(`${PROXY_ROUTES.models}?make=Honda&year=2020`, "u1"));
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual([{ name: "Ridgeline", vpicType: "Truck", type: "pickup" }]);
  });

  it("refuses years before 1950 or past next year, and makes with odd characters, without calling vPIC", async () => {
    const t = setup(vpic);
    for (const q of ["make=Honda&year=1949", "make=Honda&year=2029", "make=%3Cb%3E&year=2019", "make=Honda"]) {
      expect((await settle(t.get(`${PROXY_ROUTES.models}?${q}`))).status, q).toBe(400);
    }
    expect(t.calls).toHaveLength(0);
  });
});
