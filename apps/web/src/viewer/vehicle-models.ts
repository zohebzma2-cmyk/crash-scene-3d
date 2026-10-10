// Low-poly vehicle models for the 3D viewer: car, suv, pickup, van, truck, motorcycle.
// One merged BufferGeometry per material slot and per (type, length, width), built once and cached.
//
// The illustration contract: a vehicle is an oriented box of lengthM x widthM centered on its pose, and
// the physics lets two of those boxes touch with zero overlap. So every visible part of a model (wheels,
// mirrors, bumpers, lights) stays INSIDE that footprint, and the body fills it to within a few centimeters.
// Models face -z (north at heading 0), centered on the origin in plan, wheels resting on y = 0.
//
// Colors are not chosen here. The viewer binds the slots to tokens: body = the vehicle token, glass /
// headlight / taillight / tire = the matching --color-scene-* tokens.
import { BoxGeometry, BufferGeometry, ExtrudeGeometry, Float32BufferAttribute, LatheGeometry, Shape, Vector2 } from "three";

export type VehicleKind = "car" | "suv" | "pickup" | "van" | "truck" | "motorcycle";
export const VEHICLE_KINDS: readonly VehicleKind[] = ["car", "suv", "pickup", "van", "truck", "motorcycle"];

export interface VehicleParts {
  /** Painted body in the vehicle's color. */
  readonly body: BufferGeometry;
  readonly glass: BufferGeometry;
  readonly headlight: BufferGeometry;
  readonly taillight: BufferGeometry;
  /** Tires, and the dark trim (pickup bed, seat). */
  readonly tire: BufferGeometry;
}

export interface VehicleModel {
  readonly kind: VehicleKind;
  readonly lengthM: number;
  readonly widthM: number;
  readonly heightM: number;
  readonly parts: VehicleParts;
  /** Body + glass without wheels or lights: the shape the rest-pose ghost draws. */
  readonly silhouette: BufferGeometry;
  readonly triangles: number;
}

const SLOTS = ["body", "glass", "headlight", "taillight", "tire"] as const;
type Slot = (typeof SLOTS)[number];

/** Gap between the body's nose and the bumper/lights, so their faces never share a plane with the body's. */
const NOSE_M = 0.03;
/** Every model is this much smaller than its footprint on each side: absorbs the few cm of overlap the physics lets two touching boxes have. */
const SKIN_M = 0.02;
/** Wheels sit this far inside the body side. */
const WHEEL_INSET_M = 0.04;
/** How far the mirrors stop short of the footprint edge. */
const MIRROR_INSET_M = 0.01;
const ARCH_PAD_M = 0.07;

type P = readonly [number, number];

function merge(list: readonly BufferGeometry[]): BufferGeometry {
  const parts = list.map((g) => (g.index ? g.toNonIndexed() : g));
  const total = parts.reduce((n, g) => n + g.getAttribute("position").count, 0);
  const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3);
  let at = 0;
  for (const g of parts) {
    const p = g.getAttribute("position"), n = g.getAttribute("normal");
    pos.set(p.array as ArrayLike<number>, at * 3);
    nor.set(n.array as ArrayLike<number>, at * 3);
    at += p.count;
  }
  parts.forEach((g, i) => { if (g !== list[i]) g.dispose(); });
  list.forEach((g) => g.dispose());
  const out = new BufferGeometry();
  out.setAttribute("position", new Float32BufferAttribute(pos, 3));
  out.setAttribute("normal", new Float32BufferAttribute(nor, 3));
  return out;
}

class Builder {
  readonly slots: Record<Slot, BufferGeometry[]> = { body: [], glass: [], headlight: [], taillight: [], tire: [] };
  constructor(readonly L: number, readonly W: number) {}

  /** Z of a point `u` meters behind the front of the vehicle (the model faces -z). */
  z(u: number): number { return u - this.L / 2; }

