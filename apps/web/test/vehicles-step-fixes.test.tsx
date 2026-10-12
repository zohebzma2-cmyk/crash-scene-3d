// @vitest-environment jsdom
// Vehicles step fixes (2026-10-11): a typed nickname is matched once a late makes list lands.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROXY_ROUTES } from "@csd/core";
import { suggestionsCount } from "../src/components/VehicleCombobox";
import { createFixtureVehicles } from "../src/services/fixtures";
import { vehicleModelUrl } from "../src/services/media";
import { createVehiclesService } from "../src/services/vehicles";
import type { VehiclesService } from "../src/services/types";
import { docFromScene, initialDoc, reducer, type Doc } from "../src/state/doc";
import { key, renderApp, setValue } from "./helpers";
import { makeServices, tbone } from "./fakes";

let app: Awaited<ReturnType<typeof renderApp>> | null = null;
afterEach(() => { app?.unmount(); app = null; vi.useRealTimers(); });

const located = (): Doc => ({ ...reducer(initialDoc(), { type: "pin", lat: tbone.location.lat, lon: tbone.location.lon, how: "tap" }), directionSet: [true, true] });
const card = (id: string) => document.getElementById(`vehicle-${id}`) as HTMLElement;
const field = (id: string, which: "year" | "make" | "model") => card(id).querySelector<HTMLInputElement>(`input[id$="-${which}"]`)!;
const listOf = (input: HTMLInputElement) => document.getElementById(input.getAttribute("aria-controls") ?? "");
const rowNames = (input: HTMLInputElement) => [...(listOf(input)?.querySelectorAll('[role="option"]') ?? [])].map((r) => r.querySelector(".r-main")?.textContent ?? "");
const active = (input: HTMLInputElement) => {
  const id = input.getAttribute("aria-activedescendant");
  return id ? document.getElementById(id)?.querySelector(".r-main")?.textContent ?? null : null;
};
async function typeLikeAPerson(input: HTMLInputElement, text: string) {
  act(() => input.focus());
  for (let i = 1; i <= text.length; i++) {
    setValue(input, text.slice(0, i));
    await act(async () => { await vi.advanceTimersByTimeAsync(90); });
  }
}
const settle = async (ms = 400) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

/** The fixture vehicles, with a makes list that lands only when the test says so. */
function lateMakes() {
  const inner = createFixtureVehicles();
  let land: () => void = () => undefined;
  const gate = new Promise<void>((r) => { land = r; });
  const vehicles: VehiclesService = { ...inner, makes: () => gate.then(() => inner.makes()), canonicalMake: (t) => inner.canonicalMake(t) };
  return { vehicles, land: async () => { land(); await settle(10); } };
}

describe("a typed nickname and a late makes list", () => {
  it("'chevy' typed while the makes load is ranked again when they land: Chevrolet first and highlighted", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const late = lateMakes();
    const { services } = makeServices({ vehicles: late.vehicles });
    app = await renderApp(services, { hash: "#vehicles", storage: located() });
    await settle();
    const make = field("B", "make");
    await typeLikeAPerson(make, "chevy");
    expect(rowNames(make)).toEqual(["Use ‘chevy’ as typed"]);
    await late.land();
    expect(rowNames(make)[0]).toBe("Chevrolet");
    expect(active(make)).toBe("Chevrolet");
    key(make, "Enter");
    await settle(10);
    expect(make.value).toBe("Chevrolet");
  });

  it("'chevy' left while the makes load becomes Chevrolet when they land", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const late = lateMakes();
    const { services } = makeServices({ vehicles: late.vehicles });
    app = await renderApp(services, { hash: "#vehicles", storage: located() });
    await settle();
    const make = field("B", "make");
    await typeLikeAPerson(make, "chevy");
    act(() => make.blur());
    await settle(200);
    expect(make.value).toBe("chevy");
    await late.land();
    expect(make.value).toBe("Chevrolet");
  });

  it("'chevy' with Enter on 'Use as typed' while loading is still turned into Chevrolet when the list lands", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const late = lateMakes();
    const { services } = makeServices({ vehicles: late.vehicles });
    app = await renderApp(services, { hash: "#vehicles", storage: located() });
    await settle();
    const make = field("B", "make");
    await typeLikeAPerson(make, "chevy");
    key(make, "Enter");
    await settle(200);
    await late.land();
    expect(make.value).toBe("Chevrolet");
  });

  it("a model typed while its list loads and then left is resolved when the list lands, with its type", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const inner = createFixtureVehicles();
    let land: () => void = () => undefined;
    const gate = new Promise<void>((r) => { land = r; });
    const vehicles: VehiclesService = { ...inner, models: (mk, y, o) => (/chev/i.test(mk) ? gate.then(() => inner.models(mk, y, o)) : inner.models(mk, y, o)), canonicalMake: (t) => inner.canonicalMake(t) };
    const { services } = makeServices({ vehicles });
    app = await renderApp(services, { hash: "#vehicles", storage: located() });
    await settle();
    await typeLikeAPerson(field("B", "year"), "2019");
    await typeLikeAPerson(field("B", "make"), "Chevrolet");
    key(field("B", "make"), "Enter");
    await settle(600);
    const model = field("B", "model");
    await typeLikeAPerson(model, "silverado 1500");
    act(() => model.blur());
    await settle(200);
    expect(model.value).toBe("silverado 1500");
    land();
    await settle(50);
    expect(model.value).toBe("Silverado 1500");
    expect(card("B").querySelector(".lookup")?.textContent).toContain("Pickup from NHTSA vPIC");
  });

  it("a claim's own make is never renamed when the list lands; a 'chevy' kept from earlier in the session is", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const late = lateMakes();
    const { services } = makeServices({ vehicles: late.vehicles });
    const doc = located();
    const s = doc.scene;
    const withAlias: Doc = {
      ...doc,
      scene: { ...s, claim: { ...s.claim, vehicle: { ...s.claim.vehicle, make: "chevy" } }, vehicles: s.vehicles.map((v) => ({ ...v, make: "chevy" })) },
    };
    app = await renderApp(services, { hash: "#vehicles", storage: withAlias });
    await settle();
    await late.land();
    expect(field("A", "make").value).toBe("chevy");
    expect(field("B", "make").value).toBe("Chevrolet");
  });
});

