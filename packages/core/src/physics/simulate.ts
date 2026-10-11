// The model: approach worked out backwards from the impact, planar impulse at t = 0, friction slide to rest.
// SI units. Fixed step DT_S, deterministic.
//
// The typed speed is the speed AT the impact. A vehicle marked as braking decelerates during the last BRAKING_S
// before it and holds a steady speed before that (so it is faster earlier, and can't stop before the impact);
// a vehicle not braking holds its speed for the whole APPROACH_S window. See model.approachBack().
//
// "Not sure" speeds: the low-to-high range is scanned in RANGE_STEP_MPH steps (all "not sure" vehicles together).
// At each speed the crash must work: the contacts close at the impact, no vehicle passes through another or a
// building before it, and the vehicles reach the contact. The ranges shown cover only the speeds that work.
// The picture uses the middle speed if it works, else the nearest one that does. With none, nothing is drawn.
import type { Pose, Range, Vec2 } from "../contracts/geometry";
import type { RoadNetwork } from "../contracts/roads";
import type { Scene } from "../contracts/scene";
import type { Assumption, ImpactData, PlainMessage, SimulationOutcome, SimulationResult, VehicleResult } from "../contracts/simulation";
import type { Zone } from "../contracts/scene";
import { PRESETS } from "../presets";
import { ROAD_WORDS, ZONE_WORDS, formatAcceleration, formatMassKg, formatMassLb, formatMphNumber, formatSpeedExact } from "../format";
import {
  APPROACH_S, BRAKE_FACTOR, BRAKING_S, CONTACT_FRICTION, DT_S, DEFAULT_LIMIT_MPH, FRICTION, G_MPS2, IMPACT_PASSES, MPH_TO_MPS, OVERLAP_TOLERANCE_M, PHYSICS_VERSION, RANGE_HALF_MPH,
  RANGE_STEP_MPH, RESTITUTION, TURN_RADIUS_LEFT_M, TURN_RADIUS_RIGHT_M,
} from "./constants";
import {
  add, boxCorners, boxOverlapsRing, dist, dot, fwdOf, makePoly, mul, openRing, pointAt, project, rightOf, satDepth, sub, wrap2Pi, wrapPi, pointInRing,
} from "./geo";
import { type Body2D, type ContactSpec, resolveContacts } from "./impact";
import { checkScene } from "./check";
import { cleanNet } from "./lanes";
import { type CutKind, cutSentence, excludedRuns, gapSentence, selectRange } from "./ranges";
import { type Approach, ZONE_ANGLE_RAD, approachBack, approachFor, brakeDecel, letterName, speedCases, vehicleWord, zoneAnchorLocal } from "./model";
import { type ClosingFailure, type Contact, type MotionBody, type PlacedBody, closingFailure, closingMessage, placeDetailed } from "./placement";
import { toLocal } from "./projection";
import { cannotWorkOut, tooLongMessage, trackTooLong, validatePin, validateScene } from "./validate";
import { type SlideState, slideToRest } from "./slide";

const bearingOfSeg = (a: Vec2, b: Vec2): number => Math.atan2(b.x - a.x, b.y - a.y);
const sortedPair = (c: { a: string; b: string }): [string, string] => (c.a < c.b ? [c.a, c.b] : [c.b, c.a]);

/**
 * The bodies just before the impulses (speeds at the impact, after any braking) and the contacts in a fixed order:
 * by the pair's letters (lower letter, then higher), not by which vehicle attached. Used by the run and by tests.
 */
export function impactInput(
  bodies: readonly PlacedBody[], contacts: readonly Contact[], enteredMps: readonly number[], mu: number,
): { before: Body2D[]; specs: ContactSpec[]; approach: Approach[] } {
  const approach = bodies.map((b, i) => approachFor(enteredMps[i]!, b.veh.braking && b.guide.moving ? brakeDecel(mu) : 0));
  const before: Body2D[] = bodies.map((b, i) => ({
    massKg: b.dims.massKg, inertiaKgM2: b.dims.inertiaKgM2, centreM: b.centre,
    velocityMps: b.guide.moving ? mul(fwdOf(b.travelBearingRad), approach[i]!.vImpactMps) : { x: 0, y: 0 }, spinRadPs: 0,
  }));
  const index = new Map(bodies.map((b, i) => [b.id, i]));
  const specs = [...contacts]
    .sort((x, y) => { const p = sortedPair(x), q = sortedPair(y); return p[0].localeCompare(q[0]) || p[1].localeCompare(q[1]); })
    .map((c) => ({ ia: index.get(c.a)!, ib: index.get(c.b)!, pointM: c.patchM[0] ?? c.pointM, normal: c.normal, extraPointsM: c.patchM.slice(1) }));
  return { before, specs, approach };
}

// ---------------------------------------------------------------- the world around the vehicles

