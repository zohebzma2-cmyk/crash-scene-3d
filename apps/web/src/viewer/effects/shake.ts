// The contact moment's timing: the slow-down around impact and the camera shake. Display only: the
// physics times and the readout stay true; only how fast the playback clock runs changes.

/** Playback slows to this fraction of its speed at the moment of impact. */
export const WARP_MIN = 0.25;
/** The slow-down covers this many seconds either side of impact. */
export const WARP_HALF_WINDOW_S = 0.25;
/** The camera shake lasts this long, in real time. */
export const SHAKE_MS = 150;
/** Largest shake offset, in CSS pixels of the view, and its rate in Hz. */
export const SHAKE_PX = 5;
const SHAKE_HZ = 38;

/**
 * Playback-clock multiplier at sim time t: 1 outside +-WARP_HALF_WINDOW_S of impact, easing down to WARP_MIN
 * at t = 0 along a raised cosine (smooth in and out). No slow-down with reduced motion.
 */
export function warpFactor(t: number, reducedMotion = false): number {
  if (reducedMotion) return 1;
  const a = Math.abs(t);
  if (a >= WARP_HALF_WINDOW_S) return 1;
  const bump = 0.5 * (1 + Math.cos((Math.PI * a) / WARP_HALF_WINDOW_S));   // 1 at impact, 0 at the window's edge
  return 1 - (1 - WARP_MIN) * bump;
}

/**
 * The playback rate to use at sim time t. The warp applies on top of normal speed; when the viewer already
 * chose a slower speed than 1x, that slow speed is enough, so it is not slowed again.
 */
export function effectiveRate(rate: number, t: number, reducedMotion = false): number {
  return rate >= 1 ? rate * warpFactor(t, reducedMotion) : rate;
}

/**
 * Camera shake offset in pixels, `elapsedMs` after the impact: a damped oscillation, deterministic from the
 * seed (two fixed phases), gone by SHAKE_MS. Writes into `out` (no allocation).
 */
export function shakeOffset(elapsedMs: number, seed: number, out: { x: number; y: number }): { x: number; y: number } {
  if (elapsedMs < 0 || elapsedMs >= SHAKE_MS) { out.x = 0; out.y = 0; return out; }
  const k = elapsedMs / SHAKE_MS;
  const damp = (1 - k) * (1 - k);
  const s = (elapsedMs / 1000) * SHAKE_HZ * Math.PI * 2;
  const p1 = ((seed >>> 0) % 628) / 100, p2 = ((seed >>> 10) % 628) / 100;
  out.x = SHAKE_PX * damp * Math.sin(s + p1);
  out.y = SHAKE_PX * 0.7 * damp * Math.sin(s * 1.31 + p2);
  return out;
}