describe("an opened file is drawn as it was saved", () => {
  it("a 'chevy' in an opened file isn't renamed when the list lands, only once the claimant types in it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const late = lateMakes();
    const { services } = makeServices({ vehicles: late.vehicles });
    const opened = docFromScene({ ...tbone, vehicles: tbone.vehicles.map((v) => (v.id === "B" ? { ...v, make: "chevy", model: "" } : v)) }, tbone.location.label);
    app = await renderApp(services, { hash: "#vehicles", storage: opened });
    await settle();
    await late.land();
    expect(field("B", "make").value).toBe("chevy");
    await typeLikeAPerson(field("B", "make"), "chevy");
    act(() => field("B", "make").blur());
    await settle(200);
    expect(field("B", "make").value).toBe("Chevrolet");
  });
});

describe("picker leftovers (item 5)", () => {
  it("an accented make typed by hand is asked for without its accents (no 400), and one the proxy can't take is never asked", async () => {
    window.sessionStorage.clear();
    const urls: string[] = [];
    const fetchFn = vi.fn(async (url: string) => {
      urls.push(url);
      const body = url.startsWith(PROXY_ROUTES.makes) ? ["Ford"] : [];
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    });
    const svc = createVehiclesService(fetchFn, { sleep: async () => undefined });
    await svc.models("Citroën", 2019);
    await svc.models("Škoda", 2019);
    expect(await svc.models("Zephyr #1", 2019)).toEqual([]);
    expect(urls).toEqual([PROXY_ROUTES.makes, `${PROXY_ROUTES.models}?make=Citroen&year=2019`, `${PROXY_ROUTES.models}?make=Skoda&year=2019`]);
    // Photos and models of an accented make are asked for without the accents too.
    expect(vehicleModelUrl({ year: 2019, make: "Škoda", model: "Octavia" })).toBe(`${PROXY_ROUTES.vehicleModel}?make=Skoda&model=Octavia&year=2019`);
  });

  it("the live count says 'No matches. Press Enter to use what you typed.' when only 'Use as typed' is left", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { services } = makeServices({ vehicles: createFixtureVehicles() });
    app = await renderApp(services, { hash: "#vehicles", storage: located() });
    await settle();
    const make = field("B", "make");
    await typeLikeAPerson(make, "Zephyr");
    expect(rowNames(make)).toEqual(["Use ‘Zephyr’ as typed"]);
    expect(active(make)).toBe("Use ‘Zephyr’ as typed");
    await settle(700);
    expect(make.closest(".vcombo")?.querySelector("[aria-live=polite]")?.textContent).toBe("No matches. Press Enter to use what you typed.");
    expect(suggestionsCount(0, false)).toBe("No suggestions.");
  });
});
