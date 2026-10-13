// @vitest-environment jsdom
// The vehicle picker: year, make and model as type-ahead lists (WAI-ARIA comboboxes) over NHTSA vPIC.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUSY_MESSAGE, PROXY_ROUTES } from "@csd/core";
import { modelsFailedText, vehicleListReason } from "../src/components/VehicleCard";
import { createFixtureVehicles } from "../src/services/fixtures";
import { VEHICLE_LOOKUP_MESSAGES, createVehiclesService } from "../src/services/vehicles";
import { ServiceError, type ModelsOptions, type VehiclesService } from "../src/services/types";
import { STORAGE_KEY, initialDoc, reducer, type Doc } from "../src/state/doc";
import { get, key, renderApp, setValue } from "./helpers";
import { makeServices, tbone, withAccordA } from "./fakes";

let app: Awaited<ReturnType<typeof renderApp>> | null = null;
afterEach(() => { app?.unmount(); app = null; vi.useRealTimers(); });

// A already holds a 2021 Honda Accord (the old default claim), so opening the step asks for its model list.
const located = (): Doc => withAccordA({ ...reducer(initialDoc(), { type: "pin", lat: tbone.location.lat, lon: tbone.location.lon, how: "tap" }), directionSet: [true, true] });
const card = (id: string) => document.getElementById(`vehicle-${id}`) as HTMLElement;
const field = (id: string, which: "year" | "make" | "model") => card(id).querySelector<HTMLInputElement>(`input[id$="-${which}"]`)!;
const listOf = (input: HTMLInputElement) => document.getElementById(input.getAttribute("aria-controls") ?? "");
const rows = (input: HTMLInputElement) => [...(listOf(input)?.querySelectorAll('[role="option"]') ?? [])] as HTMLElement[];
const rowNames = (input: HTMLInputElement) => rows(input).map((r) => r.querySelector(".r-main")?.textContent ?? "");
const active = (input: HTMLInputElement) => {
  const id = input.getAttribute("aria-activedescendant");
  return id ? document.getElementById(id)?.querySelector(".r-main")?.textContent ?? null : null;
};
const stored = () => (JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? "{}") as Doc).scene.vehicles;

/** Type like a person: one character at a time, a short pause after each. */
async function typeLikeAPerson(input: HTMLInputElement, text: string) {
  act(() => input.focus());
  for (let i = 1; i <= text.length; i++) {
    setValue(input, text.slice(0, i));
    await act(async () => { await vi.advanceTimersByTimeAsync(90); });
  }
}
const settle = async (ms = 400) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

function spied(inner: Pick<VehiclesService, "makes" | "models"> & Partial<Pick<VehiclesService, "canonicalMake">>) {
  const makes = vi.fn(() => inner.makes());
  const models = vi.fn((make: string, year: number, opts?: ModelsOptions) => inner.models(make, year, opts));
  const canonicalMake = (text: string) => inner.canonicalMake?.(text) ?? null;
  return { vehicles: { makes, models, canonicalMake } satisfies VehiclesService, makes, models };
}
/** The make and year of each models call (the third argument is the caller's abort signal). */
const asked = (s: ReturnType<typeof spied>) => s.models.mock.calls.map(([mk, y]) => [mk, y] as const);

