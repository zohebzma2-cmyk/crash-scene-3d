// Model constants. Every one is listed in the result's assumptions.
import { LIMITS, type RoadCondition } from "../contracts/scene";

export const PHYSICS_VERSION = "3.0.0";
/** Standard gravity, m/s². */
export const G_MPS2 = 9.80665;
/** Tire–road friction for the whole road, by entered condition (typical single values, not a measurement). */
export const FRICTION: Readonly<Record<RoadCondition, number>> = Object.freeze({ dry: 0.7, wet: 0.5, snow: 0.25, ice: 0.1 });
/** Coefficient of restitution along the contact normal (simplified collision). */
export const RESTITUTION = 0.2;
/**
 * Contact-plane friction between the two vehicles' crushed surfaces: the cap on the tangential impulse as a fraction of the
 * normal impulse (Brach's impulse ratio, mu). The hit grips (no slip left at the contact) unless that would need more than this.
 * Sources: Brach, Mechanical Impact Dynamics (Wiley 1991); Brach & Brach, Vehicle Accident Analysis and Reconstruction Methods
 * (SAE 2005/2011), planar impact mechanics; Brach, Accident Analysis & Prevention 15(4), 1983; Steffan & Moser, SAE 960886
 * (restitution plus contact-plane friction, "full impact"). UNVERIFIED (verified: false): 0.5 is a typical sheet-metal-on-sheet-metal
 * figure, not a measured constant, and needs a primary table before release. The T-bone result does not depend on it anywhere in [0.45, infinity).
 */
export const CONTACT_FRICTION = 0.5;
/** Fixed integration and sampling step, s. */
export const DT_S = 1 / 120;
/** Approach window shown before impact, s. The typed speed is the speed AT impact; the picture works backwards from it. */
export const APPROACH_S = 5;
/** A vehicle marked as braking decelerates during the last BRAKING_S before impact and holds a steady speed before that, s. */
export const BRAKING_S = 1.5;
/** "Not sure" speeds: posted limit ± this, mph (converted at the boundary). */
export const RANGE_HALF_MPH = 5;
/** Limit assumed when the claimant doesn't know it, mph. */
export const DEFAULT_LIMIT_MPH = 25;
/** Unit conversions (exact). */
export const MPH_TO_MPS = 0.44704;
export const M_TO_FT = 1 / 0.3048;
/** Overlap tolerance for the no-overlap-before-impact check, m. */
export const OVERLAP_TOLERANCE_M = 0.05;
/** Braking where the claimant entered it: this fraction of the tire-road limit mu * g (a hard stop that stays under the grip limit). */
export const BRAKE_FACTOR = 0.7;
/** Turning vehicles follow a circular arc of this radius, m (left turns are wider than right turns). */
export const TURN_RADIUS_LEFT_M = 10;
export const TURN_RADIUS_RIGHT_M = 6;
/** Sequential pairwise passes when three or more vehicles meet at t = 0. */
export const IMPACT_PASSES = 4;

/** Two vehicles must close at more than this along their contact normal, m/s, to be hitting each other. */
export const MIN_CLOSING_MPS = 0.05;
/** "Not sure" speeds are scanned between low and high in steps of this many mph to find the range where the crash works. */
export const RANGE_STEP_MPH = 0.5;

/** With road data given, the pin must have a road (or a parking lot) within this distance, m; otherwise there is nowhere to put the crash. */
export const ROAD_REACH_M = 40;
/** The fastest speed the tool accepts, m/s. */
export const MAX_SPEED_MPS = LIMITS.maxSpeedMph * MPH_TO_MPS;
/**
 * No simulation allocates more track samples than this: the approach window, plus the longest slide a
 * post-impact speed of three times the fastest accepted speed could have on ice (far above what two
 * rigid bodies can reach), plus 30 s of margin, at the fixed step. Beyond it the crash is refused.
 */
export const MAX_TRACK_SAMPLES = Math.ceil((APPROACH_S + (3 * MAX_SPEED_MPS) / (FRICTION.ice * G_MPS2) + 30) / DT_S);
