// What the visibility sweep measures in the page, for every vehicle, from the LIVE scene graph and camera the viewer
// is drawing with (window.__csdViewer.three(), a read-only hook that only fixtures/dev builds install).
//
// probeInPage runs inside the browser (page.evaluate), so it is self-contained: no imports, no outside helpers.
// pixelsInPage measures what actually reaches the screen: the canvas with and without one vehicle (hook.hide).

export interface VehicleProbe {
  readonly id: string;
  /** The vehicle's group is in the scene graph, attached to the scene, visible all the way up, scaled, with drawable meshes. */
  readonly exists: boolean;
  readonly drawable: boolean;
  readonly notDrawableWhy: string;
  /** Nearest box corner's depth in front of the camera, m, and the camera's near plane. */
  readonly minDepthM: number;
  readonly maxDepthM: number;
  readonly near: number;
  /** Share of the projected box (convex hull of its 8 corners) inside the canvas, and its projected area, px². */
  readonly inFrameShare: number;
  readonly areaPx: number;
  /** Projected hull, canvas px. */
  readonly hull: ReadonlyArray<readonly [number, number]>;
  /** How far the body's bottom is below the drawn ground mesh: at the center, and the worst corner (m; negative = above). */
  readonly sinkCenterM: number;
  readonly sinkCornerM: number;
  /** Share of sample points on the body whose line of sight to the camera crosses a building, and which buildings. */
  readonly occludedShare: number;
  readonly occluders: readonly string[];
  /** Share of the on-canvas part of the body under page UI (chips, HUD, caption, labels, tips, sticky bars), and by what. */
  readonly uiShare: number;
  readonly uiBy: Readonly<Record<string, number>>;
  /** Share of the on-canvas part of the body outside the browser window (scrolled off). */
  readonly offPageShare: number;
}

export interface ProbeResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly canvas: { readonly w: number; readonly h: number; readonly top: number; readonly left: number };
  readonly camera: { readonly ortho: boolean; readonly near: number; readonly far: number; readonly position: readonly number[] };
  readonly vehicles: readonly VehicleProbe[];
}

