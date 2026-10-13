// @vitest-environment jsdom
// A new visitor's vehicles start neutral (owner, 2026-10-12): no type, action, speed or hit side is prefilled. The scene
// holds placeholders the claimant never sees; the gate asks for each detail in the card's order, and nothing is checked
// or drawn from a placeholder.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Fix, type FixChange, type PlainMessage } from "@csd/core";
import { createFixtureVehicles } from "../src/services/fixtures";
import { ANSWER_FIELDS, STORAGE_KEY, docFromScene, initialDoc, isAnswered, loadDoc, reducer, unansweredOf, type Doc } from "../src/state/doc";
import { answerText, runGate } from "../src/state/Flow";
import { movesAtUnaskedSpeed } from "../src/review/RefusalFixes";
import { MINI_WAITING_TEXT } from "../src/components/MiniMap";
import { all, click, flush, get, key, maybe, renderApp, setValue, text } from "./helpers";
import { makeServices, tbone, withAnswers } from "./fakes";

let app: Awaited<ReturnType<typeof renderApp>> | null = null;
afterEach(() => { app?.unmount(); app = null; vi.restoreAllMocks(); });

const pinned = (): Doc => reducer(initialDoc(), { type: "pin", lat: tbone.location.lat, lon: tbone.location.lon, how: "tap" });
const card = (id: string) => document.getElementById(`vehicle-${id}`) as HTMLElement;
const checked = (root: ParentNode) => all("radio", undefined, root).filter((r) => r.getAttribute("aria-checked") === "true");
const group = (id: string, attr: string) => card(id).querySelector<HTMLElement>(`[${attr}]`);
const speedField = (id: string) => card(id).querySelector<HTMLInputElement>("input[inputmode=decimal]")!;
const noChecks = (): PlainMessage[] => [];
const settle = async (ms = 400) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

