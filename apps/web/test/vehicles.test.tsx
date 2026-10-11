// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { STORAGE_KEY, initialDoc, reducer, type Doc } from "../src/state/doc";
import { all, click, flush, get, key, maybe, mockMatchMedia, renderApp, setValue, text } from "./helpers";
import { FORD_MODELS, makeServices, tbone } from "./fakes";

let app: Awaited<ReturnType<typeof renderApp>> | null = null;
afterEach(() => { app?.unmount(); app = null; vi.unstubAllGlobals(); vi.useRealTimers(); });

/** A located scene (the t-bone pin) so the roads load and the directions are road-relative. */
const located = (mutate: (d: Doc) => Doc = (d) => d): Doc => mutate({ ...reducer(initialDoc(), { type: "pin", lat: tbone.location.lat, lon: tbone.location.lon, how: "tap" }), directionSet: [true, true] });
const card = (id: string) => document.getElementById(`vehicle-${id}`) as HTMLElement;

describe("step 2: vehicles", () => {
  it("offers road-relative directions from the streets at the pin, with no east-west/north-south fields", async () => {
    const { services } = makeServices();
    app = await renderApp(services, { hash: "#vehicles", storage: located() });
    await flush(900);
    const radios = all("radio", undefined, card("A")).map((r) => r.textContent);
    expect(radios).toContain("Northbound on Main Street");
    expect(radios).toContain("Southbound on Main Street");
    expect(radios).toContain("Westbound on Park Street");
    expect(text(card("A"))).not.toMatch(/east.?west|north.?south/i);
    // the compass letters are not offered as choices when roads are known
    expect(all("radio", /^(North|East|South|West)$/, card("A"))).toHaveLength(0);
  });

  it("shows the chosen direction as selected, and says it as 'Northbound on Main Street'", async () => {
    const { services } = makeServices();
    app = await renderApp(services, { hash: "#vehicles", storage: located() });
    await flush(900);
    click(get("radio", "Northbound on Main Street", card("A")));
    expect(get("radio", "Northbound on Main Street", card("A")).getAttribute("aria-checked")).toBe("true");
    expect(card("A").querySelector(".dir-caption")?.textContent).toBe("Northbound on Main Street");
  });

  it("never changes a bearing or a road the claimant did not pick when the roads load", async () => {
    const { services } = makeServices();
    const doc = located();   // A faces 0, B faces 90, nothing on a named road
    app = await renderApp(services, { hash: "#vehicles", storage: doc });
    await flush(900);
    const stored = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? "{}") as Doc;
    expect(stored.scene.vehicles.map((x) => x.travel)).toEqual(doc.scene.vehicles.map((x) => x.travel));
  });

  it("choosing a road-relative direction sets the bearing, road and caption on the scene", async () => {
    const { services } = makeServices();
    app = await renderApp(services, { hash: "#vehicles", storage: located() });
    await flush(900);
    click(get("radio", "Westbound on Park Street", card("B")));
    expect(card("B").querySelector(".dir-caption")?.textContent).toBe("Westbound on Park Street");
    const stored = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? "{}") as Doc;
    expect(stored.scene.vehicles[1]?.travel).toMatchObject({ roadName: "Park Street" });
    expect(stored.scene.vehicles[1]?.travel.bearingDeg).toBeGreaterThan(240);
  });

  it("falls back to N/E/S/W only when there is no road data", async () => {
    const { services } = makeServices({ roads: "none" });
    app = await renderApp(services, { hash: "#vehicles", storage: located() });
    await flush(900);
    expect(all("radio", /^(North|East|South|West)$/, card("A")).map((r) => r.getAttribute("aria-label"))).toEqual(["North", "East", "South", "West"]);
    expect(all("radio", /bound on/, card("A"))).toHaveLength(0);
    click(get("radio", "East", card("A")));
    expect(card("A").querySelector(".dir-caption")?.textContent).toBe("Eastbound");
  });

  it("adds up to four vehicles, removes any but A, and re-packs the letters", async () => {
    const { services } = makeServices();
    app = await renderApp(services, { hash: "#vehicles", storage: located() });
    await flush(100);
    click(get("button", /Add another vehicle/));
    click(get("button", /Add another vehicle/));
    expect(maybe("button", /Add another vehicle/)).toBeNull();
    expect([...document.querySelectorAll(".vehicle h2")].map((h) => h.textContent)).toEqual(["Your car", "Vehicle B", "Vehicle C", "Vehicle D"]);
    // C gets a make; remove B; C is now B with its details
    setValue(card("C").querySelector('input[list="dl-makes"]'), "Ford");
    expect(maybe("button", "Remove vehicle A")).toBeNull();
    click(get("button", "Remove vehicle B"));
    await flush();
    expect([...document.querySelectorAll(".vehicle h2")].map((h) => h.textContent)).toEqual(["Your car", "Vehicle B", "Vehicle C"]);
    expect((card("B").querySelector('input[list="dl-makes"]') as HTMLInputElement).value).toBe("Ford");
    expect(text()).toContain("Vehicle removed. 3 vehicles now.");
  });

  it("keeps a card's own state (typed text, focus) when letters re-pack", async () => {
    const { services } = makeServices();
    app = await renderApp(services, { hash: "#vehicles", storage: located((d) => reducer(reducer(d, { type: "add-vehicle" }), { type: "add-vehicle" })) });
    await flush(100);
    const cInput = card("C").querySelector<HTMLInputElement>('input[inputmode="numeric"]')!;
    setValue(cInput, "20");   // half-typed year, held only in the card
    click(get("button", "Remove vehicle B"));
    await flush();
    const nowB = card("B").querySelector<HTMLInputElement>('input[inputmode="numeric"]')!;
    expect(nowB).toBe(cInput);
    expect(nowB.value).toBe("20");
  });

  it("editing your own car never changes the claim header, and the card says it was changed from the claim", async () => {
    const { services } = makeServices();
    app = await renderApp(services, { hash: "#vehicles", storage: located() });
    await flush(100);
    expect(document.querySelector("[data-testid=claim-chip]")?.textContent).toContain("2021 Honda Accord");
    setValue(card("A").querySelector('input[list="dl-makes"]'), "Toyota");
    setValue(card("A").querySelectorAll("input[type=text]")[2] ?? null, "Camry");
    expect(document.querySelector("[data-testid=claim-chip]")?.textContent).toContain("2021 Honda Accord");
    expect(document.querySelector("[data-testid=claim-chip]")?.textContent).not.toContain("Toyota");
    expect(text(card("A"))).toContain("changed from your claim");
  });

  it("changing the make clears the model and reloads the model list for the new make", async () => {
    const { services, models } = makeServices();
    models.mockImplementation(async (make: string) => (make === "Ford" ? FORD_MODELS : [{ name: "Camry", vpicType: "Passenger Car", type: "car" as const }]));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    app = await renderApp(services, { hash: "#vehicles", storage: located() });
    const b = card("B");
    const [year, make, model] = [...b.querySelectorAll<HTMLInputElement>("input[type=text]")] as [HTMLInputElement, HTMLInputElement, HTMLInputElement];
    setValue(year, "2018");
    setValue(make, "Ford");
    await vi.advanceTimersByTimeAsync(600);
    await flush();
    expect(models).toHaveBeenLastCalledWith("Ford", 2018, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    setValue(model, "Escape");
    expect(b.textContent).toContain("SUV from NHTSA vPIC");
    expect(model.value).toBe("Escape");

    setValue(make, "Toyota");
    expect(model.value).toBe("");                         // cleared at once
    expect(b.querySelectorAll("datalist option")).toHaveLength(0);   // and the old make's models are gone
    await vi.advanceTimersByTimeAsync(600);
    await flush();
    expect(models).toHaveBeenLastCalledWith("Toyota", 2018, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect([...b.querySelectorAll("datalist option")].map((o) => o.getAttribute("value"))).toEqual(["Camry"]);
  });

  it("lets the claimant pick the type by hand when vPIC can't help, and shows the vPIC failure as text", async () => {
    const { services, models } = makeServices();
    models.mockRejectedValue(new Error("down"));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    app = await renderApp(services, { hash: "#vehicles", storage: located() });
    const b = card("B");
    const [year, make] = [...b.querySelectorAll<HTMLInputElement>("input[type=text]")] as [HTMLInputElement, HTMLInputElement];
    setValue(year, "2018");
    setValue(make, "Zork");
    await vi.advanceTimersByTimeAsync(600);
    await flush();
    expect(b.textContent).toContain("Pick the type below.");
    click(get("radio", "Pickup", b));
    expect(get("radio", "Pickup", b).getAttribute("aria-checked")).toBe("true");
  });

  it("speed: steps in mph, turns into a range around the limit with 'Not sure', and parked hides speed", async () => {
    const { services } = makeServices();
    app = await renderApp(services, { hash: "#vehicles", storage: located() });
    await flush(100);
    const a = card("A");
    expect(text(a)).toContain("About how fast at the moment of the crash?");
    click(get("button", "Faster, vehicle A", a));
    expect(a.querySelector<HTMLInputElement>("input[inputmode=decimal]")?.value).toBe("30");
    click(get("button", "Not sure", a));
    expect(a.querySelector("output")?.textContent).toBe("20–30");
    expect(text(a)).toContain("We'll show 20–30 mph at the moment of the crash, around the 25 mph limit. The picture uses 25 mph.");
    click(get("button", "I don't know the limit", a));
    expect(text(a)).toContain("around 25 mph, a typical city limit. The picture uses 25 mph.");
    click(get("radio", "Parked", a));
    expect(text(a)).not.toContain("About how fast?");
  });

  it("has a braking checkbox on a moving vehicle (not a parked one), off until ticked", async () => {
    const { services } = makeServices();
    app = await renderApp(services, { hash: "#vehicles", storage: located() });
    await flush(100);
    const box = () => card("A").querySelector<HTMLInputElement>("label[data-braking] input")!;
    expect(text(card("A"))).toContain("Braking just before the crash");
    expect(box().checked).toBe(false);
    click(box());
    expect(box().checked).toBe(true);
    const stored = () => (JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? "{}") as Doc).scene.vehicles[0]?.braking;
    expect(stored()).toBe(true);
    click(get("radio", "Parked", card("A")));
    expect(card("A").querySelector("label[data-braking]")).toBeNull();
    expect(stored()).toBe(false);
  });

  it("marks impact zones with a roving tab stop", async () => {
    const { services } = makeServices();
    app = await renderApp(services, { hash: "#vehicles", storage: located() });
    await flush(100);
    const zones = card("A").querySelector<HTMLElement>(".zones")!;
    const radios = all("radio", undefined, zones);
    expect(radios).toHaveLength(8);
    expect(radios.filter((r) => r.tabIndex === 0)).toHaveLength(1);
    expect(radios.find((r) => r.tabIndex === 0)?.getAttribute("aria-checked")).toBe("true");
    const first = radios.find((r) => r.tabIndex === 0)!;
    first.focus();
    key(first, "ArrowRight");
    expect(document.activeElement).toBe(radios[(radios.indexOf(first) + 1) % 8]);
    expect(all("radio", undefined, zones).filter((r) => r.tabIndex === 0)).toHaveLength(1);
  });

  it("puts no success check mark on instruction text, only on a type that really came from vPIC", async () => {
    const { services } = makeServices();
    app = await renderApp(services, { hash: "#vehicles", storage: located() });
    await flush(100);
    const lookup = (id: string) => card(id).querySelector(".lookup")!;
    expect(text(lookup("B"))).toContain("Enter the year, make and model");
    expect(lookup("B").querySelector("svg")).toBeNull();
    await flush(600);
    await flush(600);
    expect(text(lookup("A"))).toContain("Honda models for 2021. Pick yours to fill in the type.");   // an instruction
    expect(lookup("A").querySelector("svg")).toBeNull();
  });

  it("shows a compact note instead of the empty mini map on a phone with no pin", async () => {
    mockMatchMedia((q) => q.includes("max-width: 767px"));
    const { services } = makeServices();
    app = await renderApp(services, { hash: "#vehicles" });
    await flush(100);
    expect(document.querySelector("[data-testid=mini-compact]")).not.toBeNull();
    expect(document.querySelector(".map-frame-sm")).toBeNull();
    expect(document.querySelector(".leaflet-container")).toBeNull();
    // with a pin, the map comes back
    app.unmount();
    app = await renderApp(services, { hash: "#vehicles", storage: located() });
    await flush(100);
    expect(document.querySelector(".map-frame-sm")).not.toBeNull();
    expect(document.querySelector("[data-testid=mini-compact]")).toBeNull();
  });
});
