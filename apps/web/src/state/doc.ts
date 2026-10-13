// The one shared state: a Scene (schema v3) plus three small app facts the
// Scene contract has no room for (see "Contract change requests" in the report):
//   located      - whether the claimant has placed the pin yet (Scene always needs a lat/lon)
//   claimAddress - the address on the claim, prefilled in the search box, never sent until Search
//   vehicleKeys  - stable React keys so a vehicle's card keeps its state when letters re-pack
//   directionSet - per vehicle: has the claimant picked which way it was going? (A Scene always has a bearing,
//                  so "not picked yet" can't be stored in it.) Review and Save wait until every one is true.
//   unanswered   - per vehicle: which of type, action, speed and hit side the claimant hasn't answered yet (owner,
//                  2026-10-12: a new visitor's vehicles start neutral, nothing prefilled). The Scene needs a value for
//                  each, so it holds a placeholder that is never shown, never checked and never drawn. Absent = all
//                  answered (opened files, examples, sessions saved before this existed).
//   reconcile    - may the app tidy road ids after the roads load? False for opened files and examples:
//                  reopening a file rebuilds exactly the recreation that was saved (DESIGN.md section 8).
//   example      - the scene is one of the made-up examples, untouched (its claim number is made up too): marked in the
//                  header. The first edit that changes it ends that: `example` goes, the example's number is dropped, and
//                  `fromExample` remembers which example it started from (so a reload never reloads the example over it).
// scene.claim.vehicle mirrors vehicle A's year, make and model (one source of truth: header, files and the card agree).
// Every screen and every export reads from this. It is persisted to sessionStorage under one key.
import {
  LIMITS, SCHEMA_VERSION, VEHICLE_IDS, canonicalJson, parseScene,
  type PlaceResult, type Scene, type SceneSpeed, type SceneVehicle, type TravelChoice, type VehicleId,
} from "@csd/core";
import { angleDiffDeg } from "../lib/geometry";

export interface Doc {
  readonly scene: Scene;
  readonly located: boolean;
  readonly claimAddress: string;
  readonly vehicleKeys: readonly string[];
  readonly directionSet: readonly boolean[];
  /** Per vehicle, the details still to answer (see the header). Absent = every detail answered. */
  readonly unanswered?: readonly (readonly AnswerField[])[];
  readonly reconcile: boolean;
  readonly example?: ExampleMark;
  /** The example (by name) this scene started from before it was edited. */
  readonly fromExample?: string;
}

/** An untouched example: its name (null for a reopened example file), its content key, and its made-up claim number. */
export interface ExampleMark {
  readonly name: string | null;
  readonly key: string;
  readonly number: string;
}

/** What counts as the scene's content for "is it still the example": the docKey, without which type answer filled the type. */
export const contentKey = (doc: Pick<Doc, "scene" | "located">): string =>
  canonicalJson({ located: doc.located, scene: { ...doc.scene, vehicles: doc.scene.vehicles.map((v) => ({ ...v, typeSource: null, travel: { ...v.travel, roadId: null, roadDesc: undefined } })) } });

/** Is this scene one of the made-up examples as saved (an untouched example file)? */
export const looksLikeExample = (scene: Scene): boolean => scene.location.source === "example" && /^CLM-EX-\d+$/.test(scene.claim.number);

/** Today's date on this device, "2026-10-12". */
export function todayLocal(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

// v4: v3 sessions had no per-vehicle "direction picked" flags and would have loaded with every direction marked as picked.
export const STORAGE_KEY = "crash-scene-3d/doc/v4";
/** Where the map starts before a place is set (the whole continental US). */
export const NO_PIN_VIEW = Object.freeze({ lat: 39.5, lon: -98.35 });

/**
 * The details a new visitor answers on each vehicle card, none of them prefilled (the direction has its own flag,
 * `directionSet`). Order: the card's order, which is also the order "Fix the details" visits them in.
 */
export const ANSWER_FIELDS = ["type", "action", "speed", "zone"] as const;
export type AnswerField = (typeof ANSWER_FIELDS)[number];
const isAnswerField = (x: unknown): x is AnswerField => (ANSWER_FIELDS as readonly unknown[]).includes(x);

/** The details of vehicle `i` still to answer (none for a doc without the list). */
export const unansweredOf = (doc: Pick<Doc, "unanswered">, i: number): readonly AnswerField[] => doc.unanswered?.[i] ?? [];
/** Has the claimant answered this detail of vehicle `i`? */
export const isAnswered = (doc: Pick<Doc, "unanswered">, i: number, field: AnswerField): boolean => !unansweredOf(doc, i).includes(field);

/** The speed a vehicle holds while its speed is unanswered (never shown or used; see `unanswered`). */
const PLACEHOLDER_SPEED: SceneSpeed = { kind: "known", mph: 25 };

/**
 * A vehicle's placeholders while its details are unanswered: valid for the Scene, never shown (each control shows
 * nothing picked) and never checked or drawn (the gate stops at the missing details first). The placeholder type, car,
 * is also the app's generic vehicle mark (DESIGN section 13), so the photo box and the hit-side grid's silhouette show
 * the plain car icon until the type is known.
 */
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
    speed: PLACEHOLDER_SPEED,
    braking: false,
    zone: "front",
    ...over,
  };
}