  /** A side profile in (u meters from the front, h meters up), extruded `w` wide and centered on x = xc. */
  profile(slot: Slot, points: readonly P[], w: number, xc = 0): void {
    const shape = new Shape();
    points.forEach(([u, h], i) => { const x = this.L / 2 - u; if (i === 0) shape.moveTo(x, h); else shape.lineTo(x, h); });
    const g = new ExtrudeGeometry(shape, { depth: w, bevelEnabled: false, steps: 1 });
    g.rotateY(Math.PI / 2);                              // shape x -> -z, extrusion depth -> +x
    g.translate(xc - w / 2, 0, 0);
    this.slots[slot].push(g);
  }

  /** An axis-aligned box: x from x0 to x1, y (up) from h0 to h1, u from u0 to u1 (meters from the front). */
  box(slot: Slot, x0: number, x1: number, h0: number, h1: number, u0: number, u1: number): void {
    const g = new BoxGeometry(x1 - x0, h1 - h0, u1 - u0);
    g.translate((x0 + x1) / 2, (h0 + h1) / 2, this.z((u0 + u1) / 2));
    this.slots[slot].push(g);
  }

  /** A symmetric pair of boxes: x from `xIn` to `xOut` on each side. */
  pair(slot: Slot, xIn: number, xOut: number, h0: number, h1: number, u0: number, u1: number): void {
    this.box(slot, -xOut, -xIn, h0, h1, u0, u1);
    this.box(slot, xIn, xOut, h0, h1, u0, u1);
  }

  /** A tire: a cylinder with rounded edges, axis along x, outer face at |x| = xOuter. */
  wheel(side: -1 | 1, u: number, r: number, w: number, xOuter: number, segments: number): void {
    const hw = w / 2, b = Math.min(0.05, hw * 0.8);
    const profile = [new Vector2(0, -hw), new Vector2(r - b, -hw), new Vector2(r, -hw + b), new Vector2(r, hw - b), new Vector2(r - b, hw), new Vector2(0, hw)];
    const g = new LatheGeometry(profile, segments);
    g.rotateZ(Math.PI / 2);
    g.translate(side * (xOuter - hw), r, this.z(u));
    this.slots.tire.push(g);
  }

  /** Four-corner wheels (or six with a dual rear axle). */
  wheels(axles: ReadonlyArray<{ u: number; r: number; dual?: boolean }>, w: number, segments: number): void {
    const xOuter = this.W / 2 - WHEEL_INSET_M;
    for (const a of axles) for (const side of [-1, 1] as const) {
      this.wheel(side, a.u, a.r, w, xOuter, segments);
      if (a.dual) this.wheel(side, a.u, a.r, w, xOuter - w - 0.02, segments);
    }
  }

  /**
   * The lower body: a side profile with a round arch cut over each wheel, extruded the full width.
   * `top` runs from the nose to the tail; the bottom is a straight line at `clearance`, broken by the arches.
   */
  body(slot: Slot, clearance: number, top: readonly P[], arches: ReadonlyArray<{ u: number; r: number }>, xFrom = NOSE_M, xTo = this.L - NOSE_M): void {
    const pts: P[] = [];
    const bottom = [...arches].sort((a, b) => b.u - a.u);
    pts.push([xTo, clearance]);
    for (const a of bottom) {
      const ra = a.r + ARCH_PAD_M;
      const dy = clearance - a.r;
      if (Math.abs(dy) >= ra) continue;
      const dx = Math.sqrt(ra * ra - dy * dy);
      const t0 = Math.atan2(dy, dx), t1 = Math.PI - t0;
      const n = 6;
      for (let i = 0; i <= n; i++) { const t = t0 + ((t1 - t0) * i) / n; pts.push([a.u + ra * Math.cos(t), a.r + ra * Math.sin(t)]); }
    }
    pts.push([xFrom, clearance]);
    for (const p of top) pts.push(p);
    this.profile(slot, pts, this.W);
  }