describe("vehicle picker: keyboard", () => {
  it("2019, chevy, silverado: Enter takes the best match each time and the type fills in as a pickup", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const s = spied(createFixtureVehicles());
    const { services } = makeServices({ vehicles: s.vehicles });
    app = await renderApp(services, { hash: "#vehicles", storage: located() });
    await settle();
    const year = field("B", "year");
    const make = field("B", "make");
    const model = field("B", "model");

    // Year: the list is open while typing and shows the one match.
    await typeLikeAPerson(year, "2019");
    expect(year.getAttribute("role")).toBe("combobox");
    expect(year.getAttribute("aria-expanded")).toBe("true");
    expect(rowNames(year)).toEqual(["2019"]);
    expect(active(year)).toBe("2019");
    key(year, "Enter");
    await settle(10);
    expect(document.activeElement).toBe(make);

    // Make: "chevy" is Chevrolet, first and highlighted; arrows move and wrap.
    await typeLikeAPerson(make, "chevy");
    expect(make.getAttribute("aria-expanded")).toBe("true");
    expect(rowNames(make)[0]).toBe("Chevrolet");
    expect(rowNames(make).at(-1)).toBe("Use ‘chevy’ as typed");
    expect(active(make)).toBe("Chevrolet");
    key(make, "ArrowDown");
    expect(active(make)).not.toBe("Chevrolet");
    key(make, "ArrowUp");
    expect(active(make)).toBe("Chevrolet");
    key(make, "ArrowUp");
    expect(active(make)).toBe("Use ‘chevy’ as typed");
    key(make, "ArrowDown");
    expect(active(make)).toBe("Chevrolet");
    key(make, "Enter");
    await settle(10);
    expect(make.value).toBe("Chevrolet");
    expect(document.activeElement).toBe(model);

    // Model: the list loads for Chevrolet 2019, then "silverado" finds Silverado 1500.
    await settle();
    expect(model.getAttribute("aria-expanded")).toBe("true");
    expect(rowNames(model)).toContain("Silverado 1500");
    await typeLikeAPerson(model, "silverado");
    expect(rowNames(model)[0]).toBe("Silverado 1500");
    expect(rows(model)[0]?.textContent).toContain("Pickup");
    key(model, "Enter");
    await settle(10);
    expect(model.value).toBe("Silverado 1500");
    expect(model.getAttribute("aria-expanded")).toBe("false");
    expect(card("B").querySelector(".type-auto strong")?.textContent).toBe("Pickup");   // filled in, no question asked
    expect(card("B").querySelector(".lookup")?.textContent).toContain("Pickup from NHTSA vPIC (Truck). Weight and size: pickup class average.");
    expect(stored()[1]).toMatchObject({ year: 2019, make: "Chevrolet", model: "Silverado 1500", type: "pickup", typeSource: "vpic" });

    // One makes request for the page, one models request for Chevrolet 2019; none per keystroke.
    expect(s.makes).toHaveBeenCalledTimes(1);
    expect(asked(s).filter(([mk]) => mk !== "Honda")).toEqual([["Chevrolet", 2019]]);
  });

  it("Escape closes the list and keeps the text; ArrowDown opens it again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { services } = makeServices({ vehicles: createFixtureVehicles() });
    app = await renderApp(services, { hash: "#vehicles", storage: located() });
    await settle();
    const make = field("B", "make");
    await typeLikeAPerson(make, "toyta");
    expect(rowNames(make)[0]).toBe("Toyota");
    const esc = key(make, "Escape");
    expect(esc.defaultPrevented).toBe(true);
    expect(make.getAttribute("aria-expanded")).toBe("false");
    expect(make.value).toBe("toyta");
    key(make, "ArrowDown");
    expect(make.getAttribute("aria-expanded")).toBe("true");
    expect(active(make)).toBe("Toyota");
  });

  it("a tap on a row picks it; focus on an empty make shows the popular makes first", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { services } = makeServices({ vehicles: createFixtureVehicles() });
    app = await renderApp(services, { hash: "#vehicles", storage: located() });
    await settle();
    const make = field("B", "make");
    act(() => make.focus());
    expect(rowNames(make).slice(0, 3)).toEqual(["Toyota", "Ford", "Chevrolet"]);
    expect(make.getAttribute("aria-activedescendant")).toBeNull();
    const vw = rows(make).find((r) => r.textContent === "Volkswagen")!;
    act(() => { vw.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); vw.click(); });
    await settle(10);
    expect(make.value).toBe("Volkswagen");
  });

  it("leaving the make field after typing an alias turns it into vPIC's name", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { services } = makeServices({ vehicles: createFixtureVehicles() });
    app = await renderApp(services, { hash: "#vehicles", storage: located() });
    await settle();
    const make = field("B", "make");
    await typeLikeAPerson(make, "vw");
    act(() => make.blur());
    expect(make.value).toBe("Volkswagen");
    // A model typed "jetta" becomes "Jetta" when the field is left, with its type.
    await typeLikeAPerson(field("B", "year"), "2015");
    const model = field("B", "model");
    await typeLikeAPerson(model, "jetta");
    await settle();
    act(() => model.blur());
    expect(model.value).toBe("Jetta");
    expect(card("B").querySelector(".type-auto strong")?.textContent).toBe("Car");   // filled in, no question asked
  });
});

