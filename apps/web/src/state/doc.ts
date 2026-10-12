// The one shared state: a Scene (schema v3) plus three small app facts the
// Scene contract has no room for (see "Contract change requests" in the report):
//   located      - whether the claimant has placed the pin yet (Scene always needs a lat/lon)
//   claimAddress - the address on the claim, prefilled in the search box, never sent until Search
//   vehicleKeys  - stable React keys so a vehicle's card keeps its state when letters re-pack
//   directionSet - per vehicle: has the claimant picked which way it was going? (A Scene always has a bearing,
//                  so "not picked yet" can't be stored in it.) Review and Save wait until every one is true.
//   reconcile    - may the app tidy road ids after the roads load? False for opened files and examples:
//                  reopening a file rebuilds exactly the recreation that was saved (DESIGN.md section 8).
// Every screen and every export reads from this. It is persisted to sessionStorage under one key.
import {
  LIMITS, SCHEMA_VERSION, VEHICLE_IDS, parseScene,
  type PlaceResult, type Scene, type SceneSpeed, type SceneVehicle, type TravelChoice, type VehicleId,
} from "@csd/core";
import { angleDiffDeg } from "../lib/geometry";

export interface Doc {
  readonly scene: Scene;
  readonly located: boolean;
  readonly claimAddress: string;
  readonly vehicleKeys: readonly string[];
  readonly directionSet: readonly boolean[];
  readonly reconcile: boolean;
}

// v4: v3 sessions had no per-vehicle "direction picked" flags and would have loaded with every direction marked as picked.
export const STORAGE_KEY = "crash-scene-3d/doc/v4";
/** Where the map starts before a place is set (the whole continental US). */
export const NO_PIN_VIEW = Object.freeze({ lat: 39.5, lon: -98.35 });

export function newVehicle(id: VehicleId, over: Partial<SceneVehicle> = {}): SceneVehicle {
  return {
    id,
    role: id === "A" ? "claimant" : "other",
    year: null,
    make: "",
    model: "",
    type: "car",
    typeSource: "manual",
    action: "straight",
    travel: { bearingDeg: 0, roadId: null, roadName: null, lane: null },
    speed: { kind: "known", mph: 25 },
    braking: false,
    zone: "front",
    ...over,
  };
}

let keyCounter = 0;
export const nextKey = (): string => `v${++keyCounter}`;

/** A made-up claim, as the prototype had. The address is a public intersection (no house number). */
export function initialDoc(): Doc {
  const claimVehicle = { year: 2021, make: "Honda", model: "Accord" };
  const scene: Scene = {
    schemaVersion: SCHEMA_VERSION,
    claim: { number: "CLM-2419", vehicle: claimVehicle },
    location: { lat: NO_PIN_VIEW.lat, lon: NO_PIN_VIEW.lon, label: "", nearLabel: "", source: "pin", place: "intersection" },
    occurred: { date: "2026-10-02", time: "17:15" },
    road: { condition: "dry" },
    vehicles: [
      newVehicle("A", { ...claimVehicle, type: "car", typeSource: "claim", zone: "left" }),
      newVehicle("B", { type: "suv", travel: { bearingDeg: 90, roadId: null, roadName: null, lane: null }, speed: { kind: "known", mph: 30 }, zone: "front" }),
    ],
  };
  return { scene, located: false, claimAddress: "Main Street and Park Street, Nashua, NH", vehicleKeys: scene.vehicles.map(nextKey), directionSet: scene.vehicles.map(() => false), reconcile: true };
}

/** A scene from outside (an opened file, an example): every direction counts as entered, and nothing is tidied. */
export function docFromScene(scene: Scene, claimAddress: string): Doc {
  return { scene, located: true, claimAddress, vehicleKeys: scene.vehicles.map(nextKey), directionSet: scene.vehicles.map(() => true), reconcile: false };
}

export type PinHow = "drag" | "tap" | "keys";

export type Action =
  | { type: "pin"; lat: number; lon: number; how: PinHow }
  | { type: "pick"; result: PlaceResult }
  | { type: "place"; place: Scene["location"]["place"] }
  | { type: "condition"; condition: Scene["road"]["condition"] }
  | { type: "date"; date: string }
  | { type: "time"; time: string | null }
  | { type: "vehicle"; id: VehicleId; patch: Partial<SceneVehicle> }
  | { type: "speed"; id: VehicleId; speed: SceneSpeed }
  | { type: "add-vehicle" }
  | { type: "remove-vehicle"; id: VehicleId }
  | { type: "reconcile-travel"; choices: readonly TravelChoice[] }
  /** A one-tap fix from the Review step: the same vehicles with a hit side, direction, action or speed changed, or the pin moved. */
  | { type: "apply-fix"; scene: Scene }
  | { type: "replace"; doc: Doc }
  | { type: "reset" };

