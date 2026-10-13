// One shared scene state. Every screen and every export reads from here.
const KEY = "crash-scene-3d/scene/v2";

/** Starting state, as the app's: no claim number and no vehicle details (Try an example fills a scene). */
export function initialScene() {
  return {
    schemaVersion: 2,
    physicsVersion: "0.1.0-prototype",
    claim: { number: "", vehicle: { year: null, make: "", model: "" }, address: "1200 Maple Ave & 3rd St, Springfield" },
    location: { query: "1200 Maple Ave & 3rd St, Springfield", label: "", nearLabel: "", lat: null, lon: null, source: null, placeName: "", place: "intersection", streets: { ew: "", ns: "" } },
    occurred: { date: "2026-10-02", time: "17:15" },
    road: { condition: "dry" },
    vehicles: [
      newVehicle("A", { role: "Your car", type: "car", typeSource: "manual", heading: 0, speedMph: 25, zone: "left" }),
      newVehicle("B", { role: "Other vehicle", type: "suv", typeSource: "manual", heading: 90, speedMph: 30, zone: "front" }),
    ],
  };
}

export function newVehicle(id, over = {}) {
  return {
    id, role: "Other vehicle", fromClaim: false,
    year: null, make: "", model: "", type: "car", typeSource: "manual",
    heading: 0, action: "straight",
    speedMph: 25, unsure: false, limitMph: 25, limitKnown: true,
    zone: "front",
    ...over,
  };
}

const listeners = new Set();
let scene = load() || initialScene();

function load() {
  try {
    const raw = sessionStorage.getItem(KEY);
    const s = raw ? JSON.parse(raw) : null;
    return isScene(s) ? s : null;          // an old or broken stored scene falls back to the claim
  } catch { return null; }
}
function save() {
  try { sessionStorage.setItem(KEY, JSON.stringify(scene)); } catch { /* storage blocked: state stays in memory */ }
}

export const store = {
  get: () => scene,
  /** @param {(draft: any) => void} mutate */
  update(mutate, reason = "") {
    const draft = structuredClone(scene);
    mutate(draft);
    scene = draft;
    save();
    for (const fn of listeners) fn(scene, reason);
  },
  reset() { scene = initialScene(); save(); for (const fn of listeners) fn(scene, "reset"); },
  /** Replace the whole scene (opening a saved scene file). */
  replace(next) { scene = next; save(); for (const fn of listeners) fn(scene, "replace"); },
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
};

/** Shape check for stored or opened scenes. */
export function isScene(s) {
  return !!s && s.schemaVersion === 2 && Array.isArray(s.vehicles) && s.vehicles.length >= 2 && s.vehicles.length <= 4
    && s.location && typeof s.location === "object" && s.road && s.occurred && s.claim;
}

export const LETTERS = ["A", "B", "C", "D"];
export const MAX_VEHICLES = 4;
export const MIN_VEHICLES = 2;

/* ---------- Canonical JSON + SHA-256 fingerprint ---------- */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}
export const shortFp = (hex) => hex.slice(0, 16).match(/.{4}/g).join(" ");
