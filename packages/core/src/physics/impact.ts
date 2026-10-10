// Planar rigid-body impact: restitution along the contact normal plus a capped contact-friction impulse along the tangent.
//
// THE YAW MODEL (what makes a vehicle spin)
//   The impulse P = Jn n + Jt t acts at the contact point, at the lever arm r = (contact point) - (centre of mass). It gives
//     v_a' = v_a + P / m_a                 v_b' = v_b - P / m_b
//     w_a' = w_a + (r_a x P) / I_a         w_b' = w_b - (r_b x P) / I_b        (x = the 2-D cross product r_x P_y - r_y P_x)
//   so a hit through the centre of mass (r parallel to P) gives no spin, and an off-centre hit gives w = sum(r x J) / I over the
//   impulses (the normal one and the contact-friction one; with several contacts or the points of a patch, summed). I is the
//   yaw moment of inertia of a uniform box, m (L^2 + W^2) / 12, so a long or heavy vehicle spins less for the same push.
//   After the impact the spin slows at a constant rate, see slide.ts: alpha = mu g / k with k = sqrt(I / m).
//   Spin is counter-clockwise positive here; compass headings change by -w dt.
// Math frame: x = east, y = north, spin counter-clockwise positive seen from
// above (right-hand rule about up). Compass headings run the other way
// (clockwise positive), so compass heading rate = -spin. Convert only at the
// boundary with Pose.
import type { Vec2 } from "../contracts/geometry";
import { CONTACT_FRICTION } from "./constants";
import { cross, dot, sub } from "./geo";

/** One body in the impact: a rigid planar body with a yaw moment of inertia. */
export interface Body2D {
  readonly massKg: number;
  /** Yaw moment of inertia about the centre of mass, kg·m². */
  readonly inertiaKgM2: number;
  /** Centre of mass, meters (local ENU). */
  readonly centreM: Vec2;
  /** Velocity of the centre of mass, m/s (local ENU). */
  readonly velocityMps: Vec2;
  /** Yaw rate, rad/s, counter-clockwise positive. */
  readonly spinRadPs: number;
}

export interface ImpactResult {
  readonly a: Body2D;
  readonly b: Body2D;
  /** Magnitude of the normal impulse J, N·s (0 when the bodies are already separating). */
  readonly impulseNs: number;
  /** Tangential (contact-friction) impulse along t = (-n.y, n.x), N·s, signed; 0 when none acts. */
  readonly tangentialImpulseNs: number;
  /** "stick": the contact points leave with no relative slip; "slide": the friction cap bound; "none": separating, nothing happens. */
  readonly mode: "stick" | "slide" | "none";
}

const kinetic = (a: Body2D, b: Body2D): number =>
  0.5 * a.massKg * (a.velocityMps.x ** 2 + a.velocityMps.y ** 2) + 0.5 * a.inertiaKgM2 * a.spinRadPs ** 2 +
  0.5 * b.massKg * (b.velocityMps.x ** 2 + b.velocityMps.y ** 2) + 0.5 * b.inertiaKgM2 * b.spinRadPs ** 2;

/**
 * Planar impact at one contact point (Brach's planar impact mechanics): an impulse P = Jn n + Jt t, with
 * n the unit normal pointing from body b into body a (a gets +P, b gets -P) and t = (-n.y, n.x).
 *  - Normal: the contact points separate at e times their closing speed (Newton restitution).
 *  - Tangential: the contact-friction impulse is whatever stops the slip at the contact point (a "full impact": no
 *    sliding left after it), but never more than `contactFriction` times the normal impulse. If the cap binds,
 *    the surfaces keep sliding and Jt = +/- contactFriction * Jn, opposing the slip.
 * With a central hit and no slip this is exactly J = -(1+e)(v_rel . n) / (1/m_a + 1/m_b + (r_a x n)^2/I_a + (r_b x n)^2/I_b),
 * and `contactFriction` = 0 gives that formula for every hit. If v_rel . n >= 0 the bodies are separating: nothing changes.
 * Known limit of the sliding branch (cap reached): the friction impulse opposes the initial slip and never exceeds the cap, but it
 * is not strictly Coulomb: in a strongly coupled corner hit (K_nt away from 0) the NORMAL impulse itself can carry the slip through
 * zero, and once it has reversed, the friction impulse keeps pushing the original way instead of flipping with it. That happens in
 * about 5% of sliding corner hits at mu_c = 0.5 (more at smaller caps), and the same hits reverse the slip with no friction at all,
 * so it comes from rigid-body impact with Newton restitution, not from the friction. It is energy-safe and conserves momentum.
 * Where the contact normal passes through both centres (K_nt = 0) the slip never reverses. The tests pin both facts down.
 * Energy guard: if the gripping impulse would add kinetic energy (strongly coupled corner hits), it is blended back toward the
 * normal-only impulse (fixed 40-step bisection) until the kinetic energy does not rise. Momentum and angular momentum
 * are always conserved: every blend is still one equal-and-opposite impulse at one point.
 */