describe("the neutral start, in the state", () => {
  it("leaves type, action, speed and hit side unanswered on A and B, and on a vehicle added later", () => {
    const d = initialDoc();
    expect(d.unanswered).toEqual([ANSWER_FIELDS, ANSWER_FIELDS]);
    expect(d.directionSet).toEqual([false, false]);
    const c = reducer(d, { type: "add-vehicle" });
    expect(unansweredOf(c, 2)).toEqual(ANSWER_FIELDS);
    expect(c.directionSet[2]).toBe(false);
    expect(reducer(c, { type: "reset" }).unanswered).toEqual([ANSWER_FIELDS, ANSWER_FIELDS]);
  });

  it("marks a detail answered when its control sets it, even to the placeholder's own value", () => {
    let d = initialDoc();
    const placeholder = d.scene.vehicles[0]!;
    d = reducer(d, { type: "vehicle", id: "A", patch: { action: placeholder.action } });
    d = reducer(d, { type: "vehicle", id: "A", patch: { zone: placeholder.zone } });
    expect(unansweredOf(d, 0)).toEqual(["type", "speed"]);
    d = reducer(d, { type: "speed", id: "A", speed: { kind: "known", mph: 25 } });
    d = reducer(d, { type: "vehicle", id: "A", patch: { type: "suv", typeSource: "vpic" } });
    expect(unansweredOf(d, 0)).toEqual([]);
    expect(unansweredOf(d, 1)).toEqual(ANSWER_FIELDS);
  });

  it("does not count other edits (year, make, colour, braking, direction) as answers", () => {
    let d = initialDoc();
    d = reducer(d, { type: "vehicle", id: "B", patch: { year: 2019, make: "Ford", model: "Escape" } });
    d = reducer(d, { type: "vehicle", id: "B", patch: { color: { name: "Red", hex: "#b3261e" } } });
    d = reducer(d, { type: "vehicle", id: "B", patch: { braking: true } });
    d = reducer(d, { type: "vehicle", id: "B", patch: { travel: { bearingDeg: 270, roadId: null, roadName: "Park Street", lane: null } } });
    expect(unansweredOf(d, 1)).toEqual(ANSWER_FIELDS);
    expect(d.directionSet[1]).toBe(true);
  });

  it("puts the speed back to unanswered on clear-speed, and keeps the lists in step when a vehicle is removed", () => {
    let d = reducer(withAnswers(initialDoc()), { type: "add-vehicle" });
    d = reducer(d, { type: "clear-speed", id: "A" });
    expect(unansweredOf(d, 0)).toEqual(["speed"]);
    expect(d.scene.vehicles[0]!.speed).toEqual({ kind: "known", mph: 25 });
    d = reducer(d, { type: "remove-vehicle", id: "B" });
    expect(d.unanswered).toEqual([["speed"], ANSWER_FIELDS]);
  });

  it("counts everything as answered in an opened file or an example, except a parked vehicle's stored speed", () => {
    const opened = docFromScene(tbone, "");
    expect(opened.unanswered).toBeUndefined();
    expect(ANSWER_FIELDS.every((f) => isAnswered(opened, 0, f) && isAnswered(opened, 1, f))).toBe(true);
    const parkedB = { ...tbone, vehicles: tbone.vehicles.map((v) => (v.id === "B" ? { ...v, action: "parked" as const } : v)) };
    const withParked = docFromScene(parkedB, "");
    expect(withParked.unanswered).toEqual([[], ["speed"]]);
    // The gate never asks a parked vehicle for its speed; moving it again does.
    expect(runGate(parkedB, true, withParked.directionSet, noChecks, [], () => [], withParked.unanswered).filter((p) => p.kind === "missing")).toEqual([]);
    const moved = reducer(withParked, { type: "vehicle", id: "B", patch: { action: "straight" } });
    expect(runGate(moved.scene, true, moved.directionSet, noChecks, [], () => [], moved.unanswered).map((p) => p.text)).toEqual(["Enter vehicle B's speed, or choose Not sure."]);
  });

  it("a one-tap fix answers what it changes, and leaves a never-given speed unanswered unless it sets one", () => {
    let d: Doc = withAnswers({ ...pinned(), directionSet: [true, true] });
    d = reducer(d, { type: "vehicle", id: "B", patch: { action: "parked" } });
    d = reducer(d, { type: "clear-speed", id: "B" });
    expect(d.unanswered).toEqual([[], ["speed"]]);
    const hitSide = { ...d.scene, vehicles: d.scene.vehicles.map((v) => (v.id === "A" ? { ...v, zone: "right" as const } : v)) };
    expect(reducer(d, { type: "apply-fix", scene: hitSide }).unanswered).toEqual([[], ["speed"]]);
    const withSpeed = { ...d.scene, vehicles: d.scene.vehicles.map((v) => (v.id === "B" ? { ...v, action: "straight" as const, speed: { kind: "known" as const, mph: 10 } } : v)) };
    expect(reducer(d, { type: "apply-fix", scene: withSpeed }).unanswered).toEqual([[], []]);
  });

  it("offers no fix that would start a vehicle moving at a speed nobody gave", () => {
    let d: Doc = withAnswers({ ...pinned(), directionSet: [true, true] });
    d = reducer(reducer(d, { type: "vehicle", id: "B", patch: { action: "parked" } }), { type: "clear-speed", id: "B" });
    const fix = (patch: FixChange["patch"], id: "A" | "B" = "B"): Fix => ({ id: "x", label: "x", size: 1, cost: 1, kind: "action", scene: d.scene, changes: [{ vehicleId: id, field: "action", from: "Parked", to: "Straight", patch }] } as unknown as Fix);
    expect(movesAtUnaskedSpeed(fix({ action: "straight" }), d)).toBe(true);
    expect(movesAtUnaskedSpeed(fix({ action: "straight", speed: { kind: "known", mph: 10 } }), d)).toBe(false);
    expect(movesAtUnaskedSpeed(fix({ zone: "rear" }), d)).toBe(false);
    expect(movesAtUnaskedSpeed(fix({ action: "turn-left" }, "A"), d)).toBe(false);
  });

  it("keeps the list through a reload, and treats a session saved before it existed as answered", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null };
    let d = reducer(initialDoc(), { type: "vehicle", id: "A", patch: { zone: "left" } });
    store.set(STORAGE_KEY, JSON.stringify(d));
    expect(loadDoc(storage).unanswered).toEqual([["type", "action", "speed"], ANSWER_FIELDS]);
    // A stored list with junk in it keeps only the real field names.
    store.set(STORAGE_KEY, JSON.stringify({ ...d, unanswered: [["zone", "colour", 7], ["speed"]] }));
    expect(loadDoc(storage).unanswered).toEqual([["zone"], ["speed"]]);
    const { unanswered: _gone, ...older } = d;
    store.set(STORAGE_KEY, JSON.stringify(older));
    d = loadDoc(storage);
    expect(d.unanswered).toBeUndefined();
    expect(isAnswered(d, 0, "speed")).toBe(true);
  });
});