let keyCounter = 0;
export const nextKey = (): string => `v${++keyCounter}`;

/** The claim's vehicle: always vehicle A's year, make and model. */
export const claimVehicleOf = (v: Pick<SceneVehicle, "year" | "make" | "model"> | undefined): Scene["claim"]["vehicle"] =>
  ({ year: v?.year ?? null, make: v?.make ?? "", model: v?.model ?? "" });

/**
 * A new visitor's start: no claim number and no vehicle details (Try an example is the quick way to a filled scene).
 * Nothing about the vehicles is prefilled: type, action, speed and where each was hit are unanswered and no direction
 * counts as picked (the Scene holds placeholders for them; see `unanswered`). The search box starts with a public
 * intersection (no house number).
 */
export function initialDoc(): Doc {
  const scene: Scene = {
    schemaVersion: SCHEMA_VERSION,
    claim: { number: "", vehicle: claimVehicleOf(undefined) },
    location: { lat: NO_PIN_VIEW.lat, lon: NO_PIN_VIEW.lon, label: "", nearLabel: "", source: "pin", place: "intersection" },
    // Today, no time: a new visitor enters their own (examples and opened files keep theirs).
    occurred: { date: todayLocal(), time: null },
    road: { condition: "dry" },
    vehicles: [newVehicle("A"), newVehicle("B", { travel: { bearingDeg: 90, roadId: null, roadName: null, lane: null } })],
  };
  return {
    scene, located: false, claimAddress: "Main Street and Park Street, Nashua, NH", vehicleKeys: scene.vehicles.map(nextKey),
    directionSet: scene.vehicles.map(() => false), unanswered: scene.vehicles.map(() => ANSWER_FIELDS), reconcile: true,
  };
}

/**
 * A scene from outside (an opened file, an example): every direction and detail counts as entered, and nothing is tidied.
 * Except a parked vehicle's speed: the file must hold one, but nothing uses it and nothing says it was ever entered, so it
 * stays unanswered (moving that vehicle later asks for its speed instead of showing the stored number as the claimant's).
 * `example`: the example's name when it was loaded as one; a scene that looks like an untouched example file is marked too.
 */
export function docFromScene(scene: Scene, claimAddress: string, opts: { example?: string } = {}): Doc {
  const parked = scene.vehicles.some((v) => v.action === "parked");
  const doc: Doc = {
    scene, located: true, claimAddress, vehicleKeys: scene.vehicles.map(nextKey), directionSet: scene.vehicles.map(() => true), reconcile: false,
    ...(parked ? { unanswered: scene.vehicles.map((v): AnswerField[] => (v.action === "parked" ? ["speed"] : [])) } : {}),
  };
  return opts.example !== undefined || looksLikeExample(scene)
    ? { ...doc, example: { name: opts.example ?? null, key: contentKey(doc), number: scene.claim.number } }
    : doc;
}

export type PinHow = "drag" | "tap" | "keys";