describe("vehicle picker: free text", () => {
  it("a make and model vPIC doesn't know are kept as typed, and the type is picked by hand", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const s = spied(createFixtureVehicles());
    const { services } = makeServices({ vehicles: s.vehicles });
    app = await renderApp(services, { hash: "#vehicles", storage: located() });
    await settle();
    await typeLikeAPerson(field("B", "year"), "2019");
    const make = field("B", "make");
    await typeLikeAPerson(make, "Zephyr");
    expect(rowNames(make)).toEqual(["Use ‘Zephyr’ as typed"]);
    key(make, "Enter");
    await settle(800);
    expect(make.value).toBe("Zephyr");
    // vPIC may know a make outside the list, so it is asked for once (as typed), and says it has no models.
    expect(card("B").querySelector(".lookup")?.textContent).toContain("No Zephyr models found for 2019. Pick the type below.");
    const model = field("B", "model");
    act(() => model.focus());
    expect(listOf(model)?.parentElement?.textContent).toContain("vPIC has no Zephyr models for 2019. Type the model; it still works.");
    await typeLikeAPerson(model, "Roadster");
    expect(rowNames(model)).toEqual(["Use ‘Roadster’ as typed"]);
    key(model, "Enter");
    expect(model.value).toBe("Roadster");
    act(() => { get("radio", "Car", card("B")).click(); });
    expect(stored()[1]).toMatchObject({ make: "Zephyr", model: "Roadster", type: "car", typeSource: "manual" });
    // Once for the whole make, never for "Ze", "Zep"... while it was being typed.
    expect(asked(s).filter(([mk]) => /^ze/i.test(mk))).toEqual([["Zephyr", 2019]]);
  });

  it("when the makes list can't load, the make is still typed, and its models are asked for once typing stops", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const inner = createFixtureVehicles();
    const s = spied({ makes: () => Promise.reject(new Error("down")), models: (m, y) => inner.models(m, y) });
    const { services } = makeServices({ vehicles: s.vehicles });
    app = await renderApp(services, { hash: "#vehicles", storage: located() });
    await settle();
    await typeLikeAPerson(field("B", "year"), "2019");
    const make = field("B", "make");
    await typeLikeAPerson(make, "Ford");
    expect(listOf(make)?.parentElement?.textContent).toContain("We couldn't load the vehicle list right now. Type the make; it still works.");
    expect(asked(s).filter(([mk]) => /^fo/i.test(mk))).toEqual([]);   // not while typing
    act(() => make.blur());
    await settle(800);
    expect(asked(s).filter(([mk]) => /^fo/i.test(mk))).toEqual([["Ford", 2019]]);
    expect(card("B").querySelector(".lookup")?.textContent).toMatch(/Ford models for 2019/);
  });
});

describe("vehicle picker: details", () => {
  it("year and make say how many suggestions there are, in a live region that is always there", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { services } = makeServices({ vehicles: createFixtureVehicles() });
    app = await renderApp(services, { hash: "#vehicles", storage: located() });
    await settle();
    const live = (input: HTMLInputElement) => input.closest(".vcombo")?.querySelector<HTMLElement>("[aria-live=polite]") ?? null;
    const make = field("B", "make");
    expect(live(make)).not.toBeNull();
    expect(live(make)?.textContent).toBe("");
    expect(live(field("B", "year"))).not.toBeNull();
    expect(live(field("B", "model"))).toBeNull();   // the model list has its own status line
    await typeLikeAPerson(make, "chevy");
    expect(live(make)?.textContent).toBe("");        // not on every keystroke
    await settle(700);
    expect(live(make)?.textContent).toBe("1 suggestion. Use the arrow keys.");
    key(make, "Escape");
    await settle(700);
    expect(live(make)?.textContent).toBe("");
  });

  it("make and model take at most 60 and 80 characters", async () => {
    const { services } = makeServices({ vehicles: createFixtureVehicles() });
    app = await renderApp(services, { hash: "#vehicles", storage: located() });
    expect(field("B", "make").maxLength).toBe(60);
    expect(field("B", "model").maxLength).toBe(80);
    expect(field("B", "year").maxLength).toBe(4);
  });

  it("'chevy silverado' typed in Model finds Silverado 1500, and 'harley' in Make is Harley-Davidson", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { services } = makeServices({ vehicles: createFixtureVehicles() });
    app = await renderApp(services, { hash: "#vehicles", storage: located() });
    await settle();
    await typeLikeAPerson(field("B", "year"), "2019");
    await typeLikeAPerson(field("B", "make"), "chevy");
    key(field("B", "make"), "Enter");
    await settle(800);
    const model = field("B", "model");
    await typeLikeAPerson(model, "chevy silverado");
    expect(rowNames(model)[0]).toBe("Silverado 1500");
    key(model, "Enter");
    expect(model.value).toBe("Silverado 1500");
    expect(card("B").querySelector(".type-auto strong")?.textContent).toBe("Pickup");   // filled in, no question asked
    await typeLikeAPerson(field("B", "make"), "harley");
    expect(rowNames(field("B", "make"))[0]).toBe("Harley-Davidson");
  });
});

