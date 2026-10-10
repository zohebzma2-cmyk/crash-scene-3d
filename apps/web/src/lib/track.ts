// Pose of one vehicle at time t, interpolated from its fixed-step track.
// Same contract as core's poseAt; used by the fixtures stand-in and tests.
import type { Pose, SimulationResult, VehicleResult } from "@csd/core";

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

function lerpHeading(a: number, b: number, k: number): number {
  const twoPi = Math.PI * 2;
  let d = (b - a) % twoPi;
  if (d > Math.PI) d -= twoPi;
  if (d < -Math.PI) d += twoPi;
  return a + d * k;
}

export function poseFromTrack(sim: Pick<SimulationResult, "dtS" | "startTimeS">, vehicle: Pick<VehicleResult, "track">, tS: number): Pose {
  const track = vehicle.track;
  const last = track.length - 1;
  const first = track[0];
  if (!first) throw new Error("This vehicle has no track.");
  const f = Math.max(0, Math.min(last, (tS - sim.startTimeS) / sim.dtS));
  const i = Math.floor(f);
  const a = track[i] ?? first;
  const b = track[Math.min(last, i + 1)] ?? a;
  const k = f - i;
  return {
    xM: lerp(a.xM, b.xM, k),
    yM: lerp(a.yM, b.yM, k),
    headingRad: lerpHeading(a.headingRad, b.headingRad, k),
    speedMps: lerp(a.speedMps, b.speedMps, k),
  };
}
