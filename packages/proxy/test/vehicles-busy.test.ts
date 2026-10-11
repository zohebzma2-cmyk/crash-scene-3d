// The owner's report (2026-10-11): on the vehicles step, "We're getting a lot of map requests right now. Please try
// again in a moment. Pick the type below." appeared just from typing a year, make and model. These tests replay the
// vehicle lookups request by request, as the app sent them, against the real limits (defaultProviderConfig) on a
// fake clock. See docs/PROXY-BUSY.md for the root cause.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUSY_MESSAGE, BUSY_MESSAGES, PROXY_ROUTES, TIMEOUT_MESSAGES, UPSTREAM_MESSAGES, type ProxyError } from "@csd/core";
import { START, config, hang, jsonResponse, settle, setup, type Call } from "./helpers";

beforeEach(() => { vi.useFakeTimers({ now: START }); });
afterEach(() => { vi.useRealTimers(); });

/** vPIC as a fake: every make list and every model list answers at once with a short list. */
const vpic = (c: Call) => {
  const u = new URL(c.url);
  if (u.pathname.includes("GetMakesForVehicleType")) return jsonResponse({ Results: [{ MakeName: "HONDA" }, { MakeName: "CHEVROLET" }, { MakeName: "FORD" }] });
  if (u.pathname.endsWith("/vehicletype/truck")) return jsonResponse({ Results: [{ Model_Name: "Silverado 1500", VehicleTypeName: "Truck" }] });
  return jsonResponse({ Results: [{ Model_Name: "Malibu", VehicleTypeName: "Passenger Car" }] });
};

const models = (make: string, year: number) => `${PROXY_ROUTES.models}?${new URLSearchParams({ make, year: String(year) })}`;

/** Send `path` at `ms` after the start (fake clock) as `user`, without waiting for the answer. */
function timeline(t: ReturnType<typeof setup>) {
  const sent: Array<{ path: string; user: string; res: Promise<Response> }> = [];
  return {
    sent,
    async at(ms: number, user: string, ...paths: string[]) {
      const wait = START + ms - Date.now();
      if (wait > 0) await vi.advanceTimersByTimeAsync(wait);
      for (const path of paths) sent.push({ path, user, res: t.get(path, user) });
    },
    async refused() {
      const res = await settle(Promise.all(sent.map((s) => s.res)));
      return sent.map((s, i) => `${s.user} ${s.path} → ${res[i]!.status}`).filter((_, i) => res[i]!.status !== 200);
    },
  };
}

describe("typing vehicles like a person never hits 429 (the app's old request pattern, cold proxy cache)", () => {
  it("one claimant: the makes list, vehicle A's claim model list, then B typed with a pause inside the make", async () => {
    const t = setup(vpic);
    const c = timeline(t);
    // Opening the vehicles step: the makes list at once, and vehicle A (filled from the claim) 450 ms later.
    await c.at(0, "claimant", PROXY_ROUTES.makes);
    await c.at(450, "claimant", models("Honda", 2021));
    // Vehicle B: "2019", then "chev", a short pause (more than the 450 ms debounce), "y": two lookups 650 ms apart.
    await c.at(3000, "claimant", models("chev", 2019));
    await c.at(3650, "claimant", models("chevy", 2019));
    expect(await c.refused()).toEqual([]);
  });

  it("four claimants (or test runs) opening the vehicles step at the same moment, each with a make and year nobody asked for yet", async () => {
    const t = setup(vpic);
    const c = timeline(t);
    await c.at(0, "u1", models("Honda", 2015));
    await c.at(0, "u2", models("Ford", 2016));
    await c.at(0, "u3", models("Chevrolet", 2017));
    await c.at(0, "u4", models("Honda", 2018));
    expect(await c.refused()).toEqual([]);
  });

  it("the worst case of one person typing two vehicles (a pause inside every make is a lookup) passes", async () => {
    const t = setup(vpic);
    const c = timeline(t);
    await c.at(0, "claimant", PROXY_ROUTES.makes);
    await c.at(450, "claimant", models("Honda", 2021));
    // B: "ch" pause "ev" pause "y"; then A changed: "fo" pause "rd". Seven requests (28 vPIC calls) in under 6 s.
    await c.at(2000, "claimant", models("ch", 2019));
    await c.at(2600, "claimant", models("chev", 2019));
    await c.at(3200, "claimant", models("chevy", 2019));
    await c.at(5000, "claimant", models("fo", 2019));
    await c.at(5600, "claimant", models("ford", 2019));
    expect(await c.refused()).toEqual([]);
  });

  it("five people opening the vehicles step at once with make/years nobody asked for (20 vPIC calls; the burst is 16) wait a moment instead of a 429", async () => {
    const t = setup(vpic);
    const c = timeline(t);
    for (let i = 1; i <= 5; i++) await c.at(0, `o${i}`, models("Honda", 2000 + i));
    expect(await c.refused()).toEqual([]);
    expect(Date.now() - START).toBeLessThan(3000);
  });
});