/* eslint-disable @typescript-eslint/no-explicit-any -- the page side reads three.js objects untyped (no three import in e2e) */
export function probeInPage(ids: readonly string[]): ProbeResult {
  const w = window as any;
  const t = w.__csdViewer?.three?.();
  const canvasEl = document.querySelector<HTMLCanvasElement>(".viewer3d canvas");
  if (!t || !canvasEl) return { ok: false, error: "no viewer hook or canvas", canvas: { w: 0, h: 0, top: 0, left: 0 }, camera: { ortho: false, near: 0, far: 0, position: [] }, vehicles: [] };
  const { scene, camera, size, groups } = t;
  const W: number = size.width, H: number = size.height;
  const cr = canvasEl.getBoundingClientRect();
  const V3 = camera.position.constructor;
  const ortho = camera.isOrthographicCamera === true;
  const me = camera.matrixWorld.elements as number[];
  const eye = [me[12]!, me[13]!, me[14]!];
  const fwd = [-me[8]!, -me[9]!, -me[10]!];

  /* ---- ground mesh (renderOrder -4, scene-geometry LAYER.ground): a regular grid, as groundSurface builds it ---- */
  let ground: any = null;
  scene.traverse((o: any) => { if (!ground && o.isMesh && o.renderOrder === -4) ground = o; });
  const gpos: Float32Array | null = ground ? ground.geometry.attributes.position.array : null;
  const gn = gpos ? Math.round(Math.sqrt(gpos.length / 3)) : 0;
  const groundAt = (x: number, north: number): number => {
    if (!gpos || gn < 2) return 0;
    const half = -gpos[0]!, cell = gpos[3]! - gpos[0]!, seg = gn - 1;
    const gx = Math.min(seg - 1e-9, Math.max(0, (x + half) / cell)), gy = Math.min(seg - 1e-9, Math.max(0, (north + half) / cell));
    const ix = Math.floor(gx), iy = Math.floor(gy), u = gx - ix, v = gy - iy;
    const h = (i: number, j: number) => gpos[(j * gn + i) * 3 + 1]!;
    const h00 = h(ix, iy), h10 = h(ix + 1, iy), h01 = h(ix, iy + 1), h11 = h(ix + 1, iy + 1);
    return u >= v ? h00 + u * (h10 - h00) + v * (h11 - h10) : h00 + u * (h11 - h01) + v * (h01 - h00);
  };

  /* ---- buildings (ExtrudeGeometry meshes), world triangles with a bounding box each; cached per scene ---- */
  const bkey: string[] = [];
  const bmeshes: any[] = [];
  scene.traverse((o: any) => { if (o.isMesh && o.geometry?.type === "ExtrudeGeometry" && o.visible) { bmeshes.push(o); bkey.push(o.uuid); } });
  const key = bkey.join(",");
  if (!w.__sweepBuildings || w.__sweepBuildings.key !== key) {
    const list = bmeshes.map((m: any) => {
      const p = m.geometry.attributes.position, idx = m.geometry.index;
      const e = m.matrixWorld.elements as number[];
      const n = idx ? idx.count : p.count;
      const tri = new Float32Array(n * 3);
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (let k = 0; k < n; k++) {
        const i = idx ? idx.getX(k) : k;
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        const wx = e[0]! * x + e[4]! * y + e[8]! * z + e[12]!, wy = e[1]! * x + e[5]! * y + e[9]! * z + e[13]!, wz = e[2]! * x + e[6]! * y + e[10]! * z + e[14]!;
        tri[k * 3] = wx; tri[k * 3 + 1] = wy; tri[k * 3 + 2] = wz;
        x0 = Math.min(x0, wx); y0 = Math.min(y0, wy); z0 = Math.min(z0, wz); x1 = Math.max(x1, wx); y1 = Math.max(y1, wy); z1 = Math.max(z1, wz);
      }
      return { id: m.uuid.slice(0, 8), tri, box: [x0, y0, z0, x1, y1, z1] };
    });
    w.__sweepBuildings = { key, list };
  }
  const buildings: Array<{ id: string; tri: Float32Array; box: number[] }> = w.__sweepBuildings.list;
  /** First building hit on the segment from o along unit d, for t in (0, len); its id or null. */
  const hitBuilding = (o: number[], d: number[], len: number): string | null => {
    for (const b of buildings) {
      // slab test
      let t0 = 0, t1 = len;
      for (let a = 0; a < 3; a++) {
        const inv = 1 / (d[a] || 1e-12);
        let ta = (b.box[a]! - o[a]!) * inv, tb = (b.box[a + 3]! - o[a]!) * inv;
        if (ta > tb) { const s = ta; ta = tb; tb = s; }
        t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
        if (t0 > t1) break;
      }
      if (t0 > t1) continue;
      const tr = b.tri;
      for (let k = 0; k < tr.length; k += 9) {
        const ax = tr[k]!, ay = tr[k + 1]!, az = tr[k + 2]!;
        const e1x = tr[k + 3]! - ax, e1y = tr[k + 4]! - ay, e1z = tr[k + 5]! - az;
        const e2x = tr[k + 6]! - ax, e2y = tr[k + 7]! - ay, e2z = tr[k + 8]! - az;
        const px = d[1]! * e2z - d[2]! * e2y, py = d[2]! * e2x - d[0]! * e2z, pz = d[0]! * e2y - d[1]! * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-9) continue;
        const inv = 1 / det;
        const sx = o[0]! - ax, sy = o[1]! - ay, sz = o[2]! - az;
        const u = (sx * px + sy * py + sz * pz) * inv;
        if (u < 0 || u > 1) continue;
        const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
        const v = (d[0]! * qx + d[1]! * qy + d[2]! * qz) * inv;
        if (v < 0 || u + v > 1) continue;
        const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (tt > 1e-3 && tt < len - 0.05) return b.id;
      }
    }
    return null;
  };

  /* ---- page UI over the canvas ---- */
  const root = document.querySelector(".viewer-canvas");
  const transparent = (c: string) => c === "transparent" || /rgba\([^)]*,\s*0\)$/.test(c);
  const painted = (e: Element): boolean => {
    const cs = getComputedStyle(e);
    if (cs.display === "none" || cs.visibility !== "visible" || Number(cs.opacity) < 0.05) return false;
    if (e.closest(".viewer3d-leaders")) return false;              // hairline leader lines
    if (!transparent(cs.backgroundColor) || cs.boxShadow !== "none" || cs.backdropFilter !== "none" && cs.backdropFilter !== "") return true;
    if (["BUTTON", "INPUT", "IMG", "SELECT", "TEXTAREA"].includes(e.tagName)) return true;
    for (const n of Array.from(e.childNodes)) if (n.nodeType === 3 && (n.textContent ?? "").trim()) return true;
    return false;
  };
  const uiEls = new Set<Element>();
  if (root) for (const e of Array.from(root.querySelectorAll("*"))) if (e !== canvasEl && !e.contains(canvasEl)) uiEls.add(e);
  for (const e of Array.from(document.body.querySelectorAll("*"))) {
    if (root && (root.contains(e) || e.contains(root))) continue;
    const pos = getComputedStyle(e).position;
    if (pos === "fixed" || pos === "sticky") { uiEls.add(e); for (const d of Array.from(e.querySelectorAll("*"))) uiEls.add(d); }
  }
  const ui: Array<{ name: string; r: DOMRect }> = [];
  for (const e of uiEls) {
    if (!painted(e)) continue;
    const r = e.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.right <= cr.left || r.left >= cr.right || r.bottom <= cr.top || r.top >= cr.bottom) continue;
    const cls = typeof (e as HTMLElement).className === "string" ? (e as HTMLElement).className.split(/\s+/).filter(Boolean)[0] : "";
    const name = cls ? `.${cls}` : e.tagName.toLowerCase();
    // A label is named by its vehicle, so "covered by its own label" can be told from another's.
    const lab = e.closest("[data-label]")?.getAttribute("data-label");
    ui.push({ name: lab ? `label ${lab}` : name, r });
  }

  /* ---- geometry helpers ---- */
  const hullOf = (pts: Array<[number, number]>): Array<[number, number]> => {
    const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (p.length < 3) return p;
    const cross = (o: number[], a: number[], b: number[]) => (a[0]! - o[0]!) * (b[1]! - o[1]!) - (a[1]! - o[1]!) * (b[0]! - o[0]!);
    const lo: Array<[number, number]> = [], hi: Array<[number, number]> = [];
    for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2]!, lo[lo.length - 1]!, q) <= 0) lo.pop(); lo.push(q); }
    for (let i = p.length - 1; i >= 0; i--) { const q = p[i]!; while (hi.length >= 2 && cross(hi[hi.length - 2]!, hi[hi.length - 1]!, q) <= 0) hi.pop(); hi.push(q); }
    lo.pop(); hi.pop();
    return lo.concat(hi);
  };
  const area = (poly: ReadonlyArray<readonly [number, number]>) => { let s = 0; for (let i = 0; i < poly.length; i++) { const a = poly[i]!, b = poly[(i + 1) % poly.length]!; s += a[0] * b[1] - b[0] * a[1]; } return Math.abs(s) / 2; };
  const clip = (poly: Array<[number, number]>, x0: number, y0: number, x1: number, y1: number): Array<[number, number]> => {
    let out = poly;
    const edges: Array<[(p: [number, number]) => boolean, (a: [number, number], b: [number, number]) => [number, number]]> = [
      [(p) => p[0] >= x0, (a, b) => [x0, a[1] + ((b[1] - a[1]) * (x0 - a[0])) / (b[0] - a[0])]],
      [(p) => p[0] <= x1, (a, b) => [x1, a[1] + ((b[1] - a[1]) * (x1 - a[0])) / (b[0] - a[0])]],
      [(p) => p[1] >= y0, (a, b) => [a[0] + ((b[0] - a[0]) * (y0 - a[1])) / (b[1] - a[1]), y0]],
      [(p) => p[1] <= y1, (a, b) => [a[0] + ((b[0] - a[0]) * (y1 - a[1])) / (b[1] - a[1]), y1]],
    ];
    for (const [inside, cut] of edges) {
      const src = out; out = [];
      for (let i = 0; i < src.length; i++) {
        const a = src[i]!, b = src[(i + 1) % src.length]!;
        if (inside(b)) { if (!inside(a)) out.push(cut(a, b)); out.push(b); } else if (inside(a)) out.push(cut(a, b));
      }
      if (!out.length) break;
    }
    return out;
  };
  const inPoly = (poly: ReadonlyArray<readonly [number, number]>, x: number, y: number) => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i]!, b = poly[j]!;
      if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
    }
    return c;
  };

  const vehicles: VehicleProbe[] = [];
  for (const id of ids) {
    const g = groups?.[id];
    const blank: VehicleProbe = { id, exists: false, drawable: false, notDrawableWhy: "no group", minDepthM: 0, maxDepthM: 0, near: camera.near, inFrameShare: 0, areaPx: 0, hull: [], sinkCenterM: 0, sinkCornerM: 0, occludedShare: 0, occluders: [], uiShare: 0, uiBy: {}, offPageShare: 0 };
    if (!g) { vehicles.push(blank); continue; }
    // Attached and visible all the way up; a usable scale; drawable meshes.
    let why = "";
    let o = g, attached = false;
    while (o) { if (o.visible === false) why ||= `hidden (${o.type})`; if (o === scene) attached = true; o = o.parent; }
    if (!attached) why ||= "not attached to the scene";
    const e = g.matrixWorld.elements as number[];
    const det = e[0]! * (e[5]! * e[10]! - e[6]! * e[9]!) - e[4]! * (e[1]! * e[10]! - e[2]! * e[9]!) + e[8]! * (e[1]! * e[6]! - e[2]! * e[5]!);
    if (!(Math.abs(det) > 1e-9)) why ||= "zero scale";
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity, meshes = 0;
    for (const m of g.children) {
      if (!m.isMesh) continue;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      const show = m.visible && mats.some((mt: any) => mt && mt.visible !== false && mt.opacity > 0.05);
      const pos = m.geometry?.attributes?.position;
      if (!show || !pos || pos.count === 0) continue;
      meshes++;
      const me2 = m.matrix.elements as number[];
      for (let i = 0; i < pos.count; i++) {
        const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
        const x = me2[0]! * px + me2[4]! * py + me2[8]! * pz + me2[12]!, y = me2[1]! * px + me2[5]! * py + me2[9]! * pz + me2[13]!, z = me2[2]! * px + me2[6]! * py + me2[10]! * pz + me2[14]!;
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); z0 = Math.min(z0, z); x1 = Math.max(x1, x); y1 = Math.max(y1, y); z1 = Math.max(z1, z);
      }
    }
    if (!meshes) why ||= "no drawable mesh";
    if (!meshes) { vehicles.push({ ...blank, exists: true, notDrawableWhy: why }); continue; }
    const toWorld = (x: number, y: number, z: number): number[] => [e[0]! * x + e[4]! * y + e[8]! * z + e[12]!, e[1]! * x + e[5]! * y + e[9]! * z + e[13]!, e[2]! * x + e[6]! * y + e[10]! * z + e[14]!];
    const corners: number[][] = [];
    for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) corners.push(toWorld(x, y, z));
    // Depth in front of the camera, and the screen.
    let minDepth = Infinity, maxDepth = -Infinity;
    const scr: Array<[number, number]> = [];
    for (const c of corners) {
      const v = new V3(c[0], c[1], c[2]);
      const cam = v.clone().applyMatrix4(camera.matrixWorldInverse);
      minDepth = Math.min(minDepth, -cam.z); maxDepth = Math.max(maxDepth, -cam.z);
      v.project(camera);
      scr.push([((v.x + 1) / 2) * W, ((1 - v.y) / 2) * H]);
    }
    const hull = hullOf(scr);
    const full = area(hull);
    const inside = clip(hull, 0, 0, W, H);
    // A box partly behind the camera has no meaningful projection: it counts as not in frame (near-clip / behind-camera say why).
    const inArea = inside.length >= 3 && minDepth > 0 ? area(inside) : 0;
    // Ground under the body (the drawn ground mesh), center and bottom corners.
    const bottom = corners.reduce((m, c) => Math.min(m, c[1]!), Infinity);
    const ctr = toWorld((x0 + x1) / 2, y0, (z0 + z1) / 2);
    const sinkCenter = groundAt(ctr[0]!, -ctr[2]!) - bottom;
    let sinkCorner = -Infinity;
    for (const c of corners) if (Math.abs(c[1]! - bottom) < 1e-6) sinkCorner = Math.max(sinkCorner, groundAt(c[0]!, -c[2]!) - bottom);
    // Lines of sight from points on the body to the camera, against the buildings.
    const L = (a: number, b: number, k: number) => a + (b - a) * k;
    const samples: number[][] = [];
    for (const kx of [0.2, 0.5, 0.8]) for (const kz of [0.2, 0.5, 0.8]) samples.push(toWorld(L(x0, x1, kx), L(y0, y1, 0.92), L(z0, z1, kz)));
    const ym = L(y0, y1, 0.5);
    samples.push(toWorld(x0, ym, (z0 + z1) / 2), toWorld(x1, ym, (z0 + z1) / 2), toWorld((x0 + x1) / 2, ym, z0), toWorld((x0 + x1) / 2, ym, z1), toWorld((x0 + x1) / 2, ym, (z0 + z1) / 2));
    let blocked = 0;
    const by = new Set<string>();
    for (const s of samples) {
      let o3: number[], d3: number[], len: number;
      if (ortho) { d3 = [-fwd[0]!, -fwd[1]!, -fwd[2]!]; o3 = s; len = 2000; }
      else { const dx = eye[0]! - s[0]!, dy = eye[1]! - s[1]!, dz = eye[2]! - s[2]!; len = Math.hypot(dx, dy, dz); d3 = [dx / len, dy / len, dz / len]; o3 = s; }
      const hit = hitBuilding([o3[0]! + d3[0]! * 0.02, o3[1]! + d3[1]! * 0.02, o3[2]! + d3[2]! * 0.02], d3, len);
      if (hit) { blocked++; by.add(hit); }
    }
    // Page UI over the on-canvas part of the body, and the part scrolled out of the window.
    let n = 0, covered = 0, off = 0;
    const uiBy: Record<string, number> = {};
    if (inside.length >= 3) {
      let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      for (const p of inside) { bx0 = Math.min(bx0, p[0]); bx1 = Math.max(bx1, p[0]); by0 = Math.min(by0, p[1]); by1 = Math.max(by1, p[1]); }
      const G = 14;
      for (let i = 0; i < G; i++) for (let j = 0; j < G; j++) {
        const x = L(bx0, bx1, (i + 0.5) / G), y = L(by0, by1, (j + 0.5) / G);
        if (!inPoly(inside, x, y)) continue;
        n++;
        const px = cr.left + x, py = cr.top + y;
        if (px < 0 || py < 0 || px > window.innerWidth || py > window.innerHeight) off++;
        const over = ui.filter((u) => px >= u.r.left && px <= u.r.right && py >= u.r.top && py <= u.r.bottom);
        if (over.length) { covered++; for (const u of over) uiBy[u.name] = (uiBy[u.name] ?? 0) + 1; }
      }
    }
    for (const k of Object.keys(uiBy)) uiBy[k] = Math.round((uiBy[k]! / Math.max(n, 1)) * 100) / 100;
    vehicles.push({
      id, exists: true, drawable: !why, notDrawableWhy: why, minDepthM: minDepth, maxDepthM: maxDepth, near: camera.near,
      inFrameShare: full > 0 ? inArea / full : 0, areaPx: full, hull,
      sinkCenterM: sinkCenter, sinkCornerM: sinkCorner,
      occludedShare: blocked / samples.length, occluders: [...by],
      uiShare: n ? covered / n : 0, uiBy, offPageShare: n ? off / n : 0,
    });
  }
  return { ok: true, canvas: { w: W, h: H, top: cr.top, left: cr.left }, camera: { ortho, near: camera.near, far: camera.far, position: eye }, vehicles };
}

