import { describe, expect, it } from "vitest";
import { parseScene } from "@csd/core";
import { tbone } from "./fakes";
import { STORAGE_KEY, docFromScene, initialDoc, loadDoc, reducer, reconcileTravel, saveDoc, selectedChoice, type Doc } from "../src/state/doc";

const withVehicles = (n: 3 | 4): Doc => {
  let d = initialDoc();
  while (d.scene.vehicles.length < n) d = reducer(d, { type: "add-vehicle" });
  return d;
};

describe("scene store reducer", () => {
  it("starts as a valid scene v3 from the claim, with the claim vehicle on A", () => {
    const d = initialDoc();
    expect(parseScene(d.scene).ok).toBe(true);
    expect(d.located).toBe(false);
    expect(d.scene.vehicles[0]).toMatchObject({ id: "A", role: "claimant", year: 2021, make: "Honda", model: "Accord", typeSource: "claim" });
  });

  it("adds up to four vehicles and no more", () => {
    const d = withVehicles(4);
    expect(d.scene.vehicles.map((v) => v.id)).toEqual(["A", "B", "C", "D"]);
    expect(reducer(d, { type: "add-vehicle" })).toBe(d);
    expect(d.vehicleKeys).toHaveLength(4);
  });

  it("re-packs letters in order when a vehicle is removed, and each card keeps its key", () => {
    let d = withVehicles(4);
    d = reducer(d, { type: "vehicle", id: "C", patch: { make: "Ford", model: "Escape" } });
    d = reducer(d, { type: "vehicle", id: "D", patch: { make: "Subaru" } });
    const [kA, , kC, kD] = d.vehicleKeys;
    d = reducer(d, { type: "remove-vehicle", id: "B" });
    expect(d.scene.vehicles.map((v) => v.id)).toEqual(["A", "B", "C"]);
    // old C is now B and old D is now C, with their own details and their own keys
    expect(d.scene.vehicles[1]).toMatchObject({ id: "B", make: "Ford", model: "Escape" });
    expect(d.scene.vehicles[2]).toMatchObject({ id: "C", make: "Subaru" });
    expect(d.vehicleKeys).toEqual([kA, kC, kD]);
    expect(parseScene(d.scene).ok).toBe(true);
  });

  it("never removes A, and never goes below two vehicles", () => {
    const d = withVehicles(3);
    expect(reducer(d, { type: "remove-vehicle", id: "A" })).toBe(d);
    const two = reducer(d, { type: "remove-vehicle", id: "C" });
    expect(reducer(two, { type: "remove-vehicle", id: "B" })).toBe(two);
  });

  it("editing your own car never rewrites the claim vehicle (the header)", () => {
    const d0 = initialDoc();
    const d1 = reducer(d0, { type: "vehicle", id: "A", patch: { year: 2015, make: "Toyota", model: "Camry" } });
    expect(d1.scene.vehicles[0]).toMatchObject({ year: 2015, make: "Toyota", model: "Camry" });
    expect(d1.scene.claim).toEqual(d0.scene.claim);
    expect(d1.scene.claim.vehicle).toEqual({ year: 2021, make: "Honda", model: "Accord" });
  });

  it("changing the make clears the model, and a type from the claim or vPIC becomes manual", () => {
    const d0 = reducer(initialDoc(), { type: "vehicle", id: "B", patch: { make: "Ford", model: "Escape", typeSource: "vpic" } });
    expect(d0.scene.vehicles[1]).toMatchObject({ make: "Ford", model: "Escape", typeSource: "vpic" });
    const d1 = reducer(d0, { type: "vehicle", id: "B", patch: { make: "Toyota" } });
    expect(d1.scene.vehicles[1]).toMatchObject({ make: "Toyota", model: "", typeSource: "manual" });
    // typing more of the same make (case aside) keeps the model
    const d2 = reducer(d0, { type: "vehicle", id: "B", patch: { make: "FORD" } });
    expect(d2.scene.vehicles[1]?.model).toBe("Escape");
  });

  it("moving the pin keeps the place it came from as 'near', and marks the pin as placed by hand", () => {
    let d = reducer(initialDoc(), { type: "pick", result: { label: "Main Street, Nashua", main: "Main Street", sub: "Nashua", lat: 42.76, lon: -71.46, kind: "road" } });
    expect(d).toMatchObject({ located: true, scene: { location: { label: "Main Street, Nashua", source: "search" } } });
    d = reducer(d, { type: "pin", lat: 42.7601, lon: -71.4601, how: "drag" });
    expect(d.scene.location).toMatchObject({ lat: 42.7601, label: "", nearLabel: "Main Street, Nashua", source: "pin" });
  });

  it("falls back to the claim when the stored scene is missing, old or broken", () => {
    const store = (v: unknown) => ({ getItem: () => (v === undefined ? null : typeof v === "string" ? v : JSON.stringify(v)) });
    expect(loadDoc(store(undefined)).scene.claim.number).toBe("CLM-2419");
    expect(loadDoc(store("{not json")).located).toBe(false);
    const good = initialDoc();
    expect(loadDoc(store({ ...good, scene: { ...good.scene, schemaVersion: 2 } })).scene.schemaVersion).toBe(3);
    expect(loadDoc(store({ ...good, scene: { ...good.scene, vehicles: [] } })).scene.vehicles).toHaveLength(2);
    expect(loadDoc(null).scene.vehicles).toHaveLength(2);
  });

  it("braking is the claimant's to tick, off by default, and a parked vehicle isn't braking", () => {
    let d = initialDoc();
    expect(d.scene.vehicles.every((v) => v.braking === false)).toBe(true);
    d = reducer(d, { type: "vehicle", id: "A", patch: { braking: true } });
    expect(d.scene.vehicles[0]?.braking).toBe(true);
    d = reducer(d, { type: "vehicle", id: "A", patch: { action: "parked" } });
    expect(d.scene.vehicles[0]?.braking).toBe(false);
    d = reducer(d, { type: "vehicle", id: "A", patch: { braking: true } });
    expect(d.scene.vehicles[0]?.braking).toBe(false);
  });

  it("uses a v4 key, so an old v3 session (which had no picked-direction flags) is never loaded", () => {
    expect(STORAGE_KEY).toBe("crash-scene-3d/doc/v4");
    const old = { getItem: (k: string) => (k === "crash-scene-3d/doc/v3" ? JSON.stringify({ ...initialDoc(), directionSet: undefined }) : null) };
    expect(loadDoc(old).directionSet).toEqual([false, false]);
  });

  it("round-trips through sessionStorage under one key", () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    const d = reducer(initialDoc(), { type: "pin", lat: 42.7, lon: -71.4, how: "tap" });
    saveDoc(storage, d);
    expect([...mem.keys()]).toEqual([STORAGE_KEY]);
    const back = loadDoc(storage);
    expect(back.scene).toEqual(d.scene);
    expect(back.located).toBe(true);
  });
});