describe("vehicle picker: requests", () => {
  /** The real service over a fake /api that answers like the proxy and counts what it is asked. */
  function countingFetch() {
    const urls: string[] = [];
    const fetchFn = vi.fn(async (url: string) => {
      urls.push(url);
      if (url.startsWith(PROXY_ROUTES.makes)) return new Response(JSON.stringify(["Chevrolet", "Chrysler", "Ford", "Honda", "Toyota", "Volkswagen"]), { headers: { "content-type": "application/json" } });
      const u = new URL(url, "https://app.test");
      const body = u.searchParams.get("make") === "Chevrolet"
        ? [{ name: "Colorado", vpicType: "Truck", type: "pickup" }, { name: "Silverado", vpicType: "Truck", type: "pickup" }, { name: "Silverado HD", vpicType: "Truck", type: "pickup" }]
        : [{ name: "Accord", vpicType: "Passenger Car", type: "car" }];
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    });
    return { urls, fetchFn };
  }

  it("typing 2019 chevy silverado costs one makes request and one models request", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { urls, fetchFn } = countingFetch();
    const { services } = makeServices({ vehicles: createVehiclesService(fetchFn) });
    app = await renderApp(services, { hash: "#vehicles", storage: located() });
    await settle(1000);
    const claimCalls = urls.length;   // the makes list, and vehicle A's own model list (Honda, from the claim)
    expect(urls).toEqual([PROXY_ROUTES.makes, `${PROXY_ROUTES.models}?make=Honda&year=2021`]);
    expect(urls.filter((u) => u.startsWith(PROXY_ROUTES.makes))).toHaveLength(1);
    await typeLikeAPerson(field("B", "year"), "2019");
    await typeLikeAPerson(field("B", "make"), "chevy");
    key(field("B", "make"), "Enter");
    await settle();
    await typeLikeAPerson(field("B", "model"), "silverado");
    key(field("B", "model"), "Enter");
    await settle();
    expect(field("B", "model").value).toBe("Silverado");
    expect(card("B").querySelector(".type-auto strong")?.textContent).toBe("Pickup");   // filled in, no question asked
    const mine = urls.slice(claimCalls);
    expect(mine).toEqual([`${PROXY_ROUTES.models}?make=Chevrolet&year=2019`]);
    // Vehicle C, the same make and year: no new request (the session cache).
    act(() => { get("button", /Add another vehicle/).click(); });
    await settle();
    await typeLikeAPerson(field("C", "year"), "2019");
    await typeLikeAPerson(field("C", "make"), "Chevrolet");
    await settle();
    expect(urls.slice(claimCalls)).toHaveLength(1);
  });

  it("the service caches makes once and models once per make and year, whatever the spelling", async () => {
    window.sessionStorage.clear();   // the service also keeps the lists in sessionStorage
    const { urls, fetchFn } = countingFetch();
    const svc = createVehiclesService(fetchFn);
    await Promise.all([svc.makes(), svc.makes()]);
    await svc.makes();
    await Promise.all([svc.models("Chevrolet", 2019), svc.models("chevrolet", 2019), svc.models(" CHEVROLET ", 2019)]);
    await svc.models("Chevrolet", 2020);
    expect(urls).toEqual([PROXY_ROUTES.makes, `${PROXY_ROUTES.models}?make=Chevrolet&year=2019`, `${PROXY_ROUTES.models}?make=Chevrolet&year=2020`]);
  });

  it("a model list that stays busy after the retries is not cached, and is worded for the vehicle list, never the map", async () => {
    window.sessionStorage.clear();
    let fail = true;
    const answer = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    const fetchFn = vi.fn(async (url: string) => {
      if (url.startsWith(PROXY_ROUTES.makes)) return answer(["Ford"]);
      return fail ? answer({ code: "busy", message: BUSY_MESSAGE, retryAfterS: 1 }, 429) : answer([{ name: "F-150", vpicType: "Truck", type: "pickup" }]);
    });
    const svc = createVehiclesService(fetchFn, { sleep: async () => undefined });
    const err = await svc.models("Ford", 2019).catch((e: unknown) => e);
    expect(vehicleListReason(err)).toBe(VEHICLE_LOOKUP_MESSAGES.busy);
    expect(modelsFailedText(vehicleListReason(err))).toBe("The vehicle list is busy right now. Type the model; it still works.");
    expect(vehicleListReason(new ServiceError(BUSY_MESSAGE, "busy"))).toBe(VEHICLE_LOOKUP_MESSAGES.other);
    const tries = fetchFn.mock.calls.length;
    expect(tries).toBeGreaterThan(2);   // the makes list, then the busy model list tried more than once
    fail = false;
    await expect(svc.models("Ford", 2019)).resolves.toEqual([{ name: "F-150", vpicType: "Truck", type: "pickup" }]);
    expect(fetchFn.mock.calls.length).toBe(tries + 1);
  });
});