export function resolveImpact(a: Body2D, b: Body2D, pointM: Vec2, normal: Vec2, restitution: number, contactFriction: number = CONTACT_FRICTION): ImpactResult {
  // r: from each centre of mass to the contact point. Contact-point velocity = v + spin x r.
  const ra = sub(pointM, a.centreM), rb = sub(pointM, b.centreM);
  const va = { x: a.velocityMps.x - a.spinRadPs * ra.y, y: a.velocityMps.y + a.spinRadPs * ra.x };
  const vb = { x: b.velocityMps.x - b.spinRadPs * rb.y, y: b.velocityMps.y + b.spinRadPs * rb.x };
  const rel = sub(va, vb);
  const vn = dot(rel, normal);
  if (vn >= 0) return { a, b, impulseNs: 0, tangentialImpulseNs: 0, mode: "none" };
  const t = { x: -normal.y, y: normal.x };
  const vt = dot(rel, t);
  // Unit-impulse response of the relative contact velocity: K = (1/ma + 1/mb) I + pa pa^T/Ia + pb pb^T/Ib, pX = perp(rX).
  const pa = { x: -ra.y, y: ra.x }, pb = { x: -rb.y, y: rb.x };
  const pan = dot(pa, normal), pbn = dot(pb, normal), pat = dot(pa, t), pbt = dot(pb, t);
  const inv = 1 / a.massKg + 1 / b.massKg;
  const knn = inv + (pan * pan) / a.inertiaKgM2 + (pbn * pbn) / b.inertiaKgM2;
  const ktt = inv + (pat * pat) / a.inertiaKgM2 + (pbt * pbt) / b.inertiaKgM2;
  const knt = (pan * pat) / a.inertiaKgM2 + (pbn * pbt) / b.inertiaKgM2;
  const dvn = -(1 + restitution) * vn;
  const jn0 = dvn / knn; // the normal-only impulse: the guard's safe end
  let jn = jn0, jt = 0;
  let mode: "stick" | "slide" = "slide";
  if (contactFriction > 0) {
    const det = knn * ktt - knt * knt;
    const jnStick = (ktt * dvn - knt * -vt) / det;
    const jtStick = (-knt * dvn + knn * -vt) / det;
    if (jnStick > 0 && Math.abs(jtStick) <= contactFriction * jnStick) {
      jn = jnStick; jt = jtStick; mode = "stick";
    } else {
      const s = vt !== 0 ? -Math.sign(vt) : Math.sign(jtStick) || 1;
      const den = knn + s * contactFriction * knt;
      if (den > 0) { jn = dvn / den; jt = s * contactFriction * jn; }
      else if (jnStick > 0) { jn = jnStick; jt = jtStick; mode = "stick"; }
    }
  }
  const apply = (k: number): ImpactResult => {
    const jtk = jt * k, jnk = k === 1 ? jn : jn0 + k * (jn - jn0);
    const px = jnk * normal.x + jtk * t.x, py = jnk * normal.y + jtk * t.y;
    const spinA = (jnk * cross(ra, normal) + jtk * cross(ra, t)) / a.inertiaKgM2;
    const spinB = (jnk * cross(rb, normal) + jtk * cross(rb, t)) / b.inertiaKgM2;
    return {
      a: { ...a, velocityMps: { x: a.velocityMps.x + px / a.massKg, y: a.velocityMps.y + py / a.massKg }, spinRadPs: a.spinRadPs + spinA },
      b: { ...b, velocityMps: { x: b.velocityMps.x - px / b.massKg, y: b.velocityMps.y - py / b.massKg }, spinRadPs: b.spinRadPs - spinB },
      impulseNs: jnk, tangentialImpulseNs: jtk, mode,
    };
  };
  let out = apply(1);
  if (jt !== 0) {
    const ke0 = kinetic(a, b);
    if (kinetic(out.a, out.b) > ke0 * (1 + 1e-12)) {
      let lo = 0, hi = 1;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        const r = apply(mid);
        if (kinetic(r.a, r.b) <= ke0 * (1 + 1e-12)) lo = mid; else hi = mid;
      }
      out = apply(lo);
    }
  }
  return out;
}

/** One touching pair for `resolveContacts`: indices into the body list, the contact point, and the unit normal pointing from body `ib` into body `ia`. */
export interface ContactSpec {
  readonly ia: number;
  readonly ib: number;
  readonly pointM: Vec2;
  readonly normal: Vec2;
  /**
   * More points of the same contact patch (the ends of a face-to-face contact). After the impulse at `pointM`,
   * each is resolved in turn, so an off-centre hit can't leave one end of the touching faces still closing.
   */
  readonly extraPointsM?: readonly Vec2[];
}

/**
 * Three or four vehicles at t = 0: resolve the contacts one pair at a time, in the order given
 * (callers pass them sorted by vehicle letter), and repeat `passes` times so that a later pair
 * can't leave an earlier pair closing again. Every impulse conserves linear momentum and angular
 * momentum about any point, so the totals are conserved however many passes run. With two
 * vehicles the extra passes do nothing (the bodies are already separating). Deterministic.
 */
export function resolveContacts(bodies: readonly Body2D[], contacts: readonly ContactSpec[], restitution: number, passes: number, contactFriction: number = CONTACT_FRICTION): Body2D[] {
  const state = [...bodies];
  for (let pass = 0; pass < passes; pass++) {
    for (const c of contacts) {
      for (const point of [c.pointM, ...(c.extraPointsM ?? [])]) {
        const r = resolveImpact(state[c.ia]!, state[c.ib]!, point, c.normal, restitution, contactFriction);
        state[c.ia] = r.a;
        state[c.ib] = r.b;
      }
    }
  }
  return state;
}
