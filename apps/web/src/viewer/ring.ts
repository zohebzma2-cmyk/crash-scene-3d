// The impact ring: its size and where it sits. Plain geometry with no three.js, so the camera framing (math.ts),
// the scene geometry, the live picture, the stills and the effects all read the one placement.
import type { Vec2 } from "@csd/core";

/** The impact ring's inner and outer radius, meters. */
export const RING_M = { inner: 1.3, outer: 1.65 } as const;
/** The ring keeps at least this far clear of every body at the impact, meters. */
const RING_CLEAR_M = 0.15;
/** How far to the side the ring may move to clear the bodies, meters, and the step it moves in. */
const RING_REACH_M = 20, RING_STEP_M = 0.1;

/** Where the impact ring goes: `center` (clear of both bodies), and `anchor`, where the vehicles touched (its leader line's end). */
export interface RingPlacement { readonly center: Vec2; readonly anchor: Vec2 }

type ImpactBody = { readonly impactPose: { readonly xM: number; readonly yM: number; readonly headingRad: number }; readonly lengthM: number; readonly widthM: number };

/** Corners of a vehicle's footprint at a pose (compass heading: 0 = north, x east, y north). */
function footprint(b: ImpactBody): Vec2[] {
  const p = b.impactPose, fx = Math.sin(p.headingRad), fy = Math.cos(p.headingRad), rx = fy, ry = -fx;
  return ([[1, 1], [1, -1], [-1, -1], [-1, 1]] as const).map(([a, c]) => ({ x: p.xM + fx * a * (b.lengthM / 2) + rx * c * (b.widthM / 2), y: p.yM + fy * a * (b.lengthM / 2) + ry * c * (b.widthM / 2) }));
}

/** Distance from p to a convex polygon (0 inside). */
function distToPolygon(p: Vec2, poly: readonly Vec2[]): number {
  let best = Infinity, left = 0, right = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
    const ex = b.x - a.x, ey = b.y - a.y;
    const side = ex * (p.y - a.y) - ey * (p.x - a.x);
    if (side > 0) left++; else if (side < 0) right++;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.y - a.y) * ey) / (ex * ex + ey * ey || 1)));
    best = Math.min(best, Math.hypot(p.x - (a.x + ex * t), p.y - (a.y + ey * t)));
  }
  // Inside a convex polygon the point is on the same side of every edge, whichever way round its corners go.
  return left === 0 || right === 0 ? 0 : best;
}

/**
 * The impact ring sits beside the crash, not on the cars: from where they touched (`sim.impactPointM`) it moves sideways
 * (along the line of the touching faces, then any way round) the least distance that keeps its whole outline RING_CLEAR_M
 * clear of every body at the impact. A short leader line joins it to where they touched. Deterministic: the same picture
 * every time.
 */
export function ringPlacement(sim: { readonly impactPointM: Vec2; readonly vehicles: ReadonlyArray<ImpactBody & { readonly impact?: { readonly normal: Vec2 } }> }): RingPlacement {
  const anchor = sim.impactPointM;
  const bodies = sim.vehicles.map(footprint);
  const clear = (c: Vec2): boolean => bodies.every((poly) => distToPolygon(c, poly) >= RING_M.outer + RING_CLEAR_M);
  if (clear(anchor)) return { center: anchor, anchor };
  const n = sim.vehicles.find((v) => v.impact)?.impact?.normal ?? { x: 1, y: 0 };
  const len = Math.hypot(n.x, n.y) || 1;
  const tangent = { x: -n.y / len, y: n.x / len };
  // First along the touching faces (either way), then round the clock in 15-degree steps.
  const dirs: Vec2[] = [tangent, { x: -tangent.x, y: -tangent.y }];
  for (let k = 1; k < 24; k++) {
    const a = (k * Math.PI) / 12, c = Math.cos(a), s = Math.sin(a);
    dirs.push({ x: tangent.x * c - tangent.y * s, y: tangent.x * s + tangent.y * c });
  }
  for (let d = RING_STEP_M; d <= RING_REACH_M + 1e-9; d += RING_STEP_M) {
    for (const u of dirs) {
      const c = { x: anchor.x + u.x * d, y: anchor.y + u.y * d };
      if (clear(c)) return { center: c, anchor };
    }
  }
  return { center: anchor, anchor };
}

/**
 * The ring's outline (8 points round its outer edge), for anything that must keep it in frame: the live Top and Wide
 * cameras and the stills. Beside the cars on a phone it would otherwise sit at the frame's edge and leave the
 * vehicle labels no clear spot.
 */
export function ringOutline(sim: Parameters<typeof ringPlacement>[0]): Vec2[] {
  const c = ringPlacement(sim).center;
  const pts: Vec2[] = [];
  for (let i = 0; i < 8; i++) pts.push({ x: c.x + Math.cos((i * Math.PI) / 4) * RING_M.outer, y: c.y + Math.sin((i * Math.PI) / 4) * RING_M.outer });
  return pts;
}
