// The physics does not trust its input. It runs server-side later, so simulate, placeVehicles and checkScene check
// what they are given themselves, without depending on parseScene having run first.
//
// Wording matches the scene schema (contracts/scene.ts) where a message exists there, with plain ASCII (the physics
// text goes into the PDF, whose font has a small character set): "-90" not the minus sign, "degrees" not the degree sign.
import { ACTIONS, LIMITS, ROAD_CONDITIONS, VEHICLE_IDS, VEHICLE_TYPES, ZONES } from "../contracts/scene";
import type { PlainMessage } from "../contracts/simulation";
import type { VehicleId } from "../contracts/scene";
import type { Vec2 } from "../contracts/geometry";
import { MAX_TRACK_SAMPLES } from "./constants";

const msg = (code: string, text: string, vehicleIds: readonly VehicleId[] = []): PlainMessage => ({ code, text, vehicleIds });
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;

export const TOO_MANY_VEHICLES_TEXT = `${LIMITS.maxVehicles} vehicles at most.`;
export const TOO_FEW_VEHICLES_TEXT = "Add at least two vehicles.";
export const NO_ROAD_TEXT = "We couldn't find a road near the pin. Move the pin onto the road where the crash happened.";
export const BAD_PIN_TEXT = "We couldn't read where the pin is. Move the pin onto the road where the crash happened.";
export const CANNOT_WORK_OUT_TEXT = "We couldn't work this crash out from the details given. Check them and try again.";
export const TOO_LONG_TEXT = "This crash would take too long to play out. Check the speeds and the road condition.";

/** A point whose coordinates are both finite numbers. */
export const isFinitePoint = (p: unknown): p is Vec2 => isObj(p) && isNum(p["x"]) && isNum(p["y"]);

/**
 * Everything wrong with a scene, in plain words; empty when the physics can work with it. Checks the number of
 * vehicles, each vehicle's letter, type, action, zone, direction, lane and speed, the road condition and the location.
 */
export function validateScene(scene: unknown): PlainMessage[] {
  const out: PlainMessage[] = [];
  const s = isObj(scene) ? scene : {};
  const vehicles: unknown[] = Array.isArray(s["vehicles"]) ? (s["vehicles"] as unknown[]) : [];
  if (vehicles.length < LIMITS.minVehicles) out.push(msg("too-few-vehicles", TOO_FEW_VEHICLES_TEXT));
  if (vehicles.length > LIMITS.maxVehicles) out.push(msg("too-many-vehicles", TOO_MANY_VEHICLES_TEXT));

  const loc = isObj(s["location"]) ? s["location"] : {};
  if (!isNum(loc["lat"])) out.push(msg("bad-location", "The location is missing its latitude."));
  else if (loc["lat"] < -90 || loc["lat"] > 90) out.push(msg("bad-location", "The latitude has to be between -90 and 90."));
  if (!isNum(loc["lon"])) out.push(msg("bad-location", "The location is missing its longitude."));
  else if (loc["lon"] < -180 || loc["lon"] > 180) out.push(msg("bad-location", "The longitude has to be between -180 and 180."));

  const road = isObj(s["road"]) ? s["road"] : {};
  if (!(ROAD_CONDITIONS as readonly unknown[]).includes(road["condition"])) out.push(msg("bad-road-condition", "Pick what the road was like."));

  const seen = new Set<unknown>();
  vehicles.slice(0, 16).forEach((raw, i) => {
    const v = isObj(raw) ? raw : {};
    const id = (VEHICLE_IDS as readonly unknown[]).includes(v["id"]) ? (v["id"] as VehicleId) : undefined;
    const who: VehicleId[] = id ? [id] : [];
    const prefix = `Vehicle ${id ?? VEHICLE_IDS[i] ?? i + 1}: `;
    const bad = (code: string, text: string) => out.push(msg(code, `${prefix}${text}`, who));
    if (!id) bad("bad-vehicle", "Vehicles are lettered A to D.");
    else if (seen.has(id)) bad("bad-vehicle", "Vehicles have to be lettered A, B, C, D in order.");
    seen.add(id);
    if (!(VEHICLE_TYPES as readonly unknown[]).includes(v["type"])) bad("bad-vehicle", "Pick the kind of vehicle.");
    if (!(ACTIONS as readonly unknown[]).includes(v["action"])) bad("bad-vehicle", "Pick what the vehicle was doing.");
    if (!(ZONES as readonly unknown[]).includes(v["zone"])) bad("bad-vehicle", "Pick where the vehicle was hit.");

    const travel = isObj(v["travel"]) ? v["travel"] : {};
    if (!isNum(travel["bearingDeg"])) bad("bad-direction", "Pick which way the vehicle was going.");
    else if (travel["bearingDeg"] < 0 || travel["bearingDeg"] >= 360) bad("bad-direction", "The direction has to be between 0 and 360 degrees.");
    const fromDriveway = travel["fromDriveway"];
    if (fromDriveway !== undefined && fromDriveway !== null && typeof fromDriveway !== "boolean") bad("bad-direction", "Say whether the vehicle came out of a driveway or parking lot.");
    const lane = travel["lane"];
    if (lane !== null && lane !== undefined && !(Number.isInteger(lane) && (lane as number) >= 0 && (lane as number) <= 19)) {
      bad("bad-lane", "The lane has to be a whole number, counting from the right.");
    }

    const speed = isObj(v["speed"]) ? v["speed"] : {};
    if (speed["kind"] === "known") {
      const mph = speed["mph"];
      if (!isNum(mph)) bad("bad-speed", "The speed should be a number of mph.");
      else if (mph < 0) bad("bad-speed", "The speed can't be below 0 mph.");
      else if (mph > LIMITS.maxSpeedMph) bad("bad-speed", `That's faster than we can illustrate. Enter ${LIMITS.maxSpeedMph} mph or less.`);
    } else if (speed["kind"] === "unsure") {
      const limit = speed["limitMph"];
      if (limit === null) { /* the physics then assumes a typical city limit */ }
      else if (!isNum(limit)) bad("bad-speed", "The speed limit should be a number of mph.");
      else if (limit < LIMITS.minLimitMph) bad("bad-speed", `The speed limit can't be below ${LIMITS.minLimitMph} mph.`);
      else if (limit > LIMITS.maxLimitMph) bad("bad-speed", `The speed limit can't be above ${LIMITS.maxLimitMph} mph.`);
    } else {
      bad("bad-speed", "Each moving vehicle needs a speed, or 'not sure'.");
    }
  });
  return out;
}

/** The pin must be a point on the map. */
export function validatePin(pin: unknown): PlainMessage[] {
  return isFinitePoint(pin) ? [] : [msg("bad-pin", BAD_PIN_TEXT)];
}

export const cannotWorkOut = (): PlainMessage => msg("cannot-work-out", CANNOT_WORK_OUT_TEXT);

/** Would a track of this many samples be longer than any simulation is allowed to allocate? */
export const trackTooLong = (samples: number): boolean => samples > MAX_TRACK_SAMPLES;

export const tooLongMessage = (ids: readonly VehicleId[]): PlainMessage => msg("too-long", TOO_LONG_TEXT, ids);
