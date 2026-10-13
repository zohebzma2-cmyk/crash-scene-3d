import type { RoadFeature, RoadFeatureKind } from "./contracts";
// The icons' stroke geometry (design/icons/feature-geometry.json, ~57 KB) is a separate entry, `@csd/core/icon-strokes`,
// so the main bundle doesn't carry it: the 3D view and the exports import it, the 2D diagram loads it on demand.
export type IconStrokes = Readonly<Record<string, readonly (readonly (readonly number[])[])[]>>;
export const FEATURE_NAMES: Readonly<Record<RoadFeatureKind, string>> = { signal: "Traffic signal", stop: "Stop sign", yield: "Yield", crosswalk: "Crosswalk", "turn-lanes": "Turn lanes", lanes: "Lane count", oneway: "One way", speed: "Speed limit", "street-light": "Street light" };
export const featureIcon = (kind: RoadFeatureKind): string => `feature-${kind}`;
export function featureDescription(f: RoadFeature): string {
  return `OpenStreetMap: ${f.label}. ${f.source === "way" && f.kind !== "crosswalk" ? "Road annotation; not a surveyed sign location." : f.facingDeg === null ? "Facing not tagged." : "Facing from OpenStreetMap."}`;
}