describe("the gate, from a neutral start", () => {
  it("asks for each detail in the card's order (type, doing, direction, speed, hit side), A first, all missing and blocking", () => {
    const d = pinned();
    const problems = runGate(d.scene, true, d.directionSet, noChecks, [], () => [], d.unanswered);
    expect(problems.map((p) => [p.vehicleIds[0], p.focus])).toEqual([
      ["A", "type"], ["A", "action"], ["A", "direction"], ["A", "speed"], ["A", "zone"],
      ["B", "type"], ["B", "action"], ["B", "direction"], ["B", "speed"], ["B", "zone"],
    ]);
    expect(problems.every((p) => p.kind === "missing" && p.blocking && p.step === "vehicles")).toBe(true);
    expect(problems.map((p) => p.text).slice(0, 5)).toEqual([
      "Pick the type of your car, or enter its year, make and model.",
      "Pick what your car was doing.",
      "Pick which way your car was going.",
      "Enter your car's speed, or choose Not sure.",
      "Pick where your car was hit.",
    ]);
    expect(answerText({ id: "B", action: "straight" }, "zone")).toBe("Pick where vehicle B was hit.");
    expect(answerText({ id: "C", action: "straight" }, "type")).toBe("Pick the type of vehicle C, or enter its year, make and model.");
  });

  it("runs no fit check, and no road check, while anything is unanswered", () => {
    let d: Doc = { ...pinned(), directionSet: [true, true] };
    const check = vi.fn((): PlainMessage[] => [{ code: "wrong-way", text: "Vehicle B is going the wrong way on Park Street.", vehicleIds: ["B"] }]);
    const roads = vi.fn((): PlainMessage[] => []);
    expect(runGate(d.scene, true, d.directionSet, check, [], roads, d.unanswered).some((p) => p.kind === "conflict")).toBe(false);
    expect(check).not.toHaveBeenCalled();
    expect(roads).not.toHaveBeenCalled();
    d = withAnswers(d);
    expect(runGate(d.scene, true, d.directionSet, check, [], roads, d.unanswered).some((p) => p.kind === "conflict")).toBe(true);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("does not ask a parked vehicle for its speed", () => {
    let d: Doc = { ...pinned(), directionSet: [true, true] };
    d = reducer(d, { type: "vehicle", id: "B", patch: { action: "parked" } });
    const asked = runGate(d.scene, true, d.directionSet, noChecks, [], () => [], d.unanswered).filter((p) => p.vehicleIds[0] === "B").map((p) => p.focus);
    expect(asked).toEqual(["type", "zone"]);
  });
});

describe("the vehicle cards, from a neutral start", () => {
  async function open(doc: Doc = pinned()) {
    const { services } = makeServices();
    app = await renderApp(services, { hash: "#vehicles", storage: doc });
    await flush(300);
  }

  it("shows nothing picked: type tiles (no vPIC answer yet), what it was doing, speed and hit side, on both cards", async () => {
    await open();
    for (const id of ["A", "B"]) {
      const type = group(id, "data-fix-type");
      expect(type, `${id}: the type tiles show while the type is unanswered`).not.toBeNull();
      expect(checked(type!)).toEqual([]);
      expect(card(id).querySelector(".type-auto")).toBeNull();
      expect(checked(group(id, "data-fix-action")!)).toEqual([]);
      expect(checked(group(id, "data-fix-zone")!)).toEqual([]);
      expect(speedField(id).value).toBe("");
      expect(get("button", `Slower, vehicle ${id}`, card(id))).toHaveProperty("disabled", true);
      expect(get("button", `Faster, vehicle ${id}`, card(id))).toHaveProperty("disabled", false);
      expect(text(card(id))).toContain("Enter the year, make and model to fill in the type, or pick it below.");
      // Nothing a placeholder could say: no "vPIC" badge, no speed number.
      expect(card(id).querySelector(".auto")).toBeNull();
    }
  });

  it("lists every missing detail on 'See the recreation', with no 'See it anyway', and 'Fix the details' goes to A's type", async () => {
    await open();
    click(get("button", /See the recreation/));
    await flush();
    expect(window.location.hash).toBe("#vehicles");
    const alert = text(get("alert"));
    expect(alert).toContain("Some details are missing");
    for (const line of ["Pick the type of your car", "Pick what your car was doing.", "Enter vehicle B's speed, or choose Not sure.", "Pick where vehicle B was hit."]) expect(alert).toContain(line);
    expect(alert).not.toContain("don't fit together");
    expect(maybe("button", "See it anyway")).toBeNull();
    click(get("button", "Fix the details"));
    await flush(10);
    const focused = document.activeElement as HTMLElement;
    expect(group("A", "data-fix-type")!.contains(focused)).toBe(true);
    expect(focused.getAttribute("role")).toBe("radio");
  });

  it("takes each answer: the tile, the action, a hit side and a typed speed show as picked and leave the missing list", async () => {
    await open();
    click(get("radio", "SUV", group("B", "data-fix-type")!));
    click(get("radio", "Straight", group("B", "data-fix-action")!));
    click(get("radio", "Hit on the front", card("B")));
    setValue(speedField("B"), "30");
    await flush();
    expect(checked(group("B", "data-fix-type")!).map((r) => r.textContent)).toEqual(["SUV"]);
    expect(checked(group("B", "data-fix-action")!).map((r) => r.textContent)).toEqual(["Straight"]);
    expect(checked(group("B", "data-fix-zone")!).map((r) => r.getAttribute("aria-label"))).toEqual(["Hit on the front"]);
    expect(speedField("B").value).toBe("30");
    click(get("button", /See the recreation/));
    await flush();
    const alert = text(get("alert"));
    expect(alert).not.toMatch(/type of vehicle B|vehicle B was doing|vehicle B's speed|vehicle B was hit/);
    expect(alert).toContain("Pick which way vehicle B was going.");
    expect(alert).toContain("Pick where your car was hit.");
  });

  it("steps the speed up from empty (5 mph), and turning Not sure off again with no speed entered leaves it empty", async () => {
    await open();
    click(get("button", "Faster, vehicle A", card("A")));
    await flush();
    expect(speedField("A").value).toBe("5");
    expect(get("button", "Slower, vehicle A", card("A"))).toHaveProperty("disabled", false);

    click(get("button", "Not sure", card("B")));
    await flush();
    expect(card("B").querySelector("input[inputmode=decimal]")).toBeNull();
    click(get("button", "Not sure", card("B")));
    await flush();
    expect(speedField("B").value).toBe("");
    click(get("button", /See the recreation/));
    await flush();
    expect(text(get("alert"))).toContain("Enter vehicle B's speed, or choose Not sure.");
    // A stray key then deleted, on a speed never given: said once by the gate, not also as "Vehicle B: Enter the speed in
    // mph", and no red line. (A speed that was given and then emptied keeps the field's own error, as before.)
    setValue(speedField("B"), "a");
    setValue(speedField("B"), "");
    await flush();
    expect(text(get("alert"))).not.toContain("Vehicle B: Enter the speed");
    expect(card("B").querySelector(".field-error")).toBeNull();
    expect(speedField("B").getAttribute("aria-invalid")).toBe("false");
  });

  it("hides the tiles once vPIC fills the type, and counts that as the answer", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { services } = makeServices({ vehicles: createFixtureVehicles() });
      app = await renderApp(services, { hash: "#vehicles", storage: pinned() });
      await settle(300);
      expect(group("A", "data-fix-type")).not.toBeNull();
      for (const [which, value] of [["year", "2021"], ["make", "Honda"], ["model", "Accord"]] as const) {
        const input = card("A").querySelector<HTMLInputElement>(`input[id$="-${which}"]`)!;
        act(() => input.focus());
        setValue(input, value);
        await settle(which === "make" ? 800 : 100);
        if (which !== "year") key(input, "Enter");
        await settle(which === "make" ? 800 : 100);
      }
      act(() => card("A").querySelector<HTMLInputElement>('input[id$="-model"]')!.blur());
      await settle(100);
      expect(group("A", "data-fix-type")).toBeNull();
      expect(card("A").querySelector(".type-auto strong")?.textContent).toBe("Car");
      click(get("button", /See the recreation/));
      await settle(50);
      expect(text(get("alert"))).not.toContain("Pick the type of your car");
      expect(text(get("alert"))).toContain("Pick the type of vehicle B");
    } finally {
      vi.useRealTimers();
    }
  });

  it("draws no vehicle on the mini map until every detail is picked, and says so", async () => {
    await open({ ...pinned(), directionSet: [true, true] });
    expect(text()).toContain(MINI_WAITING_TEXT);
    expect(document.querySelectorAll(".mini-vehicle, .leaflet-marker-icon[data-vehicle]").length).toBe(0);
    app?.unmount(); app = null;
    await open(withAnswers({ ...pinned(), directionSet: [true, true] }));
    expect(text()).not.toContain(MINI_WAITING_TEXT);
  });

  it("an opened file or example keeps every detail as saved (nothing shows as unanswered)", async () => {
    await open(docFromScene(tbone, ""));
    for (const id of ["A", "B"]) {
      expect(checked(group(id, "data-fix-action")!)).toHaveLength(1);
      expect(checked(group(id, "data-fix-zone")!)).toHaveLength(1);
    }
  });
});