export type Action =
  | { type: "pin"; lat: number; lon: number; how: PinHow }
  | { type: "pick"; result: PlaceResult }
  | { type: "place"; place: Scene["location"]["place"] }
  | { type: "condition"; condition: Scene["road"]["condition"] }
  | { type: "conditions"; conditions: NonNullable<Scene["conditions"]> }
  | { type: "lane-answer"; id: SceneVehicle["id"]; lane: number | null }
  | { type: "date"; date: string }
  | { type: "time"; time: string | null }
  /** The claim number as the field keeps it (already cleaned: see lib/claim). */
  | { type: "claim-number"; number: string }
  | { type: "vehicle"; id: VehicleId; patch: Partial<SceneVehicle> }
  | { type: "speed"; id: VehicleId; speed: SceneSpeed }
  /** The speed goes back to unanswered ("Not sure" turned off on a vehicle whose speed was never entered). */
  | { type: "clear-speed"; id: VehicleId }
  | { type: "add-vehicle" }
  | { type: "remove-vehicle"; id: VehicleId }
  | { type: "reconcile-travel"; choices: readonly TravelChoice[] }
  /** A one-tap fix from the Review step: the same vehicles with a hit side, direction, action or speed changed, or the pin moved. */
  | { type: "apply-fix"; scene: Scene }
  | { type: "replace"; doc: Doc }
  /** The scene was edited away from the example it came from (see `example` above). */
  | { type: "leave-example" }
  | { type: "reset" };