const patchVehicles = (scene: Scene, id: VehicleId, fn: (v: SceneVehicle) => SceneVehicle): Scene => ({
  ...scene,
  vehicles: scene.vehicles.map((v) => (v.id === id ? fn(v) : v)),
});

/** The choice (road + direction) a vehicle's travel points at, or null when none fits. */
export function selectedChoice(travel: SceneVehicle["travel"], choices: readonly TravelChoice[]): TravelChoice | null {
  let best: TravelChoice | null = null;
  let bestDiff = Infinity;
  for (const c of choices) {
    const sameRoad = travel.roadId != null ? c.roadId === travel.roadId : travel.roadName != null && c.roadName === travel.roadName;
    if (!sameRoad) continue;
    const d = angleDiffDeg(c.bearingDeg, travel.bearingDeg);
    if (d <= 25 && d < bestDiff) { best = c; bestDiff = d; }
  }
  return best;
}

/**
 * After the roads change, fill in a missing road id for a road the claimant already picked
 * (same name, same direction). Never changes a bearing, never changes or clears a road name.
 */
export function reconcileTravel(v: SceneVehicle, choices: readonly TravelChoice[], tidy = true): SceneVehicle {
  const t = v.travel;
  if (t.roadId != null && t.roadName == null) {
    // An unnamed road's description follows the roads at the pin ("(west one)" may change when the pin moves, by hand or
    // by a "move the pin" fix). It is words only (never drawn), so it is kept current even where road ids aren't tidied.
    const same = choices.find((c) => c.roadId === t.roadId && c.roadName == null && angleDiffDeg(c.bearingDeg, t.bearingDeg) <= 25);
    // A road no longer at the pin: its pin-relative words no longer hold (the claimant's working scene only).
    const desc = same ? same.roadDesc ?? undefined : tidy ? undefined : t.roadDesc;
    return desc !== t.roadDesc ? { ...v, travel: { ...t, roadDesc: desc } } : v;
  }
  if (!tidy || t.roadId != null || t.roadName == null) return v;
  const match = choices.find((c) => c.roadName === t.roadName && angleDiffDeg(c.bearingDeg, t.bearingDeg) <= 25);
  return match ? { ...v, travel: { ...t, roadId: match.roadId } } : v;
}

