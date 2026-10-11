// Class-level vehicle numbers used when the exact vehicle isn't known. Every
// number carries its source; verified=false needs a primary source before release.
// (Ported from design/prototype/src/presets.js; see DESIGN.md section 16.)
import type { VehicleType } from "./contracts/scene";

export interface Sourced {
  readonly value: number;
  readonly unit: "kg" | "m";
  readonly source: string;
  readonly verified: boolean;
  /** What kind of number this is, for the sentence that prints it ("a class average" when missing). */
  readonly basis?: string;
  /** True when no published source exists yet: the sentence says so plainly and prints no source. */
  readonly unsourced?: true;
}
export interface Preset { readonly type: VehicleType; readonly label: string; readonly icon: string; readonly mass: Sourced; readonly length: Sourced; readonly width: Sourced }

const LB_TO_KG = 0.45359237;
const EPA = "EPA Automotive Trends Report 2025 (EPA-420-R-26-001), Fig. 3.6, model year 2024 class average, read from chart (±100 lb)";
const AASHTO_P = "AASHTO passenger-car design vehicle (2001), via FHWA 2017 vehicle inventory; secondary source";
const AASHTO_SU = "AASHTO single-unit truck design vehicle (2001), via FHWA 2017 vehicle inventory; secondary source";
const NONE = "No published source yet; typical value, needs a citation";
const kg = (lb: number) => Math.round(lb * LB_TO_KG);

export const PRESETS: Readonly<Record<VehicleType, Preset>> = Object.freeze({
  car: { type: "car", label: "Car", icon: "veh-car",
    mass: { value: kg(3550), unit: "kg", source: `${EPA}: sedan/wagon ≈ 3,550 lb`, verified: true },
    length: { value: 4.8, unit: "m", source: NONE, verified: false }, width: { value: 1.85, unit: "m", source: NONE, verified: false } },
  suv: { type: "suv", label: "SUV", icon: "veh-suv",
    mass: { value: kg(4550), unit: "kg", source: `${EPA}: truck SUV ≈ 4,550 lb`, verified: true },
    length: { value: 4.85, unit: "m", source: NONE, verified: false }, width: { value: 1.95, unit: "m", source: NONE, verified: false } },
  pickup: { type: "pickup", label: "Pickup", icon: "veh-pickup",
    mass: { value: kg(5250), unit: "kg", source: `${EPA}: pickup ≈ 5,250 lb`, verified: true },
    length: { value: 5.8, unit: "m", source: AASHTO_P, verified: false }, width: { value: 2.1, unit: "m", source: AASHTO_P, verified: false } },
  van: { type: "van", label: "Van", icon: "veh-van",
    mass: { value: kg(4750), unit: "kg", source: `${EPA}: minivan/van ≈ 4,750 lb`, verified: true },
    length: { value: 5.15, unit: "m", source: NONE, verified: false }, width: { value: 2.0, unit: "m", source: NONE, verified: false } },
  motorcycle: { type: "motorcycle", label: "Motorcycle", icon: "veh-motorcycle",
    mass: { value: 230, unit: "kg", source: NONE, verified: false, basis: "a typical value without a published source", unsourced: true },
    length: { value: 2.15, unit: "m", source: NONE, verified: false }, width: { value: 0.85, unit: "m", source: "Patent literature: motorcycle widths 28–39 in (0.7–1.0 m); secondary source", verified: false } },
  truck: { type: "truck", label: "Truck", icon: "veh-truck",
    mass: { value: 8845, unit: "kg", source: "FHWA vehicle weight class 6 lower bound, 19,501 lb GVWR, treated as a loaded single-unit truck", verified: true, basis: "a loaded single-unit truck" },
    length: { value: 9.2, unit: "m", source: AASHTO_SU, verified: false }, width: { value: 2.4, unit: "m", source: AASHTO_SU, verified: false } },
});

/** Map a vPIC VehicleTypeName (and model name) to our class; null = ask the claimant. */
export function typeFromVpic(vehicleTypeName: string, modelName = ""): VehicleType | null {
  const n = vehicleTypeName.toLowerCase();
  if (n.includes("motorcycle")) return "motorcycle";
  if (n.includes("passenger car")) return "car";
  if (n.includes("multipurpose")) return /van|odyssey|sienna|pacifica|carnival|sedona|quest|caravan|transit|sprinter|promaster|express|savana|metris/i.test(modelName) ? "van" : "suv";
  if (n.includes("truck")) return /transit|sprinter|promaster|express|savana/i.test(modelName) ? "van" : /\b(f-?[4-9]\d0|[4-6]500(?:hd|xd)?|box|cutaway|chassis)\b/i.test(modelName) ? "truck" : "pickup";
  return null;
}