/** `fields` of vehicle `at` are answered now (no change, and no list added, when there is nothing to take off). */
function answered(doc: Doc, at: number, fields: readonly AnswerField[]): Pick<Doc, "unanswered"> | Record<string, never> {
  if (!doc.unanswered || at < 0 || !fields.length || !unansweredOf(doc, at).some((f) => fields.includes(f))) return {};
  return { unanswered: doc.unanswered.map((list, i) => (i === at ? list.filter((f) => !fields.includes(f)) : list)) };
}

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
    case "conditions": return { ...doc, scene: { ...s, conditions: a.conditions } };
    // An optional lane answer never marks the required travel direction as picked.
    case "lane-answer": return { ...doc, scene: patchVehicles(s, a.id, (v) => ({ ...v, travel: { ...v.travel, lane: a.lane }, account: { ...v.account, lane: a.lane === null ? "not-sure" : "entered" } })) };
    case "date": return { ...doc, scene: { ...s, occurred: { ...s.occurred, date: a.date } } };
    case "time": return { ...doc, scene: { ...s, occurred: { ...s.occurred, time: a.time } } };
    case "claim-number": return a.number === s.claim.number ? doc : { ...doc, scene: { ...s, claim: { ...s.claim, number: a.number } } };
    case "vehicle": {
      const scene = patchVehicles(s, a.id, (v) => {
        const next = { ...v, ...a.patch };
        // Only an explicit answer control establishes claimant provenance. A generic physics
        // patch (including false/defaults/fixes) must never invent a recalled answer.
        // A parked vehicle keeps its recollection,
        // but the illustration applies braking only while moving; changing back restores it.
        const answerChanged = a.patch.account?.braking !== undefined && a.patch.account.braking !== v.account?.braking;
        const leftParked = v.action === "parked" && next.action !== "parked";
        if ((answerChanged || leftParked) && next.account?.braking !== undefined) next.braking = next.account.braking === "yes";
        if (next.action === "parked") next.braking = false;
        // Changing the make clears the model: it belongs to the old make.
        if (a.patch.make !== undefined && a.patch.make.trim().toLowerCase() !== v.make.trim().toLowerCase() && a.patch.model === undefined) next.model = "";
        // Once the year, make or model is edited, the type no longer comes from the claim or vPIC lookup.
        const edited = (a.patch.make !== undefined && a.patch.make !== v.make) || (a.patch.model !== undefined && a.patch.model !== v.model) || (a.patch.year !== undefined && a.patch.year !== v.year);
        if (edited && a.patch.typeSource === undefined && v.typeSource !== "manual") next.typeSource = "manual";
        return next;
      });
      // The claim's vehicle follows vehicle A's year, make and model as they are typed.
      const a0 = scene.vehicles[0];
      const ymm = a.id === "A" && (a.patch.year !== undefined || a.patch.make !== undefined || a.patch.model !== undefined);
      const synced = ymm && a0 ? { ...scene, claim: { ...scene.claim, vehicle: claimVehicleOf(a0) } } : scene;
      // Picking a direction (a travel patch) is what marks it as entered; a type, action or hit side the same for those.
      const at = s.vehicles.findIndex((v) => v.id === a.id);
      const directionSet = a.patch.travel !== undefined ? doc.directionSet.map((x, i) => (i === at ? true : x)) : doc.directionSet;
      const answers = ANSWER_FIELDS.filter((f) => a.patch[f] !== undefined);
      return { ...doc, scene: synced, directionSet, ...answered(doc, at, answers) };
    }
    case "speed": {
      const at = s.vehicles.findIndex((v) => v.id === a.id);
      return { ...doc, scene: patchVehicles(s, a.id, (v) => ({ ...v, speed: a.speed })), ...answered(doc, at, ["speed"]) };
    }
    case "clear-speed": {
      const at = s.vehicles.findIndex((v) => v.id === a.id);
      if (at < 0) return doc;
      const unanswered = s.vehicles.map((_, i) => {
        const list = unansweredOf(doc, i);
        return i === at && !list.includes("speed") ? ANSWER_FIELDS.filter((f) => f === "speed" || list.includes(f)) : list;
      });
      return { ...doc, scene: patchVehicles(s, a.id, (v) => ({ ...v, speed: PLACEHOLDER_SPEED })), unanswered };
    }
    case "add-vehicle": {
      if (s.vehicles.length >= LIMITS.maxVehicles) return doc;
      const id = VEHICLE_IDS[s.vehicles.length];
      if (!id) return doc;
      const v = newVehicle(id, { travel: { bearingDeg: 180, roadId: null, roadName: null, lane: null } });
      // An added vehicle starts as neutral as A and B: nothing answered.
      const unanswered = [...s.vehicles.map((_, i) => unansweredOf(doc, i)), ANSWER_FIELDS];
      return { ...doc, scene: { ...s, vehicles: [...s.vehicles, v] }, vehicleKeys: [...doc.vehicleKeys, nextKey()], directionSet: [...doc.directionSet, false], unanswered };
    }
    case "remove-vehicle": {
      if (s.vehicles.length <= LIMITS.minVehicles || a.id === "A") return doc;
      const at = s.vehicles.findIndex((v) => v.id === a.id);
      if (at < 0) return doc;
      // Letters re-pack in order; each remaining vehicle keeps its key, so its card keeps its state.
      const vehicles = s.vehicles.filter((_, i) => i !== at).map((v, i) => ({ ...v, id: VEHICLE_IDS[i] ?? v.id }));
      return {
        ...doc, scene: { ...s, vehicles }, vehicleKeys: doc.vehicleKeys.filter((_, i) => i !== at), directionSet: doc.directionSet.filter((_, i) => i !== at),
        ...(doc.unanswered ? { unanswered: doc.unanswered.filter((_, i) => i !== at) } : {}),
      };
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
      // A fix answers what it changes. A speed the claimant never gave (a parked vehicle's) stays unanswered unless the fix
      // set one: the stored placeholder is not theirs.
      const unanswered = a.scene.vehicles.map((v, i): AnswerField[] =>
        (!isAnswered(doc, i, "speed") && canonicalJson(v.speed) === canonicalJson(s.vehicles[i]!.speed) ? ["speed"] : []));
      return {
        ...doc, scene: { ...s, vehicles: a.scene.vehicles, location: moved ? a.scene.location : s.location },
        directionSet: doc.directionSet.map(() => true), unanswered, reconcile: moved ? false : doc.reconcile,
      };
    }
    case "replace": return a.doc;
    case "leave-example": {
      if (!doc.example) return doc;
      const { example, ...rest } = doc;
      // The example's made-up number doesn't follow the claimant's own work (a number they typed stays).
      const number = s.claim.number === example.number ? "" : s.claim.number;
      return { ...rest, scene: { ...s, claim: { ...s.claim, number } }, ...(example.name ? { fromExample: example.name } : {}) };
    }
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
      // A session saved before the list existed showed its values as picked: they count as answered.
      ...(Array.isArray(stored?.unanswered) && stored.unanswered.length === keys.length
        ? { unanswered: stored.unanswered.map((list) => (Array.isArray(list) ? ANSWER_FIELDS.filter((f) => list.some((x) => x === f && isAnswerField(x))) : [])) }
        : {}),
      reconcile: stored?.reconcile !== false,
      ...(isExampleMark(stored?.example) ? { example: stored.example } : {}),
      ...(typeof stored?.fromExample === "string" ? { fromExample: stored.fromExample } : {}),
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

function isExampleMark(v: unknown): v is ExampleMark {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (o.name === null || typeof o.name === "string") && typeof o.key === "string" && typeof o.number === "string";
}