  /** Windows, roof, pillars and mirrors for a passenger cabin. */
  cabin(c: { u1: number; u2: number; u3: number; u4: number; belt: number; roof: number; pillars?: boolean; mirrors?: boolean; mirrorU?: number; mirrorH?: number }): void {
    const { u1, u2, u3, u4, belt, roof } = c;
    const wg = this.W * 0.84;                            // glass width; mirrors fill the rest up to the footprint
    const top = roof - 0.07;
    this.profile("glass", [[u1, belt - 0.02], [u2, top], [u3, top], [u4, belt - 0.02]], wg);
    this.profile("body", [[u2 - 0.05, top - 0.02], [u2 + 0.03, roof], [u3 - 0.03, roof], [u3 + 0.05, top - 0.02]], wg + 0.04);
    if (c.pillars !== false) {
      this.profile("body", [[u1 - 0.01, belt - 0.02], [u1 + 0.07, belt - 0.02], [u2 + 0.05, top], [u2 - 0.02, top]], wg + 0.03);
      this.profile("body", [[u4 + 0.01, belt - 0.02], [u4 - 0.07, belt - 0.02], [u3 - 0.05, top], [u3 + 0.02, top]], wg + 0.03);
      const mid = (u2 + u3) / 2;
      this.profile("body", [[mid - 0.045, belt - 0.02], [mid + 0.045, belt - 0.02], [mid + 0.045, top], [mid - 0.045, top]], wg + 0.03);
    }
    if (c.mirrors !== false) {
      const mu = c.mirrorU ?? u1 + 0.16, mh = c.mirrorH ?? belt + 0.12;
      this.pair("body", wg / 2 - 0.02, this.W / 2 - MIRROR_INSET_M, mh, mh + 0.15, mu, mu + 0.2);
    }
  }

  /** Bumpers (the extreme ends of the footprint), headlights and taillights. */
  ends(e: { bumperH: number; bumperTop: number; headH: number; tailH: number; lightH?: number; lightW?: number }): void {
    const w = this.W, lw = e.lightW ?? w * 0.2, lh = e.lightH ?? 0.1;
    const bw = w / 2 - 0.02;
    this.box("body", -bw, bw, e.bumperH, e.bumperTop, 0, 0.2);
    this.box("body", -bw, bw, e.bumperH, e.bumperTop, this.L - 0.2, this.L);
    this.pair("headlight", w * 0.5 - 0.05 - lw, w * 0.5 - 0.05, e.headH, e.headH + lh, 0, 0.07);
    this.pair("taillight", w * 0.5 - 0.05 - lw, w * 0.5 - 0.05, e.tailH, e.tailH + lh, this.L - 0.07, this.L);
  }

  finish(): VehicleParts {
    const out = {} as Record<Slot, BufferGeometry>;
    for (const s of SLOTS) out[s] = merge(this.slots[s]);
    return out;
  }
}

/* ------------------------------ the six vehicles ------------------------------ */

const fr = (L: number, f: number) => f * L;
const tops = (L: number, pts: ReadonlyArray<P>): P[] => pts.map(([f, h]) => [fr(L, f), h]);

function car(L: number, W: number): VehicleParts {
  const b = new Builder(L, W);
  const r = 0.33, c = 0.16, belt = 0.92;
  const front = fr(L, 0.2), rear = fr(L, 0.795);
  b.body("body", c, tops(L, [[0.006, 0.6], [0.035, 0.76], [0.3, 0.87], [0.385, belt], [0.885, belt], [0.965, 0.9], [0.994, 0.78]]), [{ u: front, r }, { u: rear, r }]);
  b.cabin({ u1: fr(L, 0.385), u2: fr(L, 0.555), u3: fr(L, 0.765), u4: fr(L, 0.885), belt, roof: 1.45 });
  b.ends({ bumperH: c + 0.06, bumperTop: c + 0.36, headH: 0.46, tailH: 0.66 });
  b.wheels([{ u: front, r }, { u: rear, r }], 0.22, 12);
  return b.finish();
}

