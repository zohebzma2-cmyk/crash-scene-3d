// The Aftermath view: the picture of how it ended. Both vehicles at rest with their damage, the skid
// marks, the debris field, the point-of-impact ring and the measurements. This file says WHAT to frame (a
// pure function of the simulation, so the export still and the live view agree); cameraFor in math.ts places the camera.
import type { Pose, SimulationResult, Vec2 } from "@csd/core";
import type { Box } from "../math";

/** Extra room around everything, m. */
export const AFTERMATH_MARGIN_M = 3.5;
/** Elevation of the aftermath camera above the ground, degrees: steeper than Wide (50) so the marks read, low enough to show the dents. */
export const AFTERMATH_ELEVATION_DEG = 60;
/** How much of the view the aftermath fills (the camera itself is in math.ts, next to Top and Wide). */
export const AFTERMATH_FILL = 0.86;

/** Bounds of everything the Aftermath view shows: impact point, both vehicles at impact and rest, the slide paths and the debris. */
export function aftermathBox(sim: SimulationResult, extraPoints: readonly Vec2[] = [], marginM = AFTERMATH_MARGIN_M): Box {
  const pts: Vec2[] = [sim.impactPointM, ...extraPoints];
  const iImpact = Math.round((0 - sim.startTimeS) / sim.dtS);
  const step = Math.max(1, Math.round(0.25 / sim.dtS));
  for (const v of sim.vehicles) {
    const r = Math.max(v.lengthM, v.widthM) / 2;
    const poses: Pose[] = [v.impactPose, v.restPose];
    for (let i = iImpact; i < v.track.length; i += step) poses.push(v.track[i]!);
    for (const p of poses) pts.push({ x: p.xM - r, y: p.yM - r }, { x: p.xM + r, y: p.yM + r });
  }
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return { minX: Math.min(...xs) - marginM, minY: Math.min(...ys) - marginM, maxX: Math.max(...xs) + marginM, maxY: Math.max(...ys) + marginM };
}
