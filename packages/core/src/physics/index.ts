// Physics + projection + placement API (Agent A; signatures are locked).
// Pure TS, SI units, no three.js, no DOM. See the plan for the equations.
//
//   projection.ts  toLocal / toLatLon (the same equirectangular formula mapdata uses)
//   lanes.ts       lanePath / streetsAtPin
//   placement.ts   placeVehicles (lane snapping, contact, 3-4 vehicles)
//   simulate.ts    simulate / poseAt
//   check.ts       checkScene
//   impact.ts      resolveImpact (planar impulse)      slide.ts  slideToRest (friction slide)
export { toLocal, toLatLon } from "./projection";
export { streetsAtPin, lanePath } from "./lanes";
export { placeVehicles } from "./placement";
export type { PlacedVehicle, PlacementOutcome } from "./placement";
export { simulate, poseAt, drawsAsEntered, PLACEMENT_UNITS } from "./simulate";
export type { DrawsOutcome, WorkMeter } from "./simulate";
export { checkScene } from "./check";
export { ACTION_LABELS, FIX_LIMITS, MAX_FIXES, MAX_FIX_TRIALS, PIN_FIX_MAX_M, suggestFixes, whySentence } from "./suggest";
export type { Fix, FixChange, FixField, FixFocus, FixOptions, FixSuggestions } from "./suggest";
export * from "./constants";
export * from "./impact";
export * from "./slide";