/**
 * Pixels each vehicle actually puts on screen: the canvas is read with every vehicle shown, then with this one hidden
 * (the hook's hide), and the pixels inside its projected hull that change are counted. A building in front of it,
 * the near plane or anything else that stops it reaching the screen leaves that count near zero.
 */
export async function pixelsInPage(arg: { hulls: Record<string, ReadonlyArray<readonly [number, number]>> }): Promise<Record<string, { changed: number; inHull: number }>> {
  const w = window as any;
  const hook = w.__csdViewer;
  const canvas = document.querySelector<HTMLCanvasElement>(".viewer3d canvas")!;
  const frames = (n: number) => new Promise<void>((r) => { const step = (k: number) => (k <= 0 ? r() : requestAnimationFrame(() => step(k - 1))); step(n); });
  const W = canvas.clientWidth, H = canvas.clientHeight;
  const grab = (): Uint8ClampedArray => {
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const g = c.getContext("2d", { willReadFrequently: true })!;
    g.drawImage(canvas, 0, 0, W, H);
    return g.getImageData(0, 0, W, H).data;
  };
  const inPoly = (poly: ReadonlyArray<readonly [number, number]>, x: number, y: number) => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i]!, b = poly[j]!;
      if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
    }
    return c;
  };
  await frames(2);
  const base = grab();
  const out: Record<string, { changed: number; inHull: number }> = {};
  for (const [id, hull] of Object.entries(arg.hulls)) {
    if (hull.length < 3) { out[id] = { changed: 0, inHull: 0 }; continue; }
    hook.hide(id, true);
    await frames(2);
    const img = grab();
    hook.hide(id, false);
    await frames(2);
    let bx0 = W, by0 = H, bx1 = 0, by1 = 0;
    for (const p of hull) { bx0 = Math.min(bx0, p[0]); bx1 = Math.max(bx1, p[0]); by0 = Math.min(by0, p[1]); by1 = Math.max(by1, p[1]); }
    let changed = 0, inHull = 0;
    for (let y = Math.max(0, Math.floor(by0)); y < Math.min(H, Math.ceil(by1)); y++) for (let x = Math.max(0, Math.floor(bx0)); x < Math.min(W, Math.ceil(bx1)); x++) {
      if (!inPoly(hull, x + 0.5, y + 0.5)) continue;
      inHull++;
      const i = (y * W + x) * 4;
      if (Math.abs(base[i]! - img[i]!) + Math.abs(base[i + 1]! - img[i + 1]!) + Math.abs(base[i + 2]! - img[i + 2]!) > 60) changed++;
    }
    out[id] = { changed, inHull };
  }
  return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
