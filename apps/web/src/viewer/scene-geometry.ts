// Builds three.js geometry from the RoadNetwork. Pure functions of data in,
// BufferGeometry out; colors are applied by the components from tokens.
// The road shapes themselves (ribbons, medians, paint, stalls) come from @csd/core's road art, which the
// PDF and PNG diagram share; this file only drapes them on the ground mesh.
import { BufferAttribute, BufferGeometry, ExtrudeGeometry, Float32BufferAttribute, Shape, ShapeUtils, Vector2 } from "three";
import { densify, offsetPolyline, type Building, type PaintLine, type ParkingArea, type Ribbon, type TerrainGrid, type Vec2 } from "@csd/core";
import { heightAt } from "./math";

export { offsetPolyline };

/**
 * Heights above the ground surface. Roads, lots and paint are sampled from the ground MESH (not the smooth
 * terrain grid) and sit on top of it by these amounts, so the coarse ground triangles can't poke through them.
 */
export const LIFT = { lot: 0.06, road: 0.09, paint: 0.14, path: 0.28, ring: 0.24 } as const;

/**
 * Draw order of the ground layers. They are drawn first, in this order, with no depth test and no depth write, so
 * a ground triangle can never hide a road, a road never hides its paint, and a lot never covers an aisle, however
 * the terrain kinks; vehicles, buildings and lines (render order 0) always draw over all of it.
 */
export const LAYER = { ground: -4, lot: -3, road: -2, paint: -1 } as const;

/** The ground mesh and its exact height at any point: what is drawn is what roads and paint are sampled from. */
export interface GroundSurface {
  readonly geometry: BufferGeometry;
  /** Height of the ground triangle under p (clamped to the mesh edge). */
  heightAt(p: Vec2): number;
}

/** Largest number of cells along one side of the ground mesh. */
const MAX_GROUND_SEGMENTS = 512;
/** The ground mesh is at least this fine, however coarse the terrain data: it samples the data smoothly, so a steep embankment has no big kinks for a road to cut through. */
const GROUND_CELL_M = 2.5;

/**
 * A ground mesh following the terrain grid (or flat), size × size meters centered on the origin. Cells are at most
 * GROUND_CELL_M, and never coarser than the terrain data. Each cell is two triangles split along the
 * south-west to north-east diagonal; `heightAt` interpolates in the same triangles.
 */
export function groundSurface(terrain: TerrainGrid | null, sizeM: number): GroundSurface {
  const seg = terrain ? Math.min(MAX_GROUND_SEGMENTS, Math.max(1, Math.ceil(sizeM / Math.min(terrain.cellM, GROUND_CELL_M)))) : 1;
  const cell = sizeM / seg, half = sizeM / 2, n = seg + 1;
  const h = new Float32Array(n * n);                       // h[iy * n + ix], iy counts north
  const pos = new Float32Array(n * n * 3);
  for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++) {
    const x = -half + ix * cell, north = -half + iy * cell;
    const y = terrainHeight(terrain, { x, y: north });
    h[iy * n + ix] = y;
    pos.set([x, y, -north], (iy * n + ix) * 3);
  }
  const idx = new Uint32Array(seg * seg * 6);
  let k = 0;
  for (let iy = 0; iy < seg; iy++) for (let ix = 0; ix < seg; ix++) {
    const v00 = iy * n + ix, v10 = v00 + 1, v01 = v00 + n, v11 = v01 + 1;
    idx.set([v00, v10, v11, v00, v11, v01], k); k += 6;
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(pos, 3));
  geometry.setIndex(new BufferAttribute(idx, 1));
  geometry.computeVertexNormals();
  const heightOnMesh = (p: Vec2): number => {
    const gx = Math.min(seg - 1e-9, Math.max(0, (p.x + half) / cell)), gy = Math.min(seg - 1e-9, Math.max(0, (p.y + half) / cell));
    const ix = Math.floor(gx), iy = Math.floor(gy), u = gx - ix, v = gy - iy;
    const h00 = h[iy * n + ix]!, h10 = h[iy * n + ix + 1]!, h01 = h[(iy + 1) * n + ix]!, h11 = h[(iy + 1) * n + ix + 1]!;
    return u >= v ? h00 + u * (h10 - h00) + v * (h11 - h10) : h00 + u * (h11 - h01) + v * (h01 - h00);
  };
  return { geometry, heightAt: heightOnMesh };
}