describe("road-relative travel", () => {
  const choices = [
    { roadId: "w1", roadName: "Main Street", roadDesc: null, bearingDeg: 342, bound: "northbound", label: "northbound on Main Street" },
    { roadId: "w1", roadName: "Main Street", roadDesc: null, bearingDeg: 162, bound: "southbound", label: "southbound on Main Street" },
    { roadId: "w2", roadName: "Park Street", roadDesc: null, bearingDeg: 252, bound: "westbound", label: "westbound on Park Street" },
  ] as const;
  const v = (travel: Partial<Doc["scene"]["vehicles"][0]["travel"]>) => ({ ...initialDoc().scene.vehicles[0]!, travel: { bearingDeg: 0, roadId: null, roadName: null, lane: null, ...travel } });

  it("finds the choice a vehicle points at, by road and direction", () => {
    expect(selectedChoice(v({ roadName: "Main Street", bearingDeg: 342 }).travel, choices)?.label).toBe("northbound on Main Street");
    expect(selectedChoice(v({ roadId: "w1", bearingDeg: 160 }).travel, choices)?.label).toBe("southbound on Main Street");
    expect(selectedChoice(v({ roadName: "Park Street", bearingDeg: 90 }).travel, choices)).toBeNull();
  });

  it("only fills in a missing road id for a road the claimant named; never moves a bearing or clears a name", () => {
    const named = reconcileTravel(v({ roadName: "Main Street", bearingDeg: 340 }), choices);
    expect(named.travel).toMatchObject({ roadId: "w1", roadName: "Main Street", bearingDeg: 340 });
    const unnamed = reconcileTravel(v({ bearingDeg: 0 }), choices);
    expect(unnamed.travel).toEqual({ bearingDeg: 0, roadId: null, roadName: null, lane: null });     // no snapping
    const gone = reconcileTravel(v({ roadId: "old", roadName: "Elm Street", bearingDeg: 10 }), choices);
    expect(gone.travel).toMatchObject({ roadId: "old", roadName: "Elm Street", bearingDeg: 10 });   // no clearing
    const wrongWay = reconcileTravel(v({ roadName: "Main Street", bearingDeg: 90 }), choices);
    expect(wrongWay.travel.roadId).toBeNull();
  });

  it("starts with no direction picked, and a travel patch is what marks one as picked", () => {
    let d = initialDoc();
    expect(d.directionSet).toEqual([false, false]);
    d = reducer(d, { type: "vehicle", id: "B", patch: { travel: { bearingDeg: 90, roadId: null, roadName: null, lane: null } } });
    expect(d.directionSet).toEqual([false, true]);
    d = reducer(d, { type: "add-vehicle" });
    expect(d.directionSet).toEqual([false, true, false]);
    d = reducer(d, { type: "remove-vehicle", id: "B" });
    expect(d.directionSet).toEqual([false, false]);
  });

  it("does not tidy an opened file or an example: the same recreation comes back", () => {
    const opened = docFromScene(tbone, "x");
    expect(opened.reconcile).toBe(false);
    expect(opened.directionSet).toEqual([true, true]);
    const choicesMain = [{ roadId: "w1", roadName: "Main Street", roadDesc: null, bearingDeg: 342, bound: "northbound" as const, label: "northbound on Main Street" }];
    expect(reducer(opened, { type: "reconcile-travel", choices: choicesMain })).toBe(opened);
    // a file saved with no road name and bearing 90 reopens exactly as saved
    const odd = { ...tbone, vehicles: tbone.vehicles.map((x, i) => (i === 1 ? { ...x, travel: { bearingDeg: 90, roadId: null, roadName: null, lane: null } } : x)) };
    const doc = docFromScene(odd, "x");
    expect(reducer(doc, { type: "reconcile-travel", choices: choicesMain }).scene).toEqual(odd);
    // but moving the pin makes it the claimant's working scene again
    expect(reducer(doc, { type: "pin", lat: 1, lon: 1, how: "tap" }).reconcile).toBe(true);
  });
});
