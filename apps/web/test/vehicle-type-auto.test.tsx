// @vitest-environment jsdom
// The vehicle type is picked from NHTSA vPIC, never asked (owner's brief, 2026-10-11): once year, make and model
// are known the type fills in and the tiles stay hidden behind "Not right? Change type"; they show on their own
// only when vPIC has no answer. A hand-picked type is kept for its model through a year change.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { typeFromVpic, type VehicleType } from "@csd/core";
import { createFixtureVehicles } from "../src/services/fixtures";
import { ServiceError } from "../src/services/types";
import { STORAGE_KEY, initialDoc, reducer, type Doc } from "../src/state/doc";
import { get, key, renderApp, setValue } from "./helpers";
import { makeServices, tbone, withAnswers } from "./fakes";

let app: Awaited<ReturnType<typeof renderApp>> | null = null;
afterEach(() => { app?.unmount(); app = null; vi.useRealTimers(); });

const located = (): Doc => withAnswers({ ...reducer(initialDoc(), { type: "pin", lat: tbone.location.lat, lon: tbone.location.lon, how: "tap" }), directionSet: [true, true] });
const card = (id: string) => document.getElementById(`vehicle-${id}`) as HTMLElement;
const field = (id: string, which: "year" | "make" | "model") => card(id).querySelector<HTMLInputElement>(`input[id$="-${which}"]`)!;
const stored = () => (JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? "{}") as Doc).scene.vehicles;
const settle = async (ms = 400) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const tiles = (id: string) => card(id).querySelectorAll('[aria-label^="Type of vehicle"] [role="radio"]').length;
const shownType = (id: string) => card(id).querySelector(".type-auto strong")?.textContent ?? null;

async function enter(id: string, year: string, make: string, model: string) {
  for (const [which, text] of [["year", year], ["make", make], ["model", model]] as const) {
    const input = field(id, which);
    act(() => input.focus());
    setValue(input, text);
    await settle(which === "make" ? 800 : 100);
    if (which !== "year") key(input, "Enter");
    await settle(which === "make" ? 800 : 100);
  }
  act(() => field(id, "model").blur());
  await settle(100);
}

// Common models across years: [make, year, model, vPIC VehicleTypeName, expected type].
const COMMON: readonly (readonly [string, number, string, string, VehicleType])[] = [
  ["Ford", 2012, "F-150", "Truck", "pickup"], ["Ford", 2022, "F-250", "Truck", "pickup"], ["Ford", 2005, "F-350", "Truck", "pickup"],
  ["Chevrolet", 2019, "Silverado 1500", "Truck", "pickup"], ["Ram", 2020, "1500", "Truck", "pickup"], ["Toyota", 2016, "Tacoma", "Truck", "pickup"],
  ["Toyota", 2021, "Tundra", "Truck", "pickup"], ["Nissan", 2010, "Frontier", "Truck", "pickup"], ["Honda", 2018, "Ridgeline", "Truck", "pickup"],
  ["Jeep", 2021, "Gladiator", "Truck", "pickup"], ["Tesla", 2024, "Cybertruck", "Truck", "pickup"], ["Hyundai", 2023, "Santa Cruz", "Truck", "pickup"],
  ["Honda", 2008, "CR-V", "Multipurpose Passenger Vehicle (MPV)", "suv"], ["Toyota", 2015, "RAV4", "Multipurpose Passenger Vehicle (MPV)", "suv"],
  ["Ford", 2014, "Escape", "Multipurpose Passenger Vehicle (MPV)", "suv"], ["Chevrolet", 2003, "Tahoe", "Multipurpose Passenger Vehicle (MPV)", "suv"],
  ["Honda", 2011, "Odyssey", "Multipurpose Passenger Vehicle (MPV)", "van"], ["Toyota", 2019, "Sienna", "Multipurpose Passenger Vehicle (MPV)", "van"],
  ["Chrysler", 2018, "Pacifica", "Multipurpose Passenger Vehicle (MPV)", "van"], ["Kia", 2023, "Carnival", "Multipurpose Passenger Vehicle (MPV)", "van"],
  ["Ford", 2017, "Transit", "Truck", "van"], ["Ram", 2016, "ProMaster", "Truck", "van"], ["Mercedes-Benz", 2015, "Sprinter", "Truck", "van"],
  ["Honda", 1999, "Accord", "Passenger Car", "car"], ["Toyota", 2010, "Camry", "Passenger Car", "car"], ["Honda", 2020, "Civic", "Passenger Car", "car"],
  ["Tesla", 2021, "Model 3", "Passenger Car", "car"], ["Harley-Davidson", 2015, "Street Glide", "Motorcycle", "motorcycle"],
  ["Isuzu", 2018, "NPR", "Truck", "truck"], ["Ford", 2010, "E-450", "Truck", "truck"], ["Chevrolet", 2020, "4500HD", "Truck", "truck"],
];