/** Does a vehicle rectangle overlap any building? Buildings are pre-filtered by bounding box. */
interface WallTester {
  (p: Pose, lengthM: number, widthM: number): boolean;
  /** The same test, for poses that all lie inside this box (expanded by the vehicle's reach): only the buildings near it are tried. */
  near(minX: number, maxX: number, minY: number, maxY: number): (p: Pose, lengthM: number, widthM: number) => boolean;
}
function wallTester(roads: RoadNetwork | null): WallTester {
  const walls = (roads?.buildings ?? []).map((b) => {
    const ring = openRing(b.footprint);
    const xs = ring.map((q) => q.x), ys = ring.map((q) => q.y);
    return { ring, minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  });
  const test = (list: typeof walls) => (p: Pose, L: number, W: number): boolean => {
    const r = Math.hypot(L, W) / 2;
    return list.some((w) =>
      p.xM >= w.minX - r && p.xM <= w.maxX + r && p.yM >= w.minY - r && p.yM <= w.maxY + r &&
      boxOverlapsRing(p.xM, p.yM, p.headingRad, L, W, w.ring, OVERLAP_TOLERANCE_M));
  };
  const all = test(walls) as WallTester;
  // A wall whose box misses the poses' box grown by r (the vehicle's half-diagonal) fails the first test for every one of them.
  all.near = (minX, maxX, minY, maxY) => test(walls.filter((w) => w.maxX >= minX && w.minX <= maxX && w.maxY >= minY && w.minY <= maxY));
  return all;
}

/** Is any corner of the vehicle off the road (road width plus 30 cm) and outside every parking lot? */
function offRoadTester(roads: RoadNetwork): (p: Pose, lengthM: number, widthM: number) => boolean {
  const ways = roads.ways.map((w) => ({ poly: makePoly(w.centerline), half: ((w.oneway ? w.lanesForward : w.lanesForward + w.lanesBackward) * w.laneWidthM) / 2 + 0.3 }));
  return (p, L, W) => boxCorners(p.xM, p.yM, p.headingRad, L, W).some((c) =>
    !ways.some((w) => project(w.poly, c).dist <= w.half) && !roads.parking.some((lot) => pointInRing(c, lot.outline)));
}

// ---------------------------------------------------------------- one scanned speed

type Reason =
  | { readonly kind: "closing"; readonly f: ClosingFailure }
  | { readonly kind: "pass"; readonly a: PlacedBody["id"]; readonly b: PlacedBody["id"] }
  | { readonly kind: "building"; readonly id: PlacedBody["id"] };

const reasonMessage = (r: Reason, allIds: readonly PlacedBody["id"][]): PlainMessage => {
  if (r.kind === "closing") return closingMessage(r.f, allIds);
  if (r.kind === "pass") {
    return { code: "passes-through", text: `${letterName(r.a)} would have passed through ${vehicleWord(r.b)} before the crash. Check the speeds, directions or lanes.`, vehicleIds: [r.a, r.b] };
  }
  return { code: "on-building", text: `${letterName(r.id)} would have driven through a building before the crash. Check the speeds, directions or lane.`, vehicleIds: [r.id] };
};

interface Evaluated { readonly ent: number[]; readonly reasons: Reason[] }

interface BodyRun {
  readonly vImpact: number;
  readonly dApproach: number;
  /** State at t = k * DT_S after the impact, with the slide stopped at any building wall. */
  readonly post: SlideState[];
  readonly stoppedAtWall: boolean;
  /** Index of the vehicle this one would have slid into and was stopped by, or null. */
  readonly stoppedBy: number | null;
  /** Size of the velocity change at the impact, m/s. */
  readonly deltaV: number;
  /** Yaw rate right after the impact, rad/s, counter-clockwise positive (the math frame). */
  readonly spinAfter: number;
}

/** The zone anchor (mid-side or corner) nearest to a point on the body; the point is in the world frame. */
function zoneNearest(p: Vec2, centre: Vec2, headingRad: number, L: number, W: number): Zone {
  const f = fwdOf(headingRad), r = rightOf(headingRad);
  const d = { x: p.x - centre.x, y: p.y - centre.y };
  const a = d.x * f.x + d.y * f.y, b = d.x * r.x + d.y * r.y;
  let best: Zone = "front", bestD = Infinity;
  for (const z of Object.keys(ZONE_ANGLE_RAD) as Zone[]) {
    const an = zoneAnchorLocal(z, L, W);
    const dd = Math.hypot(a - an.a, b - an.b);
    if (dd < bestD - 1e-12) { bestD = dd; best = z; }
  }
  return best;
}

/** Cut a slide short where the vehicle would run into a building: it stays at the last clear sample. */
function stopAtWalls(samples: readonly SlideState[], L: number, W: number, hits: (p: Pose, L: number, W: number) => boolean): { post: SlideState[]; stopped: boolean } {
  for (let k = 1; k < samples.length; k++) {
    const s = samples[k]!;
    if (!hits({ xM: s.positionM.x, yM: s.positionM.y, headingRad: s.headingRad, speedMps: 0 }, L, W)) continue;
    const stop: SlideState = { ...samples[k - 1]!, velocityMps: { x: 0, y: 0 }, spinRadPs: 0 };
    return { post: [...samples.slice(0, k), ...Array<SlideState>(samples.length - k).fill(stop)], stopped: true };
  }
  return { post: [...samples], stopped: false };
}

/**
 * There are no later collisions, but bodies must never overlap: not while they slide and not at rest. Walk the slides
 * in time; the moment two bodies overlap by more than the tolerance, the one moving into the other (the larger velocity
 * component toward it along the overlap axis; on a tie the faster, then the later letter) stops at its last clear
 * sample and stays there, as with a wall. Deterministic. Returns the new slides and, per body, who stopped it.
 */
function stopAtVehicles(posts: readonly SlideState[][], dims: ReadonlyArray<{ L: number; W: number }>): { posts: SlideState[][]; stoppedBy: Array<number | null> } {
  const n = posts.length;
  const out = posts.map((p) => [...p]);
  const stoppedBy: Array<number | null> = posts.map(() => null);
  const len = Math.max(...posts.map((p) => p.length));
  const at = (i: number, k: number): SlideState => out[i]![Math.min(k, out[i]!.length - 1)]!;
  const box = (i: number, k: number): Vec2[] => { const s = at(i, k); return boxCorners(s.positionM.x, s.positionM.y, s.headingRad, dims[i]!.L, dims[i]!.W); };
  for (let k = 1; k < len; k++) {
    for (let guard = 0; guard < 2 * n; guard++) {
      let changed = false;
      for (let i = 0; i < n && !changed; i++) {
        for (let j = i + 1; j < n && !changed; j++) {
          const sat = satDepth(box(i, k), box(j, k));
          if (sat.depth <= OVERLAP_TOLERANCE_M) continue;
          const a = at(i, k), b = at(j, k);
          const ti = Math.max(0, -(a.velocityMps.x * sat.axis.x + a.velocityMps.y * sat.axis.y)); // i moving toward j (axis points from j into i)
          const tj = Math.max(0, b.velocityMps.x * sat.axis.x + b.velocityMps.y * sat.axis.y);
          const speedI = Math.hypot(a.velocityMps.x, a.velocityMps.y), speedJ = Math.hypot(b.velocityMps.x, b.velocityMps.y);
          let pick = ti > tj + 1e-9 ? i : tj > ti + 1e-9 ? j : speedI > speedJ + 1e-9 ? i : j;
          if (stoppedBy[pick] !== null) pick = pick === i ? j : i; // already stopped: the other one is the one still moving
          if (stoppedBy[pick] !== null) continue;
          const other = pick === i ? j : i;
          const stop: SlideState = { ...at(pick, k - 1), velocityMps: { x: 0, y: 0 }, spinRadPs: 0 };
          out[pick] = [...out[pick]!.slice(0, k), ...Array<SlideState>(Math.max(0, len - k)).fill(stop)];
          stoppedBy[pick] = other;
          changed = true;
        }
      }
      if (!changed) break;
    }
  }
  return { posts: out, stoppedBy };
}

const rangeOf = (vals: readonly number[], midIndex: number): Range => ({ lo: Math.min(...vals), mid: vals[midIndex]!, hi: Math.max(...vals) });

/**
 * Run the model. Deterministic for the same inputs. The input is not trusted: the scene is checked here (speeds, directions,
 * vehicle count, location), a pin that isn't a point on the map is refused, and anything unexpected comes back as a plain
 * message, never an exception.
 */
export function simulate(scene: Scene, roads: RoadNetwork | null): SimulationOutcome {
  try {
    const invalid = validateScene(scene);
    if (invalid.length) return { ok: false, errors: invalid };
    return simulateChecked(scene, roads, false) as SimulationOutcome;
  } catch {
    return { ok: false, errors: [cannotWorkOut()] };
  }
}

/**
 * Counts the work a drawsAsEntered call does, in units of one vehicle (or one pair of vehicles) checked at one sample of the
 * approach, plus a fixed amount per placement. The one-tap fixer caps its search by this count: it tracks the time taken
 * closely, yet is the same on every machine, so the fixes found never depend on how fast the device is.
 */
export interface WorkMeter { units: number }
/** Work units charged for one placement (about the cost of checking a two-vehicle approach at 150 samples). */
export const PLACEMENT_UNITS = 600;

/** Whether a scene draws exactly as entered, without the picture (see drawsAsEntered). */
export type DrawsOutcome = { readonly ok: true } | { readonly ok: false; readonly errors: readonly PlainMessage[] };

/**
 * Does the scene draw exactly as entered? The same answer as `simulate(scene, roads).ok` with no "zone-used" warning (no hit
 * side swapped in), and the same errors whenever simulate() refuses, at a fraction of the cost: the entered hit sides are
 * placed as they are (no zone fallback), the "not sure" speeds are scanned outward from the middle and stop at the first that
 * works (the one the picture would use), each speed stops at its first problem, and only that speed's slide is run (for the
 * crash-too-long check). No warnings, no tracks. For the one-tap fixer, which tries many small changes.
 */
export function drawsAsEntered(scene: Scene, roads: RoadNetwork | null, meter?: WorkMeter): DrawsOutcome {
  try {
    const invalid = validateScene(scene);
    if (invalid.length) return { ok: false, errors: invalid };
    return simulateChecked(scene, roads, true, meter);
  } catch {
    return { ok: false, errors: [cannotWorkOut()] };
  }
}

/**
 * The model. With `drawsOnly`, it stops as soon as it knows whether the scene draws as entered and returns a DrawsOutcome
 * (see drawsAsEntered); otherwise the full SimulationOutcome.
 */
function simulateChecked(scene: Scene, rawRoads: RoadNetwork | null, drawsOnly: boolean, meter?: WorkMeter): SimulationOutcome | DrawsOutcome {
  const roads = rawRoads ? cleanNet(rawRoads) : null;
  const frame = roads?.frame ?? { origin: { lat: scene.location.lat, lon: scene.location.lon } };
  const pin = toLocal(frame, { lat: scene.location.lat, lon: scene.location.lon });
  const badPin = validatePin(pin);
  if (badPin.length) return { ok: false, errors: badPin };
  // Entered zones exactly, closing left to the scan: what placeDetailed gives simulate() whenever it uses no other zone.
  if (meter) meter.units += PLACEMENT_UNITS * scene.vehicles.length;
  const placed = placeDetailed(scene, roads, pin, drawsOnly ? { checkClosing: false, exactZones: true } : { checkClosing: false });
  if (!placed.ok) return { ok: false, errors: placed.errors };
  const { bodies, contacts, impactPointM, zonesUsed } = placed.value;
  const mu = FRICTION[scene.road.condition];
  const allIds = bodies.map((b) => b.id);
  const cases = bodies.map((b) => speedCases(b.veh));
  const unsureIdx = cases.map((c, i) => (c.unsure ? i : -1)).filter((i) => i >= 0);
  const hits = wallTester(roads);
  const i0 = Math.round(APPROACH_S / DT_S);
  const motion: MotionBody[] = bodies.map((b) => ({ veh: b.veh, travelBearingRad: b.travelBearingRad, moving: b.guide.moving }));

  // ---- the speeds to scan: one when everything is known, else low..high in steps (all "not sure" vehicles together)
  const nK = unsureIdx.length ? Math.round((2 * RANGE_HALF_MPH) / RANGE_STEP_MPH) : 0;
  const midK = unsureIdx.length ? Math.round(RANGE_HALF_MPH / RANGE_STEP_MPH) : 0;
  const enteredAt = (k: number): number[] => cases.map((c) => (c.unsure ? (c.limitMph! - RANGE_HALF_MPH + k * RANGE_STEP_MPH) * MPH_TO_MPS : c.mid));
  const approachesAt = (ent: readonly number[]): Approach[] => bodies.map((b, i) => approachFor(ent[i]!, b.veh.braking && b.guide.moving ? brakeDecel(mu) : 0));

  /**
   * The path the vehicle's CENTRE follows: its lane line moved sideways and along by the offset it has at the
   * impact, measured in the vehicle's own frame (so on a turn the offset turns with the vehicle). Distances are
   * measured along this path, so the centre covers speed x time whatever the offset.
   */
  const centreFor = new Map<string, { poly: ReturnType<typeof makePoly>; sFoot: number }>();
  const centrePath = (b: PlacedBody) => {
    const hit = centreFor.get(b.id);
    if (hit) return hit;
    const guide = b.guide.poly;
    const sFoot = project(guide, b.centre).s;
    const g0 = pointAt(guide, sFoot);
    const off = sub(b.centre, g0.p);
    const along = dot(off, fwdOf(g0.bearing)), side = dot(off, rightOf(g0.bearing));
    const pts = guide.pts.map((p, i) => {
      const prev = i > 0 ? bearingOfSeg(guide.pts[i - 1]!, p) : undefined, next = i + 1 < guide.pts.length ? bearingOfSeg(p, guide.pts[i + 1]!) : undefined;
      const beta = prev === undefined ? next! : next === undefined ? prev : prev + wrapPi(next - prev) / 2;
      return add(add(p, mul(fwdOf(beta), along)), mul(rightOf(beta), side));
    });
    const poly = makePoly(pts);
    const out = { poly, sFoot: project(poly, b.centre).s };
    centreFor.set(b.id, out);
    return out;
  };

  /** The poses from t = -APPROACH_S to the impact. */
  const preTrack = (b: PlacedBody, ap: Approach): Pose[] => {
    const out: Pose[] = [];
    const { poly, sFoot } = centrePath(b);
    const aBrake = b.veh.braking && b.guide.moving ? brakeDecel(mu) : 0;
    for (let i = 0; i < i0; i++) {
      if (!b.guide.moving) { out.push({ xM: b.centre.x, yM: b.centre.y, headingRad: wrap2Pi(b.headingRad), speedMps: 0 }); continue; }
      const kin = approachBack(ap.vImpactMps, aBrake, (i0 - i) * DT_S); // (i0 - i) steps before the impact
      const pp = pointAt(poly, sFoot - kin.s);
      out.push({ xM: pp.p.x, yM: pp.p.y, headingRad: wrap2Pi(pp.bearing + b.guide.facingOffset), speedMps: kin.v });
    }
    out.push({ xM: b.centre.x, yM: b.centre.y, headingRad: wrap2Pi(b.headingRad), speedMps: ap.vImpactMps });
    return out;
  };

  /** One scanned speed: what stops the crash working there. With `firstOnly`, stop at the first problem (all drawsOnly needs). */
  const halfDiag = bodies.map((b) => Math.hypot(b.dims.lengthM, b.dims.widthM) / 2);
  const evaluate = (k: number, firstOnly = false): Evaluated => {
    const ent = enteredAt(k);
    const f = closingFailure(motion, contacts, ent);
    if (f) return { ent, reasons: [{ kind: "closing", f }] };
    const ap = approachesAt(ent);
    const pre = bodies.map((b, bi) => preTrack(b, ap[bi]!));
    const perSample = bodies.length + (bodies.length * (bodies.length - 1)) / 2;
    // Each vehicle's approach is tested only against the buildings near it (the same answer, sooner).
    const nearHits = pre.map((track, bi) => {
      const r = halfDiag[bi]! + 1e-6;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const q of track) { if (q.xM < minX) minX = q.xM; if (q.xM > maxX) maxX = q.xM; if (q.yM < minY) minY = q.yM; if (q.yM > maxY) maxY = q.yM; }
      return hits.near(minX - r, maxX + r, minY - r, maxY + r);
    });
    if (meter) meter.units += bodies.length * i0;
    const reasons: Reason[] = [];
    const passed = new Set<string>(), onBuilding = new Set<string>();
    for (let i = 0; i <= i0; i++) {
      if (meter) meter.units += perSample;
      if (i < i0) {
        for (let a = 0; a < bodies.length; a++) {
          for (let b = a + 1; b < bodies.length; b++) {
            if (passed.has(`${a}-${b}`)) continue;
            const pa = pre[a]![i]!, pb = pre[b]![i]!;
            // Centres further apart than the two half-diagonals: the boxes can't touch (the same answer as the full test, sooner).
            if (Math.hypot(pa.xM - pb.xM, pa.yM - pb.yM) > halfDiag[a]! + halfDiag[b]! + OVERLAP_TOLERANCE_M) continue;
            if (satDepth(boxCorners(pa.xM, pa.yM, pa.headingRad, bodies[a]!.dims.lengthM, bodies[a]!.dims.widthM),
              boxCorners(pb.xM, pb.yM, pb.headingRad, bodies[b]!.dims.lengthM, bodies[b]!.dims.widthM)).depth <= OVERLAP_TOLERANCE_M) continue;
            passed.add(`${a}-${b}`);
            reasons.push({ kind: "pass", a: bodies[a]!.id, b: bodies[b]!.id });
            if (firstOnly) return { ent, reasons };
          }
        }
      }
      for (let bi = 0; bi < bodies.length; bi++) {
        const b = bodies[bi]!;
        if (onBuilding.has(b.id) || !nearHits[bi]!(pre[bi]![i]!, b.dims.lengthM, b.dims.widthM)) continue;
        onBuilding.add(b.id);
        reasons.push({ kind: "building", id: b.id });
        if (firstOnly) return { ent, reasons };
      }
    }
    return { ent, reasons };
  };
  /** No speed works: the refusal, from what stops the middle speed. */
  const refusal = (mid: Evaluated): SimulationOutcome => {
    const msgs = mid.reasons.map((r) => reasonMessage(r, allIds));
    if (unsureIdx.length === 0) return { ok: false, errors: msgs };
    const first = msgs[0]!;
    return { ok: false, errors: [{ code: "no-workable-speed", text: `At no speed in the range entered would the crash work. ${first.text}`, vehicleIds: first.vehicleIds }, ...msgs.slice(1)] };
  };

  // ---- full runs (impact and slide) for one scanned speed
  const runAt = (k: number): BodyRun[] => {
    const { before, specs, approach } = impactInput(bodies, contacts, enteredAt(k), mu);
    const state = resolveContacts(before, specs, RESTITUTION, IMPACT_PASSES, CONTACT_FRICTION);
    const cuts = bodies.map((b, i) => {
      const radiusOfGyration = Math.sqrt(b.dims.inertiaKgM2 / b.dims.massKg);
      const slide = slideToRest(
        { positionM: b.centre, velocityMps: state[i]!.velocityMps, headingRad: b.headingRad, spinRadPs: state[i]!.spinRadPs },
        mu, DT_S, (mu * G_MPS2) / radiusOfGyration,
      );
      return stopAtWalls(slide.samples, b.dims.lengthM, b.dims.widthM, hits);
    });
    const apart = stopAtVehicles(cuts.map((c) => c.post), bodies.map((b) => ({ L: b.dims.lengthM, W: b.dims.widthM })));
    return bodies.map((_, i) => ({
      vImpact: approach[i]!.vImpactMps, dApproach: approach[i]!.distanceM, post: apart.posts[i]!, stoppedAtWall: cuts[i]!.stopped, stoppedBy: apart.stoppedBy[i]!,
      deltaV: Math.hypot(state[i]!.velocityMps.x - before[i]!.velocityMps.x, state[i]!.velocityMps.y - before[i]!.velocityMps.y),
      spinAfter: state[i]!.spinRadPs,
    }));
  };
  /** Every track is the approach, the slide of the vehicle that slides longest, and two samples at rest. */
  const trackSamples = (run: readonly BodyRun[]): number => i0 + Math.max(...run.map((r) => r.post.length - 1)) + 3;

  if (drawsOnly) {
    // The picture's speed is the middle one if it works, else the nearest that does (the lower on a tie): scan outward and stop there.
    const mid = evaluate(midK);
    let pic = mid.reasons.length === 0 ? midK : -1;
    for (let d = 1; pic < 0 && d <= nK; d++) {
      for (const k of [midK - d, midK + d]) {
        if (k >= 0 && k <= nK && evaluate(k, true).reasons.length === 0) { pic = k; break; }
      }
    }
    if (pic < 0) return refusal(mid);
    const run = runAt(pic);
    if (meter) meter.units += run.reduce((sum, r) => sum + r.post.length, 0);
    if (trackTooLong(trackSamples(run))) return { ok: false, errors: [tooLongMessage(allIds)] };
    return { ok: true };
  }

  const scanned = Array.from({ length: nK + 1 }, (_, k) => evaluate(k));
  const good = scanned.map((e, k) => (e.reasons.length === 0 ? k : -1)).filter((k) => k >= 0);
  if (good.length === 0) return refusal(scanned[midK]!);
  // What the numbers shown cover: the contiguous run of working speeds that holds the picture speed.
  const { picK, lowK, highK, excluded } = selectRange(good, midK);

  const picRun = runAt(picK);
  const runsFor = [lowK === picK ? picRun : runAt(lowK), picRun, highK === picK ? picRun : runAt(highK)];
  const restOf = (run: BodyRun[], bi: number): Vec2 => run[bi]!.post[run[bi]!.post.length - 1]!.positionM;

  // ---- the picture's tracks
  const total = trackSamples(picRun); // two samples at rest after the last vehicle stops
  if (trackTooLong(total)) return { ok: false, errors: [tooLongMessage(allIds)] };
  const startTimeS = -APPROACH_S;
  const apPic = approachesAt(scanned[picK]!.ent);
  const pres = bodies.map((b, bi) => preTrack(b, apPic[bi]!));
  const tracks: Pose[][] = bodies.map((_, bi) => {
    const track = [...pres[bi]!];
    const post = picRun[bi]!.post;
    for (let k = 1; i0 + k < total; k++) {
      const s = post[Math.min(k, post.length - 1)]!;
      track.push({ xM: s.positionM.x, yM: s.positionM.y, headingRad: wrap2Pi(s.headingRad), speedMps: Math.hypot(s.velocityMps.x, s.velocityMps.y) });
    }
    return track;
  });

  // ---- warnings: what doesn't fit, never blocking
  const warnings: PlainMessage[] = [...checkScene(scene, roads)];
  if (roads) {
    const offRoad = offRoadTester(roads);
    // The road data covers a square of half-size radiusM; beyond (nearly) its edge there is no data, and no data is not off-road.
    const extent = roads.radiusM - MAP_EDGE_MARGIN_M;
    bodies.forEach((b, bi) => {
      if (b.guide.fallback) {
        warnings.push({ code: "path-not-on-road", text: `${letterName(b.id)}'s direction doesn't line up with a road near the pin, so its path is drawn straight.`, vehicleIds: [b.id] });
      }
      // Samples past the start of the street (the path is drawn straight there) are told apart from samples on the street's own path.
      const aBrakeB = b.veh.braking && b.guide.moving ? brakeDecel(mu) : 0;
      const sStart = centrePath(b).sFoot;
      let onPath = false, past = false;
      pres[bi]!.forEach((p, i) => {
        if (i % 6 !== 0 || Math.abs(p.xM) > extent || Math.abs(p.yM) > extent || !offRoad(p, b.dims.lengthM, b.dims.widthM)) return;
        const extrapolated = b.guide.moving && !b.guide.fallback && approachBack(apPic[bi]!.vImpactMps, aBrakeB, (i0 - i) * DT_S).s > sStart + 1e-6;
        if (extrapolated) past = true; else onPath = true;
      });
      if (onPath) {
        warnings.push({ code: "off-road", text: `${letterName(b.id)} would have been off the road and any parking lot before the crash. Check its direction and lane. The picture draws it anyway.`, vehicleIds: [b.id] });
      }
      if (past) {
        warnings.push({ code: "path-past-street-end", text: `${letterName(b.id)}'s path runs past where its street ends, so part of it is drawn straight.`, vehicleIds: [b.id] });
      }
    });
  }
  // A warning never blocks: where the entered zone could not touch, the nearest zone that does was used, and this says which.
  for (const u of zonesUsed) {
    warnings.push({
      code: "zone-used",
      text: `${letterName(u.id)} is marked hit on the ${ZONE_WORDS[u.entered]}, but that did not fit with the way each vehicle was going, so the picture uses the ${ZONE_WORDS[u.used]} instead.`,
      vehicleIds: [u.id],
    });
  }
  bodies.forEach((b, bi) => {
    if (picRun[bi]!.stoppedAtWall) {
      warnings.push({ code: "stopped-at-building", text: `${letterName(b.id)} would have slid into a building after the crash. The picture stops it at the wall.`, vehicleIds: [b.id] });
    }
  });
  bodies.forEach((b, bi) => {
    const by = picRun[bi]!.stoppedBy;
    if (by !== null) {
      warnings.push({ code: "stopped-at-vehicle", text: `${letterName(b.id)} would have slid into ${vehicleWord(bodies[by]!.id)} after the crash. The picture stops it where they touch.`, vehicleIds: [b.id, bodies[by]!.id] });
    }
  });
  let rangeNote: RangeNote | null = null;
  if (unsureIdx.length) {
    const firstUnsure = bodies[unsureIdx[0]!]!.id;
    const isUnsure = (id: PlacedBody["id"]) => unsureIdx.some((i) => bodies[i]!.id === id);
    const enteredOf = (k: number, id: PlacedBody["id"]) => scanned[k]!.ent[bodies.findIndex((b) => b.id === id)]!;
    interface Cause { readonly cause: PlacedBody["id"]; readonly other: PlacedBody["id"]; readonly kind: CutKind }
    /** Who makes the cut: the "not sure" vehicle whose path hits the wall, passes through the other, or can't reach it. */
    const causeOf = (r: Reason): Cause => {
      const order = (x: PlacedBody["id"], y: PlacedBody["id"]): [PlacedBody["id"], PlacedBody["id"]] => (isUnsure(x) || !isUnsure(y) ? [x, y] : [y, x]);
      if (r.kind === "building") return { cause: r.id, other: r.id, kind: "building" };
      if (r.kind === "pass") { const [c, o] = order(r.a, r.b); return { cause: c, other: o, kind: "pass" }; }
      if (r.f.kind === "none-moving") return { cause: firstUnsure, other: firstUnsure, kind: "closing" };
      const [c, o] = r.f.kind === "apart" ? order(r.f.a, r.f.b) : order(r.f.mover, r.f.other);
      return { cause: c, other: o, kind: "closing" };
    };
    const speedAt = (k: number, c: Cause): string => formatSpeedExact(enteredOf(k, isUnsure(c.cause) ? c.cause : firstUnsure));
    const ids = (c: Cause) => [c.cause, c.other].filter((x, i, a) => a.indexOf(x) === i);
    // The start and end sentences say every speed beyond the cut fails, so they are only written when that is true;
    // when other speeds beyond the cut work, the gap warning below says so instead.
    if (lowK > 0 && !excluded.some((k) => k < lowK)) {
      const c = causeOf(scanned[lowK - 1]!.reasons[0]!);
      warnings.push({ code: "range-start", text: cutSentence("start", c.kind, c.cause, c.other, speedAt(lowK - 1, c), speedAt(lowK, c)), vehicleIds: ids(c) });
    }
    if (highK < nK && !excluded.some((k) => k > highK)) {
      const c = causeOf(scanned[highK + 1]!.reasons[0]!);
      warnings.push({ code: "range-end", text: cutSentence("end", c.kind, c.cause, c.other, speedAt(highK + 1, c), speedAt(highK, c)), vehicleIds: ids(c) });
    }
    if (picK !== midK) {
      const c = causeOf(scanned[midK]!.reasons[0]!);
      warnings.push({
        code: "picture-speed",
        text: `${letterName(c.cause)}'s middle speed (${speedAt(midK, c)}) doesn't work here, so the picture uses ${speedAt(picK, c)}, the nearest speed that does.`,
        vehicleIds: ids(c),
      });
    }
    if (excluded.length) {
      // One entry per separate run of working speeds that is left out; never one span that takes in failing or shown speeds.
      const runs = excludedRuns(excluded).map(([a, b]) => (a === b ? formatSpeedExact(enteredOf(a, firstUnsure)) : `${formatMphNumber(enteredOf(a, firstUnsure))} to ${formatSpeedExact(enteredOf(b, firstUnsure))}`));
      warnings.push({ code: "range-gap", text: gapSentence(firstUnsure, runs), vehicleIds: [firstUnsure] });
    }
    rangeNote = {
      vehicle: firstUnsure, lo: formatSpeedExact(enteredOf(lowK, firstUnsure)), hi: formatSpeedExact(enteredOf(highK, firstUnsure)),
      picture: formatSpeedExact(enteredOf(picK, firstUnsure)), narrowed: lowK > 0 || highK < nK || excluded.length > 0, moved: picK !== midK, several: unsureIdx.length > 1,
      excluded: excluded.length > 0,
    };
  }

  // ---- results
  const restTimeS = startTimeS + (total - 1) * DT_S;
  /** What the hit did to one vehicle: the first contact it is in (letter order), seen from that vehicle. */
  const pickSpecs = impactInput(bodies, contacts, scanned[picK]!.ent, mu).specs;
  const impactOf = (b: PlacedBody, bi: number): ImpactData | null => {
    const spec = pickSpecs.find((c) => c.ia === bi || c.ib === bi);
    if (!spec) return null;
    const sign = spec.ia === bi ? 1 : -1;
    return {
      deltaVMps: rangeOf(runsFor.map((r) => r[bi]!.deltaV), 1),
      contactPointM: spec.pointM,
      normal: { x: sign * spec.normal.x, y: sign * spec.normal.y },
      // The math frame counts counter-clockwise; the result counts like the compass headings, clockwise.
      spinRadps: rangeOf(runsFor.map((r) => -r[bi]!.spinAfter + 0), 1),
      zoneHit: b.veh.zone,
      leadingZone: zoneNearest(spec.pointM, b.centre, b.headingRad, b.dims.lengthM, b.dims.widthM),
    };
  };
  const vehicles: VehicleResult[] = bodies.map((b, bi) => {
    const rest: Pose = { ...tracks[bi]![total - 1]!, speedMps: 0 };
    return {
      id: b.id,
      type: b.veh.type,
      massKg: b.dims.massKg,
      lengthM: b.dims.lengthM,
      widthM: b.dims.widthM,
      inertiaKgM2: b.dims.inertiaKgM2,
      path: b.guide.moving ? { roadId: b.guide.roadId, laneIndex: b.guide.laneIndex, points: b.guide.poly.pts } : null,
      speedAtImpactMps: rangeOf(runsFor.map((r) => r[bi]!.vImpact), 1),
      approachDistanceM: rangeOf(runsFor.map((r) => r[bi]!.dApproach), 1),
      postImpactDistanceM: rangeOf(runsFor.map((r) => dist(b.centre, restOf(r, bi))), 1),
      impactPose: tracks[bi]![i0]!,
      restPose: rest,
      track: tracks[bi]!,
      ...(impactOf(b, bi) ? { impact: impactOf(b, bi)! } : {}),
    };
  });

  /**
   * Gaps list ONLY the pairs of vehicles that actually touched at impact (the contacts the placement made and
   * the impulses were resolved on at t = 0), never every pair: two vehicles give exactly one entry, a chain
   * A-B-C gives A-B and B-C but not A-C. `restGapM` is the centre-to-centre distance at final rest, as the
   * min / picture / max over the workable speeds (each run's rest respects building walls).
   */
  const seen = new Set<string>();
  const gaps = contacts
    .map((c) => sortedPair(c) as [typeof c.a, typeof c.b])
    .filter(([a, b]) => { const k = `${a}${b}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((x, y) => x[0].localeCompare(y[0]) || x[1].localeCompare(y[1]))
    .map(([a, b]) => {
      const ia = bodies.findIndex((x) => x.id === a), ib = bodies.findIndex((x) => x.id === b);
      return { a, b, restGapM: rangeOf(runsFor.map((r) => dist(restOf(r, ia), restOf(r, ib))), 1) };
    });

  const result: SimulationResult = {
    physicsVersion: PHYSICS_VERSION,
    dtS: DT_S,
    startTimeS,
    impactTimeS: 0,
    restTimeS,
    frictionCoefficient: mu,
    restitution: RESTITUTION,
    impactPointM,
    vehicles,
    gaps,
    assumptions: buildAssumptions(scene, bodies, mu, rangeNote, vehicles.some((v) => (v.impact?.deltaVMps.mid ?? 0) / MPH_TO_MPS > DAMAGE_DELTA_V_MPH)),
    warnings,
  };
  return { ok: true, result };
}

/** Preset source text for the PDF: the brand font has no "≈", and the chart-reading note is kept as one short clause. */
function plainSource(src: string): string {
  return src.replace("read from chart (±100 lb)", "±100 lb, read from chart").replace(/\s*≈\s*/g, " about ").replace(/\s*—\s*/g, " - ");
}

/** What the "not sure" scan did, for the assumption sentence (so it stays true when the range is narrowed or the picture speed moved). */
interface RangeNote {
  readonly vehicle: PlacedBody["id"];
  readonly lo: string;
  readonly hi: string;
  readonly picture: string;
  readonly narrowed: boolean;
  readonly moved: boolean;
  readonly several: boolean;
  /** Other working speeds exist beyond a stretch of speeds that don't work, and are left out. */
  readonly excluded: boolean;
}

/** Road data stops being trusted this close to the edge of the fetched square, m. */
const MAP_EDGE_MARGIN_M = 10;

/** The dents drawn on the vehicles are mentioned once a hit changes some vehicle's speed by more than this, mph. */
const DAMAGE_DELTA_V_MPH = 3;

function buildAssumptions(scene: Scene, bodies: readonly PlacedBody[], mu: number, range: RangeNote | null, damageShown: boolean): Assumption[] {
  const out: Assumption[] = [];
  const cond = scene.road.condition;
  out.push({
    id: "friction",
    text: `Road ${ROAD_WORDS[cond]}, as entered: friction ${mu} for the whole road (dry ${FRICTION.dry} · wet ${FRICTION.wet} · snow ${FRICTION.snow} · ice ${FRICTION.ice}).`,
    value: mu,
  });
  out.push({ id: "flat-ground", text: "The road surface is flat. The terrain shown is for looks only and does not change the motion." });
  out.push({ id: "rigid-bodies", text: "For the motion, vehicles are rigid bodies of typical weight for their type that don't tip over or break apart." });
  if (damageShown) {
    out.push({ id: "damage-illustrated", text: "The dents show roughly where and how hard each vehicle was hit. They are drawn for illustration only and don't change the motion." });
  }
  out.push({ id: "inertia", text: "Each vehicle's resistance to spinning is that of a uniform rectangular box the size of its type: mass × (length² + width²) ÷ 12." });
  for (const b of bodies) {
    const p = PRESETS[b.veh.type];
    const basis = p.mass.basis ?? "a class average";
    const kind = p.label === "SUV" ? p.label : p.label.toLowerCase();
    const source = p.mass.unsourced ? "" : ` Source: ${plainSource(p.mass.source)}.`;
    out.push({
      id: `mass-${b.id}`,
      text: `${letterName(b.id)} is treated as a typical ${kind} of ${formatMassKg(p.mass.value)} (${formatMassLb(p.mass.value)}), ${basis}.${source}`,
      value: p.mass.value, unit: "kg",
      ...(p.mass.unsourced ? {} : { source: plainSource(p.mass.source) }),
    });
  }
  out.push({
    id: "entered-speed",
    text: `Speed at impact, as entered, and directions as entered. The picture works backwards from the impact for the ${APPROACH_S} seconds before it.`,
    value: APPROACH_S, unit: "s",
  });
  out.push({ id: "no-braking-default", text: `No braking or steering unless entered: a vehicle not marked as braking keeps the same speed for the whole ${APPROACH_S} seconds.` });
  const aBrake = brakeDecel(mu);
  if (bodies.some((b) => b.veh.braking && b.guide.moving)) {
    out.push({
      id: "braking-deceleration",
      text: `A vehicle marked as braking slows down into the crash over the last ${BRAKING_S} seconds, at ${BRAKE_FACTOR} × the road friction × gravity, ${formatAcceleration(aBrake)}. It is never shown stopping before the crash.`,
      value: aBrake, unit: "m/s²",
    });
  }
  out.push({
    id: "restitution",
    text: `Simplified collision: the vehicles push apart along the line of the hit with a restitution of ${RESTITUTION}, and grip each other where they touch with a friction of ${CONTACT_FRICTION}, which can slow a vehicle hit on its side and turn both vehicles. Total momentum is conserved.`,
    value: RESTITUTION,
  });
  if (bodies.length > 2) {
    out.push({
      id: "multi-impact",
      text: `With ${bodies.length} vehicles, each touching pair is resolved one at a time at the same instant, in letter order, ${IMPACT_PASSES} passes. There are no later collisions.`,
      value: IMPACT_PASSES,
    });
  }
  out.push({
    id: "yaw",
    text: "A push that lands away from a vehicle's middle, or the vehicles dragging on each other where they touch, starts it spinning. The spin slows at a steady rate set by the road friction and the vehicle's size, and the vehicle turns as it spins while it slides the way the hit sent it.",
  });
  out.push({
    id: "post-impact-slide",
    text: `After the impact each vehicle is treated as skidding: it moves in the direction the hit sent it, slowing at the road friction × gravity (${formatAcceleration(mu * G_MPS2, { both: false })}) until it stops, even where a vehicle rolling free would slow less. Any spin slows at a steady rate set by the road friction and the vehicle's size, and can carry on briefly after it stops sliding. There are no later collisions: a vehicle that would slide into another stops where they touch.`,
    value: mu * G_MPS2, unit: "m/s²",
  });
  out.push({
    id: "time-step",
    text: `The motion is worked out in fixed steps of 1/${Math.round(1 / DT_S)} s, so the same inputs always give the same picture.`,
    value: DT_S, unit: "s",
  });
  const cases = bodies.map((b) => speedCases(b.veh));
  if (cases.some((c) => c.unsure)) {
    const limit = cases.some((c) => c.unsure && c.limitAssumed) ? ` (around ${DEFAULT_LIMIT_MPH} mph, a typical city limit, if it isn't known)` : "";
    const picture = range?.moved ? `, and the picture uses ${range.picture}` : "";
    const others = range?.several ? ' The other "not sure" speeds move with it.' : "";
    const narrowed = range && (range.narrowed || range.moved)
      ? range.excluded
        ? ` Here the crash works for ${vehicleWord(range.vehicle)} at ${range.lo} to ${range.hi}, and that is what the numbers shown cover; other speeds that work are left out${picture}.${others}`
        : ` Here the crash only works for ${vehicleWord(range.vehicle)} at ${range.lo} to ${range.hi}, so the numbers shown cover that${picture}.${others}`
      : "";
    out.push({
      id: "speed-range",
      text: `Where a speed is "not sure", the picture uses the posted limit${limit}, and the numbers shown run from ${RANGE_HALF_MPH} mph below to ${RANGE_HALF_MPH} mph above it.${narrowed}`,
      value: RANGE_HALF_MPH, unit: "mph",
    });
  }
  if (bodies.some((b) => b.veh.action === "turn-left")) {
    out.push({ id: "turn-radius-left", text: `A vehicle turning left follows a circular arc with a radius of ${TURN_RADIUS_LEFT_M} m.`, value: TURN_RADIUS_LEFT_M, unit: "m" });
  }
  if (bodies.some((b) => b.veh.action === "turn-right")) {
    out.push({ id: "turn-radius-right", text: `A vehicle turning right follows a circular arc with a radius of ${TURN_RADIUS_RIGHT_M} m.`, value: TURN_RADIUS_RIGHT_M, unit: "m" });
  }
  return out;
}

/** Pose of one vehicle at time t (s; 0 = impact), interpolated from its track and held at the ends. */
export function poseAt(sim: SimulationResult, vehicle: VehicleResult, tS: number): Pose {
  const tr = vehicle.track;
  const last = tr.length - 1;
  const f = (tS - sim.startTimeS) / sim.dtS;
  if (last < 1 || !(f > 0)) return tr[0]!;
  if (f >= last) return tr[last]!;
  const i = Math.floor(f), u = f - i;
  const a = tr[i]!, b = tr[i + 1]!;
  if (u === 0) return a;
  return {
    xM: a.xM + (b.xM - a.xM) * u,
    yM: a.yM + (b.yM - a.yM) * u,
    headingRad: wrap2Pi(a.headingRad + wrapPi(b.headingRad - a.headingRad) * u),
    speedMps: a.speedMps + (b.speedMps - a.speedMps) * u,
  };
}
