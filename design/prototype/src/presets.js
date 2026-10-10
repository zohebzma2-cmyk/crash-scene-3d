// Typed preset table: class-level vehicle numbers the physics uses when it
// knows the type but not the exact vehicle. Every number carries its source.
// verified=false means the number still needs a primary source before release.

/** @typedef {"car"|"suv"|"pickup"|"van"|"motorcycle"|"truck"} VehicleType */
/** @typedef {{ value: number, unit: "kg"|"m", source: string, verified: boolean }} Sourced */
/** @typedef {{ type: VehicleType, label: string, icon: string, mass: Sourced, length: Sourced, width: Sourced }} Preset */

const LB = 0.45359237;
const EPA = "EPA Automotive Trends Report 2025 (EPA-420-R-26-001), Fig. 3.6, model year 2024 class average, read from chart (±100 lb)";
const AASHTO_P = "AASHTO passenger-car design vehicle (2001), via FHWA 2017 vehicle inventory; secondary source";
const AASHTO_SU = "AASHTO single-unit truck design vehicle (2001), via FHWA 2017 vehicle inventory; secondary source";
const NONE = "No published source yet; typical value, needs a citation";

/** @type {Record<VehicleType, Preset>} */
export const PRESETS = Object.freeze({
  car:        { type: "car",        label: "Car",        icon: "veh-car",
    mass:   { value: Math.round(3550 * LB), unit: "kg", source: `${EPA}: sedan/wagon ≈ 3,550 lb`, verified: true },
    length: { value: 4.8,  unit: "m", source: NONE, verified: false },
    width:  { value: 1.85, unit: "m", source: NONE, verified: false } },
  suv:        { type: "suv",        label: "SUV",        icon: "veh-suv",
    mass:   { value: Math.round(4550 * LB), unit: "kg", source: `${EPA}: truck SUV ≈ 4,550 lb`, verified: true },
    length: { value: 4.85, unit: "m", source: NONE, verified: false },
    width:  { value: 1.95, unit: "m", source: NONE, verified: false } },
  pickup:     { type: "pickup",     label: "Pickup",     icon: "veh-pickup",
    mass:   { value: Math.round(5250 * LB), unit: "kg", source: `${EPA}: pickup ≈ 5,250 lb`, verified: true },
    length: { value: 5.8,  unit: "m", source: AASHTO_P, verified: false },
    width:  { value: 2.1,  unit: "m", source: AASHTO_P, verified: false } },
  van:        { type: "van",        label: "Van",        icon: "veh-van",
    mass:   { value: Math.round(4750 * LB), unit: "kg", source: `${EPA}: minivan/van ≈ 4,750 lb`, verified: true },
    length: { value: 5.15, unit: "m", source: NONE, verified: false },
    width:  { value: 2.0,  unit: "m", source: NONE, verified: false } },
  motorcycle: { type: "motorcycle", label: "Motorcycle", icon: "veh-motorcycle",
    mass:   { value: 230,  unit: "kg", source: NONE, verified: false },
    length: { value: 2.15, unit: "m", source: NONE, verified: false },
    width:  { value: 0.85, unit: "m", source: "Patent literature: motorcycle widths 28–39 in (0.7–1.0 m); secondary source", verified: false } },
  truck:      { type: "truck",      label: "Truck",      icon: "veh-truck",
    mass:   { value: 8845, unit: "kg", source: "FHWA vehicle weight class 6 lower bound, 19,501 lb GVWR, treated as a loaded single-unit truck", verified: true },
    length: { value: 9.2,  unit: "m", source: AASHTO_SU, verified: false },
    width:  { value: 2.4,  unit: "m", source: AASHTO_SU, verified: false } },
});

export const TYPES = /** @type {VehicleType[]} */ (Object.keys(PRESETS));

/** Map a vPIC VehicleTypeName (and model name) to our class. */
export function typeFromVpic(vehicleTypeName, modelName = "") {
  const n = (vehicleTypeName || "").toLowerCase();
  if (n.includes("motorcycle")) return "motorcycle";
  if (n.includes("passenger car")) return "car";
  if (n.includes("multipurpose")) return /van|odyssey|sienna|pacifica|carnival|sedona|quest|caravan|transit|sprinter|promaster|express|savana|metris/i.test(modelName) ? "van" : "suv";
  if (n.includes("truck")) return /transit|sprinter|promaster|express|savana/i.test(modelName) ? "van" : (/\b(f-?[4-9]\d0|[4-6]500|box|cutaway|chassis)\b/i.test(modelName) ? "truck" : "pickup");
  return null;
}