function suv(L: number, W: number): VehicleParts {
  const b = new Builder(L, W);
  const r = 0.37, c = 0.22, belt = 1.08;
  const front = fr(L, 0.2), rear = fr(L, 0.8);
  b.body("body", c, tops(L, [[0.006, 0.78], [0.03, 0.92], [0.25, 0.99], [0.31, belt], [0.95, belt], [0.994, 1.0]]), [{ u: front, r }, { u: rear, r }]);
  b.cabin({ u1: fr(L, 0.31), u2: fr(L, 0.45), u3: fr(L, 0.9), u4: fr(L, 0.97), belt, roof: 1.78 });
  b.ends({ bumperH: c + 0.08, bumperTop: c + 0.42, headH: 0.64, tailH: 0.82 });
  b.wheels([{ u: front, r }, { u: rear, r }], 0.25, 12);
  return b.finish();
}

function pickup(L: number, W: number): VehicleParts {
  const b = new Builder(L, W);
  const r = 0.4, c = 0.26, belt = 1.1, rail = 1.06;
  const front = fr(L, 0.17), rear = fr(L, 0.8);
  b.body("body", c, tops(L, [[0.006, 0.88], [0.03, 1.0], [0.22, 1.04], [0.26, belt], [0.555, belt], [0.56, rail], [0.994, rail]]), [{ u: front, r }, { u: rear, r }]);
  b.cabin({ u1: fr(L, 0.26), u2: fr(L, 0.34), u3: fr(L, 0.475), u4: fr(L, 0.53), belt, roof: 1.82, pillars: false });
  // Two window pillars: A and C, plus a B pillar behind the front door.
  b.profile("body", [[fr(L, 0.395) - 0.045, belt - 0.02], [fr(L, 0.395) + 0.045, belt - 0.02], [fr(L, 0.395) + 0.045, 1.75], [fr(L, 0.395) - 0.045, 1.75]], W * 0.84 + 0.03);
  b.profile("body", [[fr(L, 0.26) - 0.01, belt - 0.02], [fr(L, 0.26) + 0.07, belt - 0.02], [fr(L, 0.34) + 0.05, 1.75], [fr(L, 0.34) - 0.02, 1.75]], W * 0.84 + 0.03);
  b.profile("body", [[fr(L, 0.53) + 0.01, belt - 0.02], [fr(L, 0.53) - 0.07, belt - 0.02], [fr(L, 0.475) - 0.05, 1.75], [fr(L, 0.475) + 0.02, 1.75]], W * 0.84 + 0.03);
  // The bed: a dark liner inside the rails.
  b.box("tire", -(W / 2 - 0.1), W / 2 - 0.1, rail, rail + 0.01, fr(L, 0.58), fr(L, 0.985));
  b.ends({ bumperH: c + 0.08, bumperTop: c + 0.42, headH: 0.7, tailH: 0.9 });
  b.wheels([{ u: front, r }, { u: rear, r }], 0.27, 12);
  return b.finish();
}