describe("typeFromVpic: vPIC's VehicleTypeName plus the model-name tables", () => {
  it.each(COMMON)("%s %d %s (%s) is a %s", (_make, _year, model, vpicType, want) => {
    expect(typeFromVpic(vpicType, model)).toBe(want);
  });
  it("the offline vPIC slice types every one of them the same way, in its model year", async () => {
    const fx = createFixtureVehicles();
    for (const [make, year, model, , want] of COMMON) {
      const m = (await fx.models(make, year)).find((x) => x.name === model);
      expect(m?.type, `${year} ${make} ${model}`).toBe(want);
    }
  });
  it("leaves a vPIC type it can't place to the claimant", () => {
    expect(typeFromVpic("Bus", "Coach")).toBeNull();
    expect(typeFromVpic("Low Speed Vehicle (LSV)", "Cart")).toBeNull();
  });
});

describe("vehicle type: filled in from vPIC, never a required question", () => {
  it("hides the tiles, shows the type with 'Not right? Change type', and keeps a hand pick through a year change until the model changes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { services } = makeServices({ vehicles: createFixtureVehicles() });
    app = await renderApp(services, { hash: "#vehicles", storage: located() });
    await settle();
    expect(tiles("B")).toBe(0);                           // not asked before anything is entered
    await enter("B", "2019", "Toyota", "Sienna");
    expect(shownType("B")).toBe("Van");
    expect(tiles("B")).toBe(0);
    expect(card("B").querySelector(".lookup")?.textContent).toContain("Van from NHTSA vPIC");
    expect(stored()[1]).toMatchObject({ model: "Sienna", type: "van", typeSource: "vpic" });

    // Override: open the tiles and pick SUV.
    act(() => { get("button", /Not right\? Change the type of vehicle B/, card("B")).click(); });
    expect(tiles("B")).toBe(6);
    act(() => { get("radio", /^SUV/, card("B")).click(); });
    expect(stored()[1]).toMatchObject({ type: "suv", typeSource: "manual" });
    expect(card("B").querySelector(".lookup")?.textContent).toContain("SUV, your pick. NHTSA vPIC says Van");

    // A new year looks the model up again, and the hand pick stands.
    const year = field("B", "year");
    act(() => year.focus());
    setValue(year, "2020");
    await settle(1200);
    expect(stored()[1]).toMatchObject({ year: 2020, model: "Sienna", type: "suv", typeSource: "manual" });

    // A new model: vPIC picks again and the tiles fold away.
    const model = field("B", "model");
    act(() => model.focus());
    setValue(model, "Camry");
    key(model, "Enter");
    await settle(200);
    act(() => model.blur());
    await settle(100);
    expect(stored()[1]).toMatchObject({ model: "Camry", type: "car", typeSource: "vpic" });
    expect(shownType("B")).toBe("Car");
    expect(tiles("B")).toBe(0);
  });

  it("picks for an added vehicle too, and re-picks when the year changes the answer", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { services } = makeServices({ vehicles: createFixtureVehicles() });
    app = await renderApp(services, { hash: "#vehicles", storage: reducer(located(), { type: "add-vehicle" }) });
    await settle();
    await enter("C", "2021", "Harley-Davidson", "Street Glide");
    expect(shownType("C")).toBe("Motorcycle");
    expect(stored()[2]).toMatchObject({ type: "motorcycle", typeSource: "vpic" });
  });

  it("vPIC down: the tiles show with the reason, a pick works, and the step isn't blocked", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fx = createFixtureVehicles();
    const { services } = makeServices({ vehicles: { ...fx, models: async () => { throw new ServiceError("We couldn't load the vehicle list right now.", "network"); } } });
    app = await renderApp(services, { hash: "#vehicles", storage: located() });
    await settle();
    await enter("B", "2019", "Ford", "F-150");
    expect(card("B").querySelector(".lookup")?.textContent).toContain("Pick the type below.");
    expect(tiles("B")).toBe(6);
    act(() => { get("radio", /^Pickup/, card("B")).click(); });
    expect(stored()[1]).toMatchObject({ model: "F-150", type: "pickup", typeSource: "manual" });
    const next = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => /^(Next|Continue)/.test(b.textContent?.trim() ?? ""));
    expect(next?.disabled ?? false).toBe(false);
  });
});
