// @vitest-environment jsdom
// Vehicle lookups as a person types them (docs/PROXY-BUSY.md): the real vehicle service behind the vehicles step,
// with a fake /api that counts requests. One request per make and model year, never per keystroke; busy answers
// are retried before the card says anything, and then in the vehicle list's own words.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROXY_ROUTES, type VehicleModelResult } from "@csd/core";
import { initialDoc, reducer, type Doc } from "../src/state/doc";
import { createVehiclesService, resolveMake, UNKNOWN_MAKE_WAIT_MS, VEHICLE_LOOKUP_MESSAGES } from "../src/services/vehicles";
import { LOOKUP_DEBOUNCE_MS } from "../src/components/VehicleCard";
import { BUSY_TOTAL_WAIT_MS, retryBusy } from "../src/services/http";
import { ServiceError } from "../src/services/types";
import { flush, renderApp, setValue, text } from "./helpers";
import { makeServices, tbone } from "./fakes";

const MAKES = ["Chevrolet", "Ford", "Honda", "Mercedes-Benz", "Toyota", "Volkswagen"];
const MODELS: Record<string, VehicleModelResult[]> = {
  chevrolet: [{ name: "Malibu", vpicType: "Passenger Car", type: "car" }, { name: "Silverado 1500", vpicType: "Truck", type: "pickup" }],
  honda: [{ name: "Accord", vpicType: "Passenger Car", type: "car" }, { name: "CR-V", vpicType: "Multipurpose Passenger Vehicle (MPV)", type: "suv" }],
};

const json = (v: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });
const busy = (retryAfterS = 1) => json({ code: "busy", message: "We're getting a lot of map requests right now. Please try again in a moment.", retryAfterS }, 429, { "retry-after": String(retryAfterS) });

/** A fake /api/vehicles: records every request; `answer` may override a reply (busy, say). */
function fakeApi(answer: (url: URL, n: number) => Response | null = () => null) {
  const calls: string[] = [];
  const fetchFn = vi.fn(async (input: string) => {
    const url = new URL(input, "https://app.test");
    calls.push(`${url.pathname}${url.search}`);
    const custom = answer(url, calls.length);
    if (custom) return custom;
    if (url.pathname === PROXY_ROUTES.makes) return json(MAKES);
    if (url.pathname === PROXY_ROUTES.models) return json(MODELS[(url.searchParams.get("make") ?? "").toLowerCase()] ?? []);
    return json({ code: "not-found", message: "That wasn't found." }, 404);
  });
  return { calls, fetchFn, models: () => calls.filter((c) => c.startsWith(PROXY_ROUTES.models)), makes: () => calls.filter((c) => c === PROXY_ROUTES.makes) };
}

let app: Awaited<ReturnType<typeof renderApp>> | null = null;
beforeEach(() => { try { sessionStorage.clear(); } catch { /* none */ } });
afterEach(() => { app?.unmount(); app = null; vi.useRealTimers(); });

const located = (): Doc => ({ ...reducer(initialDoc(), { type: "pin", lat: tbone.location.lat, lon: tbone.location.lon, how: "tap" }), directionSet: [true, true] });
const card = (id: string) => document.getElementById(`vehicle-${id}`) as HTMLElement;
const fields = (id: string) => [...card(id).querySelectorAll<HTMLInputElement>("input[type=text]")] as [HTMLInputElement, HTMLInputElement, HTMLInputElement];

/** Type `text` into `input` key by key, `gapMs` apart, pausing `pauses[i]` ms after the i-th character. */
async function typeLikeAPerson(input: HTMLInputElement, typed: string, gapMs = 160, pauses: Record<number, number> = {}): Promise<void> {
  setValue(input, "");
  await vi.advanceTimersByTimeAsync(gapMs);
  for (let i = 1; i <= typed.length; i++) {
    setValue(input, typed.slice(0, i));
    await vi.advanceTimersByTimeAsync(gapMs + (pauses[i] ?? 0));
  }
}

async function openVehicles(api: ReturnType<typeof fakeApi>) {
  const { services } = makeServices({ vehicles: createVehiclesService(api.fetchFn) });
  vi.useFakeTimers({ shouldAdvanceTime: true });
  app = await renderApp(services, { hash: "#vehicles", storage: located() });
  await vi.advanceTimersByTimeAsync(LOOKUP_DEBOUNCE_MS + 100);
  await flush();
}

describe("resolveMake", () => {
  it("finds the makes list's spelling by name, case and spacing aside, and by an everyday alias", () => {
    expect(resolveMake("honda", MAKES)).toBe("Honda");
    expect(resolveMake("  HONDA ", MAKES)).toBe("Honda");
    expect(resolveMake("chevy", MAKES)).toBe("Chevrolet");
    expect(resolveMake("Chevy", MAKES)).toBe("Chevrolet");
    expect(resolveMake("mercedes benz", MAKES)).toBe("Mercedes-Benz");
    expect(resolveMake("VW", MAKES)).toBe("Volkswagen");
    // Half-typed or unknown: not a make (yet).
    expect(resolveMake("chev", MAKES)).toBeNull();
    expect(resolveMake("Hond", MAKES)).toBeNull();
    expect(resolveMake("c", MAKES)).toBeNull();
    // An alias whose make isn't in the list is not used.
    expect(resolveMake("caddy", MAKES)).toBeNull();
  });
});