function van(L: number, W: number): VehicleParts {
  const b = new Builder(L, W);
  const r = 0.34, c = 0.2, belt = 1.0, roof = 1.98;
  const front = fr(L, 0.17), rear = fr(L, 0.8);
  // Short nose, a tall box behind the windshield.
  b.body("body", c, tops(L, [[0.006, 0.68], [0.03, 0.84], [0.13, 0.95], [0.17, belt], [0.4, belt], [0.4, roof - 0.04], [0.994, roof - 0.04], [0.994, 0.8]]), [{ u: front, r }, { u: rear, r }]);
  b.profile("glass", [[fr(L, 0.17), belt - 0.02], [fr(L, 0.285), roof - 0.1], [fr(L, 0.4), roof - 0.1], [fr(L, 0.4), belt - 0.02]], W * 0.84);
  b.profile("body", [[fr(L, 0.28), roof - 0.12], [fr(L, 0.305), roof], [fr(L, 0.4), roof], [fr(L, 0.4), roof - 0.12]], W * 0.84 + 0.04);
  b.profile("body", [[fr(L, 0.4) - 0.02, roof - 0.04], [fr(L, 0.4) - 0.02, roof], [fr(L, 0.994), roof], [fr(L, 0.994), roof - 0.04]], W);
  b.profile("body", [[fr(L, 0.17) - 0.01, belt - 0.02], [fr(L, 0.17) + 0.07, belt - 0.02], [fr(L, 0.285) + 0.05, roof - 0.1], [fr(L, 0.285) - 0.02, roof - 0.1]], W * 0.84 + 0.03);
  b.pair("body", W * 0.84 / 2 - 0.02, W / 2 - MIRROR_INSET_M, belt + 0.25, belt + 0.45, fr(L, 0.2), fr(L, 0.2) + 0.2);
  b.ends({ bumperH: c + 0.08, bumperTop: c + 0.42, headH: 0.52, tailH: 1.0, lightH: 0.14 });
  b.wheels([{ u: front, r }, { u: rear, r }], 0.24, 12);
  return b.finish();
}

function truck(L: number, W: number): VehicleParts {
  const b = new Builder(L, W);
  const r = 0.5, c = 0.58, belt = 1.45, roof = 3.0, boxTop = 3.55, boxFloor = 0.95;
  const front = 1.35, rear = L - 2.1;
  const cabEnd = fr(L, 0.205), boxFrom = fr(L, 0.225);
  // Cab-over cab; the arches are cut in the cab and in the cargo box.
  b.body("body", c, tops(L, [[0.003, 1.0], [0.003, belt], [cabEnd / L, belt]]), [{ u: front, r }], NOSE_M, cabEnd);
  b.profile("glass", [[fr(L, 0.0075) + 0.03, belt - 0.02], [fr(L, 0.0075) + 0.3, roof - 0.12], [cabEnd - 0.02, roof - 0.12], [cabEnd - 0.02, belt - 0.02]], W * 0.84);
  b.profile("body", [[fr(L, 0.0075) + 0.2, roof - 0.14], [fr(L, 0.0075) + 0.34, roof], [cabEnd, roof], [cabEnd, roof - 0.14]], W * 0.9);
  b.profile("body", [[fr(L, 0.0075) + 0.01, belt - 0.02], [fr(L, 0.0075) + 0.1, belt - 0.02], [fr(L, 0.0075) + 0.36, roof - 0.12], [fr(L, 0.0075) + 0.27, roof - 0.12]], W * 0.84 + 0.03);
  b.pair("body", W * 0.84 / 2 - 0.02, W / 2 - MIRROR_INSET_M, belt + 0.25, belt + 0.85, fr(L, 0.0075) + 0.35, fr(L, 0.0075) + 0.55);
  b.body("body", boxFloor - 0.33, [[boxFrom, boxTop], [L - NOSE_M, boxTop]], [{ u: rear, r }], boxFrom, L - NOSE_M);
  b.profile("body", [[cabEnd, c], [boxFrom + 0.1, c], [boxFrom + 0.1, boxFloor], [cabEnd, boxFloor]], W * 0.7);
  b.ends({ bumperH: c, bumperTop: c + 0.4, headH: 0.8, tailH: 0.75, lightH: 0.16 });
  b.wheels([{ u: front, r }, { u: rear, r, dual: true }], 0.26, 10);
  return b.finish();
}

