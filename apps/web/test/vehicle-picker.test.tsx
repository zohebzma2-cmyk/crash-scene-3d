// @vitest-environment jsdom
// The vehicle picker: year, make and model as type-ahead lists (WAI-ARIA comboboxes) over NHTSA vPIC.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROXY_ROUTES } from "@csd/core";
import { createFixtureVehicles } from "../src/services/fixtures";
import { createVehiclesService } from "../src/services/vehicles";
import type { VehiclesService } from "../src/services/types";
import { STORAGE_KEY, initialDoc, reducer, type Doc } from "../src/state/doc";
import { get, key, renderApp, setValue } from "./helpers";
import { makeServices, tbone } from "./fakes";

let app: Awaited<ReturnType<typeof renderApp>> | null = null;
afterEach(() => { app?.unmount(); app = null; vi.useRealTimers(); });

const located = (): Doc => ({ ...reducer(initialDoc(), { type: "pin", lat: tbone.location.lat, lon: tbone.location.lon, how: "tap" }), directionSet: [true, true] });
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

function spied(inner: VehiclesService) {
  const makes = vi.fn(() => inner.makes());
  const models = vi.fn((make: string, year: number) => inner.models(make, year));
  return { vehicles: { makes, models } satisfies VehiclesService, makes, models };
}

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
    expect(get("radio", /^Pickup/, card("B")).getAttribute("aria-checked")).toBe("true");
    expect(card("B").querySelector(".lookup")?.textContent).toContain("Pickup from NHTSA vPIC (Truck). Weight and size: pickup class average.");
    expect(stored()[1]).toMatchObject({ year: 2019, make: "Chevrolet", model: "Silverado 1500", type: "pickup", typeSource: "vpic" });

    // One makes request for the page, one models request for Chevrolet 2019; none per keystroke.
    expect(s.makes).toHaveBeenCalledTimes(1);
    expect(s.models.mock.calls.filter(([mk]) => mk !== "Honda")).toEqual([["Chevrolet", 2019]]);
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
    expect(get("radio", /^Car/, card("B")).getAttribute("aria-checked")).toBe("true");
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
    await settle();
    expect(make.value).toBe("Zephyr");
    expect(card("B").querySelector(".lookup")?.textContent).toContain("‘Zephyr’ isn't in NHTSA vPIC's list. Pick the type below.");
    const model = field("B", "model");
    act(() => model.focus());
    expect(listOf(model)?.parentElement?.textContent).toContain("No model list for this make. Type the model; it still works.");
    await typeLikeAPerson(model, "Roadster");
    expect(rowNames(model)).toEqual(["Use ‘Roadster’ as typed"]);
    key(model, "Enter");
    expect(model.value).toBe("Roadster");
    act(() => { get("radio", "Car", card("B")).click(); });
    expect(stored()[1]).toMatchObject({ make: "Zephyr", model: "Roadster", type: "car", typeSource: "manual" });
    expect(s.models.mock.calls.some(([mk]) => mk === "Zephyr")).toBe(false);
  });

  it("when the makes list can't load, the make is still typed, and its models are asked for once the field is left", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const inner = createFixtureVehicles();
    const s = spied({ makes: () => Promise.reject(new Error("down")), models: (m, y) => inner.models(m, y) });
    const { services } = makeServices({ vehicles: s.vehicles });
    app = await renderApp(services, { hash: "#vehicles", storage: located() });
    await settle();
    await typeLikeAPerson(field("B", "year"), "2019");
    const make = field("B", "make");
    await typeLikeAPerson(make, "Ford");
    expect(listOf(make)?.parentElement?.textContent).toContain("Couldn't load the list of makes. Type the make; it still works.");
    expect(s.models.mock.calls.some(([mk]) => mk === "Ford")).toBe(false);   // not while typing
    act(() => make.blur());
    await settle();
    expect(s.models.mock.calls.filter(([mk]) => mk === "Ford")).toEqual([["Ford", 2019]]);
    expect(card("B").querySelector(".lookup")?.textContent).toMatch(/Ford models for 2019/);
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
    await settle();
    const claimCalls = urls.length;   // the makes list, and vehicle A's own model list (Honda, from the claim)
    expect(urls.filter((u) => u.startsWith(PROXY_ROUTES.makes))).toHaveLength(1);
    await typeLikeAPerson(field("B", "year"), "2019");
    await typeLikeAPerson(field("B", "make"), "chevy");
    key(field("B", "make"), "Enter");
    await settle();
    await typeLikeAPerson(field("B", "model"), "silverado");
    key(field("B", "model"), "Enter");
    await settle();
    expect(field("B", "model").value).toBe("Silverado");
    expect(get("radio", /^Pickup/, card("B")).getAttribute("aria-checked")).toBe("true");
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
    const { urls, fetchFn } = countingFetch();
    const svc = createVehiclesService(fetchFn);
    await Promise.all([svc.makes(), svc.makes()]);
    await svc.makes();
    await Promise.all([svc.models("Chevrolet", 2019), svc.models("chevrolet", 2019), svc.models(" CHEVROLET ", 2019)]);
    await svc.models("Chevrolet", 2020);
    expect(urls).toEqual([PROXY_ROUTES.makes, `${PROXY_ROUTES.models}?make=Chevrolet&year=2019`, `${PROXY_ROUTES.models}?make=Chevrolet&year=2020`]);
  });

  it("a failed request is not cached: the next ask tries again", async () => {
    let fail = true;
    const fetchFn = vi.fn(async () => (fail ? new Response(JSON.stringify({ code: "busy", message: "x", retryAfterS: 1 }), { status: 429 }) : new Response(JSON.stringify(["Ford"]))));
    const svc = createVehiclesService(fetchFn);
    await expect(svc.makes()).rejects.toThrow();
    fail = false;
    await expect(svc.makes()).resolves.toEqual(["Ford"]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