describe("typing two vehicles like a person", () => {
  it("'2019', 'chevy', 'silverado' for B, then A changed the same way: one model list per make and year, no busy text", async () => {
    const api = fakeApi();
    await openVehicles(api);
    // Opening the step: the makes list once, and vehicle A's claim make and year once.
    expect(api.makes()).toHaveLength(1);
    expect(api.models()).toEqual([`${PROXY_ROUTES.models}?make=Honda&year=2021`]);

    const [byear, bmake, bmodel] = fields("B");
    await typeLikeAPerson(byear, "2019");
    await vi.advanceTimersByTimeAsync(500);           // moves to the make box
    await typeLikeAPerson(bmake, "chevy", 160, { 4: 700 });   // a pause after "chev", longer than the debounce
    await vi.advanceTimersByTimeAsync(600);
    await typeLikeAPerson(bmodel, "silverado");
    await vi.advanceTimersByTimeAsync(1500);
    await flush();
    // "chev" was never asked for; "chevy" was asked for as Chevrolet; the model box filters the list locally.
    expect(api.models()).toEqual([`${PROXY_ROUTES.models}?make=Honda&year=2021`, `${PROXY_ROUTES.models}?make=Chevrolet&year=2019`]);
    expect([...card("B").querySelectorAll("datalist option")].map((o) => o.getAttribute("value"))).toEqual(["Malibu", "Silverado 1500"]);

    const [ayear, amake, amodel] = fields("A");
    await typeLikeAPerson(ayear, "2019");
    await vi.advanceTimersByTimeAsync(100);           // straight on to the make box: no pause long enough for Honda 2019
    await typeLikeAPerson(amake, "chevy", 160, { 4: 700 });
    await typeLikeAPerson(amodel, "silverado");
    await vi.advanceTimersByTimeAsync(1500);
    await flush();
    // A's Chevrolet 2019 is the same list as B's: no new request.
    expect(api.models()).toHaveLength(2);
    expect(api.makes()).toHaveLength(1);
    expect(text()).not.toMatch(/busy|map requests/i);
    expect(text(card("A"))).toContain("models for 2019");
  });

  it("debounces: a make typed quickly is one request, and a half-typed make the list doesn't know is never asked for", async () => {
    const api = fakeApi();
    await openVehicles(api);
    const before = api.models().length;
    const [year, make] = fields("B");
    await typeLikeAPerson(year, "2019", 120);
    await typeLikeAPerson(make, "Toyota", 120);
    await vi.advanceTimersByTimeAsync(LOOKUP_DEBOUNCE_MS + 100);
    await flush();
    expect(api.models().slice(before)).toEqual([`${PROXY_ROUTES.models}?make=Toyota&year=2019`]);
    // "Hond", left for longer than the debounce but less than the extra wait for an unknown make, then "a".
    await typeLikeAPerson(make, "Hond", 120, { 4: LOOKUP_DEBOUNCE_MS + UNKNOWN_MAKE_WAIT_MS - 300 });
    setValue(make, "Honda");
    await vi.advanceTimersByTimeAsync(LOOKUP_DEBOUNCE_MS + 100);
    await flush();
    expect(api.models().slice(before)).toEqual([`${PROXY_ROUTES.models}?make=Toyota&year=2019`, `${PROXY_ROUTES.models}?make=Honda&year=2019`]);
  });

  it("a make the list doesn't know is still asked for once the claimant stops typing (vPIC may know it)", async () => {
    const api = fakeApi();
    await openVehicles(api);
    const [year, make] = fields("B");
    await typeLikeAPerson(year, "2019", 120);
    await typeLikeAPerson(make, "Zork", 120);
    await vi.advanceTimersByTimeAsync(LOOKUP_DEBOUNCE_MS + UNKNOWN_MAKE_WAIT_MS + 200);
    await flush();
    expect(api.models()).toContain(`${PROXY_ROUTES.models}?make=Zork&year=2019`);
    expect(text(card("B"))).toContain("No Zork models found for 2019. Pick the type below.");
  });

  it("caches for the session: a reloaded page in the same tab asks for nothing it already has", async () => {
    const api = fakeApi();
    const first = createVehiclesService(api.fetchFn);
    await first.models("chevy", 2019);
    await first.models("Chevrolet", 2019);
    expect(api.calls).toEqual([PROXY_ROUTES.makes, `${PROXY_ROUTES.models}?make=Chevrolet&year=2019`]);
    // A new service (a reload) reads sessionStorage first.
    const again = fakeApi();
    const second = createVehiclesService(again.fetchFn);
    expect(await second.models("CHEVY ", 2019)).toEqual(MODELS.chevrolet);
    expect(second.canonicalMake("chevy")).toBe("Chevrolet");
    expect(again.calls).toEqual([]);
  });
});