function motorcycle(L: number, W: number): VehicleParts {
  const b = new Builder(L, W);
  const r = 0.31, tw = 0.15;
  const front = r, rear = L - r;
  const bar = W / 2 - MIRROR_INSET_M;
  // Wheels on the centre line.
  b.wheel(1, front, r, tw, tw / 2, 12);
  b.wheel(1, rear, r, tw, tw / 2, 12);
  // Engine block and frame, tank, tail, front fender.
  b.profile("body", [[front + 0.3, 0.28], [rear - 0.35, 0.28], [rear - 0.3, 0.62], [front + 0.35, 0.62]], 0.3);
  b.profile("body", [[front + 0.2, 0.62], [front + 0.65, 0.62], [front + 0.6, 0.93], [front + 0.3, 0.95]], 0.3);
  b.profile("body", [[rear - 0.55, 0.78], [rear + 0.05, 0.8], [rear + 0.15, 0.7], [rear - 0.5, 0.62]], 0.24);
  b.profile("body", [[front - 0.22, 2 * r + 0.01], [front + 0.22, 2 * r + 0.01], [front + 0.2, 2 * r + 0.08], [front - 0.2, 2 * r + 0.08]], 0.19);
  // Seat (dark), forks, handlebar with grips at the footprint edge.
  b.profile("tire", [[front + 0.7, 0.9], [rear - 0.1, 0.84], [rear - 0.1, 0.78], [front + 0.7, 0.84]], 0.28);
  b.profile("tire", [[front - 0.02, 0.35], [front + 0.04, 0.35], [front + 0.3, 1.1], [front + 0.22, 1.1]], 0.1);
  b.box("tire", -bar, bar, 1.08, 1.13, front + 0.14, front + 0.3);
  b.box("tire", -0.09, 0.09, 0.98, 1.08, front + 0.1, front + 0.3);
  // Headlight and taillight inside the footprint; mirrors at the bar ends.
  b.box("headlight", -0.07, 0.07, 0.8, 0.95, front + 0.2, front + 0.28);
  b.box("taillight", -0.06, 0.06, 0.72, 0.82, L - 0.12, L);
  b.pair("body", bar - 0.14, bar, 1.14, 1.2, front + 0.1, front + 0.2);
  return b.finish();
}

const BUILDERS: Readonly<Record<VehicleKind, (L: number, W: number) => VehicleParts>> = { car, suv, pickup, van, truck, motorcycle };

/* ------------------------------ cache ------------------------------ */

const cache = new Map<string, VehicleModel>();

export const isVehicleKind = (t: string): t is VehicleKind => (VEHICLE_KINDS as readonly string[]).includes(t);

function trianglesOf(g: BufferGeometry): number {
  return (g.index ? g.index.count : g.getAttribute("position").count) / 3;
}

/** The model for a vehicle type at the simulation's length and width (unknown types draw as a car). Built once, cached. */
export function vehicleModel(type: string, lengthM: number, widthM: number): VehicleModel {
  const kind: VehicleKind = isVehicleKind(type) ? type : "car";
  const key = `${kind}|${lengthM.toFixed(3)}|${widthM.toFixed(3)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const parts = BUILDERS[kind](lengthM - 2 * SKIN_M, widthM - 2 * SKIN_M);
  const silhouette = merge([parts.body.clone(), parts.glass.clone()]);
  const all = merge(SLOTS.map((s) => parts[s].clone()));
  all.computeBoundingBox();
  const heightM = all.boundingBox?.max.y ?? 1.5;
  const triangles = SLOTS.reduce((n, s) => n + trianglesOf(parts[s]), 0);
  all.dispose();
  const model: VehicleModel = { kind, lengthM, widthM, heightM, parts, silhouette, triangles };
  cache.set(key, model);
  return model;
}

/** Free every cached geometry (the viewer calls this on unmount). A later call rebuilds what it needs. */
export function disposeVehicleModels(): void {
  for (const m of cache.values()) {
    for (const s of SLOTS) m.parts[s].dispose();
    m.silhouette.dispose();
  }
  cache.clear();
}

/** All the model's parts merged, for measuring (plan bounds, triangles). The caller disposes it. */
export function mergedModel(model: VehicleModel): BufferGeometry {
  return merge(SLOTS.map((s) => model.parts[s].clone()));
}
