// Sentences shown to the claimant. Built from core's formatter pieces so street
// names keep their capitals and no word repeats ("going straight going straight").
// Numbers come from the simulation result through formatSpeed; nothing is typed in.
import {
  ACTION_WORDS, DEFAULT_LIMIT_MPH, PRESETS, ROAD_WORDS, ZONE_WORDS, directionCaption, formatSpeed, joinClauses,
  type Scene, type SceneVehicle, type SimulationResult, type Units,
} from "@csd/core";

export const lcFirst = (s: string): string => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
export const ucFirst = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** "Your car" for A, "Vehicle B" for the rest. */
export const roleName = (v: Pick<SceneVehicle, "id">): string => (v.id === "A" ? "Your car" : `Vehicle ${v.id}`);

const typeNoun = (v: SceneVehicle): string => {
  const label = PRESETS[v.type].label;
  const noun = label === "SUV" ? "SUV" : label.toLowerCase();
  return `${/^[aeiou]|^SUV/i.test(noun) ? "an" : "a"} ${noun}`;
};

/**
 * The part of the direction caption after the action, kept in its own case.
 * "Turning left, ending northbound on Main Street" -> "ending northbound on Main Street".
 * "Northbound on Main Street" (going straight) -> "northbound on Main Street".
 */
export function whereClause(v: Pick<SceneVehicle, "action" | "travel">): string {
  const caption = directionCaption(v);
  if (v.action === "straight") return lcFirst(caption);
  const i = caption.indexOf(", ");
  return i >= 0 ? caption.slice(i + 2) : lcFirst(caption);
}

/**
 * The speed at the moment of the crash, from the simulation result through the formatter, with the
 * "not sure" note when it was a range. Empty for a parked vehicle.
 */
export function speedPhrase(v: SceneVehicle, sim: SimulationResult | null, units: Units): string {
  if (v.action === "parked") return "";
  const result = sim?.vehicles.find((x) => x.id === v.id);
  if (!result) return "";
  const text = formatSpeed(result.speedAtImpactMps, { units }).text;
  if (v.speed.kind === "unsure") {
    const mid = formatSpeed(result.speedAtImpactMps.mid, { units }).text;
    const around = v.speed.limitMph == null ? `around ${DEFAULT_LIMIT_MPH} mph, a typical city limit` : `around the ${v.speed.limitMph} mph limit`;
    return `at about ${text} (not sure; ${around}; the picture uses ${mid})`;
  }
  return `at about ${text}`;
}

/**
 * One vehicle as a clause: "vehicle A, your car, northbound on Main Street at about 25 mph when it was hit on the right side".
 * The speed is the speed at the moment of the crash.
 */
export function vehicleClause(v: SceneVehicle, sim: SimulationResult | null, units: Units): string {
  const what = v.id === "A" ? "your car" : typeNoun(v);
  const doing = v.action === "parked" ? "was parked" : v.action === "straight" ? "" : ACTION_WORDS[v.action];
  const head = `${joinClauses([`vehicle ${v.id}`, what, doing, whereClause(v)])}${v.braking && v.action !== "parked" ? " and braking" : ""}`;
  const speed = speedPhrase(v, sim, units);
  return `${head}${speed ? ` ${speed}` : ""} when it was hit on the ${ZONE_WORDS[v.zone]}`;
}

export function sceneSummary(scene: Scene, sim: SimulationResult | null, units: Units): string {
  const sentence = scene.vehicles.map((v) => vehicleClause(v, sim, units)).join("; ");
  return `${ucFirst(sentence)}. The road was ${ROAD_WORDS[scene.road.condition]}.`;
}

/** Seconds as the readout words used on the timeline. */
export function timeWords(tS: number, restS: number): string {
  if (Math.abs(tS) < 0.05) return "At impact";
  if (tS >= restS - 0.01) return "Final rest";
  return `${Math.abs(tS).toFixed(1)} s ${tS < 0 ? "before impact" : "after impact"}`;
}