export function reducer(doc: Doc, a: Action): Doc {
  const s = doc.scene;
  switch (a.type) {
    case "pin": {
      const label = s.location.label;
      return { ...doc, located: true, reconcile: true, scene: { ...s, location: { ...s.location, lat: a.lat, lon: a.lon, nearLabel: label ? label : s.location.nearLabel, label: "", source: "pin" } } };
    }
    case "pick": {
      const r = a.result;
      return { ...doc, located: true, reconcile: true, scene: { ...s, location: { ...s.location, lat: r.lat, lon: r.lon, label: r.label, nearLabel: "", source: "search" } } };
    }
    case "place": return { ...doc, scene: { ...s, location: { ...s.location, place: a.place } } };
    case "condition": return { ...doc, scene: { ...s, road: { condition: a.condition } } };
    case "date": return { ...doc, scene: { ...s, occurred: { ...s.occurred, date: a.date } } };
    case "time": return { ...doc, scene: { ...s, occurred: { ...s.occurred, time: a.time } } };
    case "vehicle": {
      const scene = patchVehicles(s, a.id, (v) => {
        const next = { ...v, ...a.patch };
        // A parked vehicle isn't braking.
        if (next.action === "parked") next.braking = false;
        // Changing the make clears the model: it belongs to the old make.
        if (a.patch.make !== undefined && a.patch.make.trim().toLowerCase() !== v.make.trim().toLowerCase() && a.patch.model === undefined) next.model = "";
        // Once the year, make or model is edited, the type no longer comes from the claim or vPIC lookup.
        const edited = (a.patch.make !== undefined && a.patch.make !== v.make) || (a.patch.model !== undefined && a.patch.model !== v.model) || (a.patch.year !== undefined && a.patch.year !== v.year);
        if (edited && a.patch.typeSource === undefined && v.typeSource !== "manual") next.typeSource = "manual";
        return next;
      });
      // Editing a vehicle never touches scene.claim: the header shows the claim's own vehicle.
      // Picking a direction (a travel patch) is what marks it as entered.
      const at = s.vehicles.findIndex((v) => v.id === a.id);
      const directionSet = a.patch.travel !== undefined ? doc.directionSet.map((x, i) => (i === at ? true : x)) : doc.directionSet;
      return { ...doc, scene, directionSet };
    }
    case "speed": return { ...doc, scene: patchVehicles(s, a.id, (v) => ({ ...v, speed: a.speed })) };
    case "add-vehicle": {
      if (s.vehicles.length >= LIMITS.maxVehicles) return doc;
      const id = VEHICLE_IDS[s.vehicles.length];
      if (!id) return doc;
      const v = newVehicle(id, { travel: { bearingDeg: 180, roadId: null, roadName: null, lane: null } });
      return { ...doc, scene: { ...s, vehicles: [...s.vehicles, v] }, vehicleKeys: [...doc.vehicleKeys, nextKey()], directionSet: [...doc.directionSet, false] };
    }
    case "remove-vehicle": {
      if (s.vehicles.length <= LIMITS.minVehicles || a.id === "A") return doc;
      const at = s.vehicles.findIndex((v) => v.id === a.id);
      if (at < 0) return doc;
      // Letters re-pack in order; each remaining vehicle keeps its key, so its card keeps its state.
      const vehicles = s.vehicles.filter((_, i) => i !== at).map((v, i) => ({ ...v, id: VEHICLE_IDS[i] ?? v.id }));
      return { ...doc, scene: { ...s, vehicles }, vehicleKeys: doc.vehicleKeys.filter((_, i) => i !== at), directionSet: doc.directionSet.filter((_, i) => i !== at) };
    }
    case "reconcile-travel": {
      // Road ids are tidied only in the claimant's working scene; an unnamed road's words are kept current everywhere.
      let changed = false;
      const vehicles = s.vehicles.map((v) => {
        const n = doc.directionSet[s.vehicles.indexOf(v)] ? reconcileTravel(v, a.choices, doc.reconcile) : v;
        if (n !== v) changed = true;
        return n;
      });
      return changed ? { ...doc, scene: { ...s, vehicles } } : doc;
    }
    case "apply-fix": {
      // The vehicles' details change (the same letters, so every card keeps its key), and for a "move the pin" fix the pin.
      if (a.scene.vehicles.length !== s.vehicles.length || a.scene.vehicles.some((v, i) => v.id !== s.vehicles[i]?.id)) return doc;
      const moved = a.scene.location.lat !== s.location.lat || a.scene.location.lon !== s.location.lon;
      // A moved pin keeps the roads already loaded (the fix stays within them), and the road ids are not tidied after it:
      // the fix was checked exactly as it is, so it must draw exactly as it is.
      return {
        ...doc, scene: { ...s, vehicles: a.scene.vehicles, location: moved ? a.scene.location : s.location },
        directionSet: doc.directionSet.map(() => true), reconcile: moved ? false : doc.reconcile,
      };
    }
    case "replace": return a.doc;
    case "reset": return initialDoc();
  }
}

/** Load the stored doc; a missing, old or broken one falls back to the claim. */
export function loadDoc(storage: Pick<Storage, "getItem"> | null): Doc {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return initialDoc();
    const stored = JSON.parse(raw) as Partial<Doc> | null;
    const parsed = parseScene(stored?.scene);
    if (!parsed.ok) return initialDoc();
    // Keys are per page load: a counter restarts on reload, so stored keys could collide.
    const keys = parsed.value.vehicles.map(nextKey);
    return {
      scene: parsed.value,
      located: stored?.located === true,
      claimAddress: typeof stored?.claimAddress === "string" ? stored.claimAddress : initialDoc().claimAddress,
      vehicleKeys: keys,
      directionSet: Array.isArray(stored?.directionSet) && stored.directionSet.length === keys.length ? stored.directionSet.map((x) => x === true) : keys.map(() => true),
      reconcile: stored?.reconcile !== false,
    };
  } catch {
    return initialDoc();
  }
}

export function saveDoc(storage: Pick<Storage, "setItem"> | null, doc: Doc): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(doc));
  } catch {
    // Storage blocked or full: the state stays in memory.
  }
}