describe("the vPIC limiter", () => {
  const tile = (i: number) => `${PROXY_ROUTES.tile}/15/${1000 + i}/2000.png`;
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
  const upstream = (c: Call) => (c.url.includes("vpic") ? vpic(c) : c.url.includes("overpass") ? jsonResponse({ elements: [] }) : new Response(PNG, { headers: { "content-type": "image/png" } }));

  it("is its own bucket: a user who used up the map's tiles and Overpass slot still gets the vehicle list, and the other way round", async () => {
    const t = setup(upstream);
    // Use up this user's tile bucket (64) and the global one (256), and the Overpass slot.
    const map = await settle(Promise.all([
      ...Array.from({ length: 300 }, (_, i) => t.get(tile(i), "u1")),
      t.get(`${PROXY_ROUTES.overpass}?lat=42.7&lon=-71.4&radius=250`, "u1"),
    ]));
    expect(map.some((r) => r.status === 429)).toBe(true);
    expect((await settle(t.get(models("Honda", 2010), "u1"))).status).toBe(200);
    expect(t.tokenCalls.filter((k) => k.endsWith(":vehicles") || k === "global:vehicles").length).toBeGreaterThan(0);
    // Now flood vPIC for u2: its map requests are unaffected.
    const flood = await settle(Promise.all(Array.from({ length: 30 }, (_, i) => t.get(models("Ford", 1990 + i), "u2"))));
    expect(flood.some((r) => r.status === 429)).toBe(true);
    vi.advanceTimersByTime(5000); // the tile buckets refill
    expect((await settle(t.get(tile(999), "u2"))).status).toBe(200);
  });

  it("still holds a flood to the limits: most of 30 cold lookups at once are refused, with the vehicle list's own message", async () => {
    const t = setup(vpic);
    const res = await settle(Promise.all(Array.from({ length: 30 }, (_, i) => t.get(models("Honda", 1981 + i), "flooder"))));
    const ok = res.filter((r) => r.status === 200).length;
    // A model list is four vPIC calls: the global burst (16) plus its refill over the 2.5 s wait, and never more
    // than this person's own bucket allows.
    const { global, perUser } = config.vehiclesBurst;
    expect(ok).toBeGreaterThanOrEqual(global.capacity / 4);
    expect(ok).toBeLessThanOrEqual(Math.min(perUser.capacity + perUser.refillPerS * 5, global.capacity + global.refillPerS * 5) / 4);
    // vPIC itself saw no more than the global bucket allows (a request may wait 2.5 s for its user token, then 2.5 s more).
    expect(t.calls.length).toBeLessThanOrEqual(global.capacity + global.refillPerS * 5);
    const refused = res.find((r) => r.status === 429)!;
    const body = (await refused.json()) as ProxyError;
    expect(body).toMatchObject({ code: "busy", message: BUSY_MESSAGES.vehicles });
    expect(body.message).not.toMatch(/map/i);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
  });

  it("caches a model list under the normalised make: 'HONDA ', 'honda' and 'Honda' are one set of vPIC calls", async () => {
    const t = setup(vpic);
    for (const [i, make] of ["Honda", "honda", " HONDA "].entries()) expect((await settle(t.get(models(make, 2020), `u${i}`))).status).toBe(200);
    expect(t.calls).toHaveLength(4);
    // The four kinds were asked side by side, each with its own global token and its own user token.
    expect(t.tokenCalls.filter((k) => k === "global:vehicles")).toHaveLength(4);
    expect(t.tokenCalls.filter((k) => k === "user:u0:vehicles")).toHaveLength(4);
  });

  it("caps one person's share: a scripted caller gets at most the per-user refill, and someone else still gets a list", async () => {
    const t = setup(vpic);
    const { perUser, global } = config.vehiclesBurst;
    expect(perUser.refillPerS).toBeLessThan(global.refillPerS);
    // A script asks for a new cold list every second for 20 s.
    const script: Promise<Response>[] = [];
    for (let i = 0; i < 20; i++) {
      script.push(t.get(models("Ford", 1981 + i), "script"));
      await vi.advanceTimersByTimeAsync(1000);
    }
    // Meanwhile a person opens the vehicles step.
    const person = await settle(t.get(models("Honda", 2019), "person"));
    expect(person.status).toBe(200);
    await settle(Promise.all(script));
    const scriptCalls = t.calls.filter((c) => c.url.includes("/make/Ford/")).length;
    expect(scriptCalls).toBeLessThanOrEqual(perUser.capacity + perUser.refillPerS * 25);
  });

  it("serves an expired list when vPIC is down or the limit is reached, instead of an error", async () => {
    let down = false;
    const t = setup((c) => (down ? new Response("x", { status: 503 }) : vpic(c)));
    expect((await settle(t.get(models("Honda", 2012), "u1"))).status).toBe(200);
    vi.advanceTimersByTime(31 * 86_400_000); // past the 30 days
    down = true;
    const stale = await settle(t.get(models("Honda", 2012), "u2"));
    expect(stale.status).toBe(200);
    expect(stale.headers.get("x-proxy-cache")).toBe("stale");
    // Busy, not down: drain the global bucket, then the expired list is still served.
    down = false;
    await settle(Promise.all(Array.from({ length: 40 }, (_, i) => t.get(models("Ford", 1981 + i), `f${i}`))));
    const again = await settle(t.get(models("Honda", 2012), "u3"));
    expect(again.status).toBe(200);
  });

  it("words each topic for what it is: map, search and vehicle list", async () => {
    expect(BUSY_MESSAGES.vehicles).not.toMatch(/map/i);
    expect(TIMEOUT_MESSAGES.vehicles).not.toMatch(/map/i);
    expect(UPSTREAM_MESSAGES.vehicles).not.toMatch(/map/i);
    expect(BUSY_MESSAGES.search).not.toMatch(/map/i);
    expect(BUSY_MESSAGES.map).toBe(BUSY_MESSAGE);
    // A vehicle lookup that times out says so about the vehicle list.
    const t = setup(hang);
    const res = await settle(t.get(models("Honda", 2013), "u1"));
    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({ code: "timeout", message: TIMEOUT_MESSAGES.vehicles });
  });
});