describe("when the makes list fails", () => {
  it("is not asked for again on every lookup, and a half-typed make still waits before it is asked for", async () => {
    const api = fakeApi((url) => (url.pathname === PROXY_ROUTES.makes ? json({ code: "upstream", message: "x" }, 502) : null));
    await openVehicles(api);
    const [year, make] = fields("B");
    await typeLikeAPerson(year, "2019", 120);
    // "chev", a pause longer than the debounce but shorter than the unknown-make wait, then "rolet".
    await typeLikeAPerson(make, "chev", 120, { 4: LOOKUP_DEBOUNCE_MS + UNKNOWN_MAKE_WAIT_MS - 300 });
    setValue(make, "chevrolet");
    await vi.advanceTimersByTimeAsync(LOOKUP_DEBOUNCE_MS + UNKNOWN_MAKE_WAIT_MS + 200);
    await flush();
    expect(api.makes()).toHaveLength(1);
    expect(api.models().filter((p) => p.includes("year=2019"))).toEqual([`${PROXY_ROUTES.models}?make=chevrolet&year=2019`]);
  });
});

describe("busy answers", () => {
  it("are retried after their Retry-After before anything is shown", async () => {
    const api = fakeApi((url, n) => (url.pathname === PROXY_ROUTES.models && n <= 3 ? busy(1) : null));
    await openVehicles(api);
    await vi.advanceTimersByTimeAsync(2500);
    await flush();
    expect(api.models().length).toBeGreaterThanOrEqual(2);
    // The list arrived: the claim's Accord was matched and its type filled from vPIC.
    expect(text(card("A"))).toContain("Car from NHTSA vPIC");
    expect(text()).not.toMatch(/busy|map requests/i);
  });

  it("that last past the retries say so about the vehicle list, never the map", async () => {
    const api = fakeApi((url) => (url.pathname === PROXY_ROUTES.models ? busy(1) : null));
    await openVehicles(api);
    await vi.advanceTimersByTimeAsync(3500);
    await flush();
    expect(text(card("A"))).toContain(`${VEHICLE_LOOKUP_MESSAGES.busy} Pick the type below.`);
    expect(text()).not.toMatch(/map requests/i);
    // 2.5 s of waiting at 1 s each: the first try and three retries (1 s, 1 s, 0.5 s), no more.
    expect(api.models()).toHaveLength(4);
  });
});

describe("retryBusy (every /api call the app makes through getJsonRetrying)", () => {
  it("counts wall time from the first try: when the proxy already queued each try, it stops after the budget, not 4 tries later", async () => {
    vi.useFakeTimers({ now: 0 });
    // Each try spends 2 s queued in the proxy, then answers busy with Retry-After 1.
    const queued = (ms: number) => async () => { await new Promise((r) => setTimeout(r, ms)); throw new ServiceError("busy", "busy", 1); };
    let tries = 0;
    const slow = retryBusy(async () => { tries++; return queued(2000)(); }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await slow).toMatchObject({ code: "busy" });
    // Try at 0 s (answer at 2 s), wait the 0.5 s left, try at 2.5 s (answer at 4.5 s), then give up.
    expect(tries).toBe(2);
    // A try that used the whole 2.5 s in the proxy is not retried at all.
    tries = 0;
    const start = Date.now();
    const slower = retryBusy(async () => { tries++; return queued(2500)(); }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await slower).toMatchObject({ code: "busy" });
    expect(tries).toBe(1);
    expect(start).toBe(10_000);
  });

  it("honours Retry-After and stops after 2.5 s of waiting in all", async () => {
    const waits: number[] = [];
    let tries = 0;
    const failing = retryBusy(async () => { tries++; throw new ServiceError("busy", "busy", 2); }, { sleep: async (ms) => { waits.push(ms); } });
    await expect(failing).rejects.toMatchObject({ code: "busy" });
    expect(waits).toEqual([2000, 500]);
    expect(tries).toBe(3);
    expect(BUSY_TOTAL_WAIT_MS).toBe(2500);
  });

  it("retries only busy answers, and the caller typing on stops the wait", async () => {
    let tries = 0;
    await expect(retryBusy(async () => { tries++; throw new ServiceError("down", "upstream"); }, { sleep: async () => undefined })).rejects.toMatchObject({ code: "upstream" });
    expect(tries).toBe(1);
    const ctrl = new AbortController();
    const waiting = retryBusy(async () => { throw new ServiceError("busy", "busy", 1); }, { signal: ctrl.signal, sleep: () => new Promise(() => undefined) });
    ctrl.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  });
});
