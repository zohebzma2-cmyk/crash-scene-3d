// `@csd/core/sun`: the sun estimate bound to the offline zone lookup. A separate entry (not in the core index), so
// tz-lookup's ~73 KB only loads where an estimate is used: the 3D viewer's chunk and the scene questions.
import tzLookup from "tz-lookup";
import type { Scene } from "./contracts";
import { estimateSunWith, type SunEstimate } from "./lighting";

export type { SunEstimate } from "./lighting";
export const estimateSun = (scene: Pick<Scene, "location" | "occurred">): SunEstimate | null => estimateSunWith(tzLookup, scene);