/** Terrain height with the edge heights carried outward, so the ground doesn't drop to 0 just past the data (math.heightAt does that, for the vehicles). */
function terrainHeight(terrain: TerrainGrid | null, p: Vec2): number {
  if (!terrain) return 0;
  const x = Math.min(terrain.originM.x + (terrain.cols - 1) * terrain.cellM, Math.max(terrain.originM.x, p.x));
  const y = Math.min(terrain.originM.y + (terrain.rows - 1) * terrain.cellM, Math.max(terrain.originM.y, p.y));
  return heightAt(terrain, { x, y });
}

const vertexList = (pts: readonly Vec2[], ground: GroundSurface, lift: number): number[] => pts.flatMap((p) => [p.x, ground.heightAt(p) + lift, -p.y]);

/** Every road ribbon in one mesh, draped on the ground mesh: a strip per road, with a vertex row across it every ~2.5 m so a cross slope can't bury its middle. */
export function ribbonsGeometry(ribbons: readonly Ribbon[], ground: GroundSurface): BufferGeometry {
  const verts: number[] = [], idx: number[] = [];
  for (const r of ribbons) {
    const widest = Math.max(...r.left.map((l, i) => l + r.right[i]!));
    const m = Math.max(1, Math.ceil(widest / 2.5));
    const base = verts.length / 3;
    for (let i = 0; i < r.line.length; i++) {
      const l = r.leftEdge[i]!, rt = r.rightEdge[i]!;
      const row = Array.from({ length: m + 1 }, (_, k): Vec2 => ({ x: l.x + ((rt.x - l.x) * k) / m, y: l.y + ((rt.y - l.y) * k) / m }));
      verts.push(...vertexList(row, ground, LIFT.road));
    }
    const w = m + 1;
    for (let i = 0; i + 1 < r.line.length; i++) for (let k = 0; k < m; k++) {
      const a = base + i * w + k, b = a + 1, c = a + w, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(verts, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** The longest edge, in meters, left in a lot surface before it is split to follow the ground. */
const LOT_EDGE_M = 5;
const MAX_LOT_TRIANGLES = 80_000;

/**
 * All parking lots in one mesh: each outline triangulated, then its long edges split in two (both neighbours
 * of an edge are split together, so there are no cracks) until every edge is short enough to follow the ground.
 */
export function lotsGeometry(lots: readonly ParkingArea[], ground: GroundSurface): BufferGeometry {
  const pts: Vec2[] = [];
  let tris: number[] = [];
  for (const lot of lots) {
    if (lot.outline.length < 3) continue;
    const base = pts.length;
    pts.push(...lot.outline);
    for (const t of ShapeUtils.triangulateShape(lot.outline.map((p) => new Vector2(p.x, p.y)), [])) tris.push(base + t[0]!, base + t[1]!, base + t[2]!);
  }
  const len = (a: number, b: number) => Math.hypot(pts[a]!.x - pts[b]!.x, pts[a]!.y - pts[b]!.y);
  const key = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  for (let pass = 0; pass < 9; pass++) {
    const mid = new Map<string, number>();
    for (let i = 0; i < tris.length; i += 3) for (let e = 0; e < 3; e++) {
      const a = tris[i + e]!, b = tris[i + ((e + 1) % 3)]!;
      if (len(a, b) > LOT_EDGE_M && !mid.has(key(a, b))) { mid.set(key(a, b), pts.length); pts.push({ x: (pts[a]!.x + pts[b]!.x) / 2, y: (pts[a]!.y + pts[b]!.y) / 2 }); }
    }
    if (mid.size === 0 || tris.length / 3 > MAX_LOT_TRIANGLES) break;
    const next: number[] = [];
    for (let i = 0; i < tris.length; i += 3) {
      const v = [tris[i]!, tris[i + 1]!, tris[i + 2]!];
      const m = [mid.get(key(v[0]!, v[1]!)), mid.get(key(v[1]!, v[2]!)), mid.get(key(v[2]!, v[0]!))];
      const cut = [0, 1, 2].filter((e) => m[e] !== undefined);
      if (cut.length === 0) next.push(...v);
      else if (cut.length === 3) next.push(v[0]!, m[0]!, m[2]!, m[0]!, v[1]!, m[1]!, m[2]!, m[1]!, v[2]!, m[0]!, m[1]!, m[2]!);
      else if (cut.length === 1) {
        const e = cut[0]!, a = v[e]!, b = v[(e + 1) % 3]!, c = v[(e + 2) % 3]!, x = m[e]!;
        next.push(a, x, c, x, b, c);
      } else {
        // Two cut edges meet at one corner: split that corner off, then halve what is left.
        const corner = [0, 1, 2].find((c) => m[c] !== undefined && m[(c + 2) % 3] !== undefined)!;
        const p0 = v[corner]!, p1 = v[(corner + 1) % 3]!, p2 = v[(corner + 2) % 3]!;
        const a = m[corner]!, b = m[(corner + 2) % 3]!;          // on p0-p1 and on p2-p0
        next.push(p0, a, b, a, p1, p2, a, p2, b);
      }
    }
    tris = next;
  }
  const verts = vertexList(pts, ground, LIFT.lot);
  const out: number[] = [];
  for (let i = 0; i < tris.length; i += 3) {
    const a = pts[tris[i]!]!, b = pts[tris[i + 1]!]!, c = pts[tris[i + 2]!]!;
    const ccw = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) >= 0;
    out.push(tris[i]!, ccw ? tris[i + 1]! : tris[i + 2]!, ccw ? tris[i + 2]! : tris[i + 1]!);
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(verts, 3));
  g.setIndex(out);
  g.computeVertexNormals();
  return g;
}

/** World widths of the painted lines, m. */
export const PAINT_WIDTH_M = { center: 0.18, lane: 0.18, edge: 0.18, stall: 0.12 } as const;
/** Lane lines are dashed this long, with this much road between dashes, m. */
export const DASH_M = { on: 3, off: 6 } as const;
const PAINT_STEP_M = 1.5;

/** Pieces of a polyline that lie on dashes (or the whole line), each a list of points. */
export function dashPieces(points: readonly Vec2[], dashed: boolean): Vec2[][] {
  const pts = densify(points, PAINT_STEP_M);
  if (pts.length < 2) return [];
  if (!dashed) return [pts];
  const out: Vec2[][] = [];
  let cur: Vec2[] = [pts[0]!];
  let on = true, left: number = DASH_M.on;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!, b = pts[i + 1]!, segLen = Math.hypot(b.x - a.x, b.y - a.y);
    let at = 0;
    while (segLen - at > left) {
      at += left;
      const p = { x: a.x + ((b.x - a.x) * at) / segLen, y: a.y + ((b.y - a.y) * at) / segLen };
      if (on) { cur.push(p); out.push(cur); cur = []; } else cur = [p];
      on = !on; left = on ? DASH_M.on : DASH_M.off;
    }
    left -= segLen - at;
    if (on) cur.push(b);
  }
  if (on && cur.length >= 2) out.push(cur);
  return out.filter((p) => p.length >= 2);
}

/** All paint as flat strips draped on the ground: one mesh for lane lines, edge lines, centre lines and stalls. */
export function paintGeometry(paint: readonly PaintLine[], ground: GroundSurface): BufferGeometry {
  const verts: number[] = [], idx: number[] = [];
  for (const line of paint) {
    const hw = PAINT_WIDTH_M[line.kind] / 2;
    for (const piece of dashPieces(line.points, line.dashed)) {
      const left = offsetPolyline(piece, -hw), right = offsetPolyline(piece, hw);
      const base = verts.length / 3;
      for (let i = 0; i < piece.length; i++) {
        verts.push(...vertexList([left[i]!, right[i]!], ground, LIFT.paint));
        if (i > 0) { const a = base + (i - 1) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(verts, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function shapeOf(outline: readonly Vec2[]): Shape {
  // Shape lives in x/y; we map north to +y here and rotate the mesh so +y → −z.
  const s = new Shape();
  outline.forEach((p, i) => (i === 0 ? s.moveTo(p.x, p.y) : s.lineTo(p.x, p.y)));
  return s;
}

/** Building footprint extruded to its height, standing on the lowest terrain point under it. */
export function buildingGeometry(b: Building, terrain: TerrainGrid | null): { geometry: BufferGeometry; baseM: number } {
  const g = new ExtrudeGeometry(shapeOf(b.footprint), { depth: b.heightM, bevelEnabled: false });
  g.rotateX(-Math.PI / 2);                                   // extrude along +y; shape y (north) → −z
  const baseM = Math.min(...b.footprint.map((p) => heightAt(terrain, p)));
  return { geometry: g, baseM };
}

