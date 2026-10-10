// NHTSA vPIC client (free, no key). Only year and make/model text are sent.
// Fails soft: callers fall back to picking the vehicle type by hand.
import { vehicleData } from "./config.js";
import { typeFromVpic } from "./presets.js";

const cache = new Map();
async function get(path) {
  if (cache.has(path)) return cache.get(path);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), vehicleData.timeoutMs);
  const p = fetch(`${vehicleData.url}/${path}${path.includes("?") ? "&" : "?"}format=json`, { signal: ctrl.signal, credentials: "omit" })
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    .then((j) => j.Results || [])
    .finally(() => clearTimeout(timer));
  cache.set(path, p);
  p.catch(() => cache.delete(path));
  return p;
}

const KINDS = ["car", "mpv", "truck", "motorcycle"];

/** Makes that build passenger vehicles, trucks or motorcycles (vPIC has no makes-by-year list). */
export async function makes() {
  const lists = await Promise.all(KINDS.map((k) => get(`GetMakesForVehicleType/${k}`)));
  const set = new Map();
  for (const row of lists.flat()) {
    const n = (row.MakeName || "").trim();
    if (n) set.set(n.toUpperCase(), titleCase(n));
  }
  return [...set.values()].sort((a, b) => a.localeCompare(b));
}

/** Models for a make in a model year, each with our vehicle class from vPIC's type. */
export async function models(make, year) {
  const m = encodeURIComponent(make.trim());
  const settled = await Promise.allSettled(KINDS.map((k) => get(`GetModelsForMakeYear/make/${m}/modelyear/${year}/vehicletype/${k}`)));
  if (settled.every((r) => r.status === "rejected")) throw new Error("vPIC unreachable");
  const lists = settled.map((r) => (r.status === "fulfilled" ? r.value : []));
  const out = new Map();
  for (const row of lists.flat()) {
    const name = (row.Model_Name || "").trim();
    if (!name || out.has(name.toUpperCase())) continue;
    out.set(name.toUpperCase(), { name, type: typeFromVpic(row.VehicleTypeName, name), vpicType: row.VehicleTypeName });
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function titleCase(s) {
  if (s.length <= 3) return s.toUpperCase();
  return s.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase()).replace(/\bBmw\b/, "BMW").replace(/\bGmc\b/, "GMC");
}
