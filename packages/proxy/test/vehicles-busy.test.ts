// The owner's report (2026-10-11): on the vehicles step, "We're getting a lot of map requests right now. Please try
// again in a moment. Pick the type below." appeared just from typing a year, make and model. These tests replay the
// vehicle lookups request by request, as the app sent them, against the real limits (defaultProviderConfig) on a
// fake clock. See docs/PROXY-BUSY.md for the root cause. (Committed first as it.fails: the reproduction, before the fix.)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROXY_ROUTES } from "@csd/core";
import { START, jsonResponse, settle, setup, type Call } from "./helpers";

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
  it.fails("one claimant: the makes list, vehicle A's claim model list, then B typed with a pause inside the make", async () => {
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

  it.fails("four claimants (or test runs) opening the vehicles step at the same moment, each with a make and year nobody asked for yet", async () => {
    const t = setup(vpic);
    const c = timeline(t);
    await c.at(0, "u1", models("Honda", 2015));
    await c.at(0, "u2", models("Ford", 2016));
    await c.at(0, "u3", models("Chevrolet", 2017));
    await c.at(0, "u4", models("Honda", 2018));
    expect(await c.refused()).toEqual([]);
  });
});
