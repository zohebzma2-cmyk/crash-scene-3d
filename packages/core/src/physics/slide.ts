// Post-impact friction slide: translation and yaw, each slowing at a constant rate until it stops.
//
// THE SLIDE AND YAW MODEL (equations)
//   Translation: the centre of mass keeps moving along its velocity direction u = v0 / |v0| (NOT along the heading), slowing
//     at a = mu g:   speed(t) = v0 - a t,   distance(t) = v0 t - a t^2 / 2,   stops at t = v0 / a, after v0^2 / (2 a).
//   Yaw: the spin w0 left by the impact slows at a constant angular deceleration
//     alpha = mu g / k,  k = sqrt(I / m) (the radius of gyration):   w(t) = w0 - sign(w0) alpha t,   stops at t = |w0| / alpha.
//   Heading: it integrates the spin, so it turns by w0^2 / (2 alpha) in total (counter-clockwise for w0 > 0). Because the slide
//     follows the velocity and the heading follows the spin, a vehicle can slide sideways while it turns; and since the two
//     stop times differ, it can keep turning briefly after it stops sliding (or stop turning before it stops sliding).
//   Why mu g / k: a friction force mu m g spread over a body of radius of gyration k resists spin with torque of about
//     mu m g k, and I = m k^2, so alpha = (mu m g k) / (m k^2) = mu g / k.
// Same math frame as impact.ts: spin is counter-clockwise positive, so the
// compass heading changes by -spin * dt.
import type { Vec2 } from "../contracts/geometry";
import { G_MPS2 } from "./constants";

export interface SlideState {
  readonly positionM: Vec2;
  readonly velocityMps: Vec2;
  /** Compass bearing of the front, radians (0 = north, clockwise). */
  readonly headingRad: number;
  /** Yaw rate, rad/s, counter-clockwise positive. */
  readonly spinRadPs: number;
}

export interface SlideRun {
  /** samples[k] is the state at t = k * dtS; the last sample is at rest (zero velocity, zero spin). */
  readonly samples: readonly SlideState[];
  /** Time translation stops, s. */
  readonly restTimeS: number;
  /** Straight-line distance from the first to the last sample, m. */
  readonly distanceM: number;
}

/**
 * Slide one body to rest: translation decelerates at mu * g along its velocity
 * (so a body alone at speed v stops in v² / (2 mu g)). The yaw rate decays
 * monotonically to zero. With no `yawDecelRadPs2` it fades linearly and reaches
 * zero exactly when the translation stops. With it (the simulation passes
 * mu * g / k, k = the radius of gyration, so the rate depends on the road friction
 * and the vehicle's size) it slows at that constant rate, independent of the
 * translation, so the body can keep turning briefly after it stops sliding.
 * The heading is not wrapped. Fixed step, deterministic; the last sample is
 * the first one at or after the stop time.
 */
export function slideToRest(start: SlideState, mu: number, dtS: number, yawDecelRadPs2?: number): SlideRun {
  const v0 = Math.hypot(start.velocityMps.x, start.velocityMps.y);
  const a = mu * G_MPS2;
  const tTrans = v0 > 0 && a > 0 ? v0 / a : 0;
  const w0 = start.spinRadPs;
  const sgn = Math.sign(w0);
  const hasAlpha = yawDecelRadPs2 !== undefined && yawDecelRadPs2 > 0;
  const tYaw = w0 === 0 ? 0 : hasAlpha ? Math.abs(w0) / yawDecelRadPs2 : tTrans;
  const tEnd = Math.max(tTrans, tYaw);
  const dir = v0 > 0 ? { x: start.velocityMps.x / v0, y: start.velocityMps.y / v0 } : { x: 0, y: 0 };
  const distStop = tTrans > 0 ? (v0 * v0) / (2 * a) : 0;

  const at = (t: number): SlideState => {
    const tt = Math.min(t, tTrans);
    const s = tTrans > 0 ? v0 * tt - 0.5 * a * tt * tt : 0;
    const speed = t >= tTrans ? 0 : v0 - a * t;
    let spin = 0, turned = 0; // turned: integral of spin (counter-clockwise radians)
    if (w0 !== 0 && t < tYaw) {
      if (hasAlpha) { spin = sgn * (Math.abs(w0) - yawDecelRadPs2 * t); turned = sgn * (Math.abs(w0) * t - 0.5 * yawDecelRadPs2 * t * t); }
      else { spin = w0 * (1 - t / tYaw); turned = w0 * (t - (t * t) / (2 * tYaw)); }
    } else if (w0 !== 0) {
      turned = hasAlpha ? sgn * ((w0 * w0) / (2 * yawDecelRadPs2)) : (w0 * tYaw) / 2;
    }
    const pos = t >= tTrans ? distStop : s;
    return {
      positionM: { x: start.positionM.x + dir.x * pos, y: start.positionM.y + dir.y * pos },
      velocityMps: t >= tTrans ? { x: 0, y: 0 } : { x: dir.x * speed, y: dir.y * speed },
      headingRad: start.headingRad - turned,
      spinRadPs: spin,
    };
  };

  const samples: SlideState[] = [start];
  const n = tEnd > 0 ? Math.ceil(tEnd / dtS - 1e-9) : 0;
  for (let k = 1; k <= n; k++) {
    const t = k * dtS;
    samples.push(k === n ? atRest(at(Math.max(t, tEnd))) : at(t));
  }
  const first = samples[0]!, last = samples[samples.length - 1]!;
  return { samples, restTimeS: tTrans, distanceM: Math.hypot(last.positionM.x - first.positionM.x, last.positionM.y - first.positionM.y) };
}

/** The final sample is exactly at rest (no -0, no tiny leftovers). */
function atRest(s: SlideState): SlideState {
  return { positionM: s.positionM, velocityMps: { x: 0, y: 0 }, headingRad: s.headingRad, spinRadPs: 0 };
}
