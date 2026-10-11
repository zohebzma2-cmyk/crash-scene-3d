// Catalog 3D models (GLB) in the viewer (round B): parse, fit to the illustration's footprint, tint to the
// vehicle's colour, dispose. The low-poly model (vehicle-models.ts) is always the fallback.
//
// How the catalog's models are made (checked 2026-10-11 on the provider's one public sample, an image-to-3D
// "trellis" demo GLB, generator trimesh): ONE mesh, ONE unnamed material, POSITION + TEXCOORD_0 only (no normals),
// a 1024 x 1024 PNG baseColorTexture with the catalog paint BAKED IN (a texture atlas: body panels in the paint,
// glass grey, wheels silver/black, unused atlas space black), baseColorFactor white, roughness 1, no metalness.
// It is normalised to a unit length along z with y up. There is no separate body-paint material to recolour.
//
// So tinting takes one of three routes, chosen per model by `planTint`:
//  1. "material": a material whose name says body paint (or, failing names, the largest opaque non-glass
//     material) WITHOUT a texture: set its colour. Exact.
//  2. "texture": the paint is baked into the texture (the catalog's case). `analysePaint` finds the catalog
//     paint in the texture (the dominant saturated hue, or a light neutral for white/silver cars), and a small
//     shader patch recolours only texels near that paint to the picked colour, keeping their shading (texel
//     luminance over the paint's mean luminance). Glass, tyres, chrome and the dark atlas padding are untouched.
//     Close, not exact: hue edges can bleed a little, and trim in the same hue as the paint is recoloured too.
//  3. "none": a dark catalog paint (black, dark grey) can't be told apart from tyres and trim in a baked texture,
//     so the model keeps the catalog paint and the viewer says so next to the picked colour.
// Colours come in as three Colors already resolved by the caller (token reader or the picked hex); no literals here.
import { Box3, Color, Group, Matrix4, Vector3, type BufferGeometry, type Material, type Mesh, type Object3D, type Texture } from "three";

export interface Footprint {
  readonly lengthM: number;
  readonly widthM: number;
  readonly heightM: number;
}

export interface Normalisation {
  /** Turn about +y applied first, radians: glTF models face +z (ours face -z), or lie along x. */
  readonly yawRad: number;
  readonly scale: readonly [number, number, number];
  readonly offset: readonly [number, number, number];
}

/**
 * How to fit a model whose bounding box (in its own frame) is `box` into the footprint: face -z, centred on the
 * plan origin, wheels on y = 0, and exactly lengthM x widthM x heightM. Scaling is per axis (a catalog model whose
 * proportions differ from the class preset is stretched a little), so the illustration contract holds exactly:
 * two vehicles that touch in the physics touch on screen.
 */
export function planNormalisation(box: Box3, target: Footprint): Normalisation {
  const size = box.getSize(new Vector3());
  const c = box.getCenter(new Vector3());
  // Longest horizontal axis is the length. A model along z faces +z (glTF's forward): half a turn. Along x: its +x end to the front.
  const alongX = size.x > size.z * 1.05;
  const yaw = alongX ? Math.PI / 2 : Math.PI;
  const len = alongX ? size.x : size.z, wid = alongX ? size.z : size.x, hgt = size.y;
  const safe = (v: number) => (v > 1e-6 ? v : 1);
  const sx = target.widthM / safe(wid), sy = target.heightM / safe(hgt), sz = target.lengthM / safe(len);
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  // The box centre after the turn (rotation about y: x' = x cos + z sin, z' = -x sin + z cos).
  const cx = c.x * cos + c.z * sin, cz = -c.x * sin + c.z * cos;
  return { yawRad: yaw, scale: [sx, sy, sz], offset: [-cx * sx, -box.min.y * sy, -cz * sz] };
}

/** Wrap `root` in two groups that apply `planNormalisation` (the turn inside, then scale and offset). */
export function normalise(root: Object3D, target: Footprint): Group {
  root.updateMatrixWorld(true);
  // Precise: the box of the vertices themselves, not of rotated node boxes (which would leave the model short of its footprint).
  const box = new Box3().setFromObject(root, true);
  const n = planNormalisation(box, target);
  const yaw = new Group();
  yaw.rotation.y = n.yawRad;
  yaw.add(root);
  const fit = new Group();
  fit.name = "catalog-model";
  fit.scale.set(...n.scale);
  fit.position.set(...n.offset);
  fit.add(yaw);
  fit.updateMatrixWorld(true);
  return fit;
}

/* ------------------------------ which material is paint ------------------------------ */

/** A material that has a colour (MeshStandardMaterial, MeshPhysicalMaterial, MeshBasic/Lambert/Phong). */
export type ColoredMaterial = Material & { color: Color; map?: Texture | null };

const PAINT_NAME = /body|paint|exterior|shell|carrosserie|karosserie/i;
const NOT_PAINT = /glass|window|windshield|windscreen|tire|tyre|wheel|rim|chrome|light|lamp|interior|rubber|plastic|trim|grille|grill|mirror|logo|badge|emblem|plate|exhaust|brake|caliper|seat|black|shadow/i;

const isColored = (m: Material): m is ColoredMaterial => (m as Partial<ColoredMaterial>).color instanceof Color;
const isGlassy = (m: Material) => m.transparent || m.opacity < 0.99 || ((m as { transmission?: number }).transmission ?? 0) > 0;

function meshesOf(root: Object3D): Mesh[] {
  const out: Mesh[] = [];
  root.traverse((o) => { if ((o as Mesh).isMesh) out.push(o as Mesh); });
  return out;
}

/** Each material's surface area in the root's frame (m² after normalisation), summed over every mesh and group that uses it. */
export function materialAreas(root: Object3D): Map<Material, number> {
  root.updateMatrixWorld(true);
  const areas = new Map<Material, number>();
  const a = new Vector3(), b = new Vector3(), c = new Vector3(), ab = new Vector3(), ac = new Vector3();
  const toRoot = new Matrix4();
  const rootInv = new Matrix4().copy(root.matrixWorld).invert();
  for (const mesh of meshesOf(root)) {
    const g = mesh.geometry as BufferGeometry;
    const pos = g.getAttribute("position");
    if (!pos) continue;
    toRoot.multiplyMatrices(rootInv, mesh.matrixWorld);
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const idx = g.index;
    const tri = idx ? idx.count / 3 : pos.count / 3;
    const groups = g.groups.length ? g.groups : [{ start: 0, count: tri * 3, materialIndex: 0 }];
    for (const grp of groups) {
      const m = mats[grp.materialIndex ?? 0];
      if (!m) continue;
      let area = 0;
      for (let i = grp.start; i + 2 < grp.start + grp.count; i += 3) {
        const i0 = idx ? idx.getX(i) : i, i1 = idx ? idx.getX(i + 1) : i + 1, i2 = idx ? idx.getX(i + 2) : i + 2;
        a.fromBufferAttribute(pos, i0).applyMatrix4(toRoot);
        b.fromBufferAttribute(pos, i1).applyMatrix4(toRoot);
        c.fromBufferAttribute(pos, i2).applyMatrix4(toRoot);
        area += ab.subVectors(b, a).cross(ac.subVectors(c, a)).length() / 2;
      }
      areas.set(m, (areas.get(m) ?? 0) + area);
    }
  }
  return areas;
}

/* ------------------------------ the paint in a baked texture ------------------------------ */

export type PaintAnalysis =
  | { readonly mode: "chromatic"; readonly hue: number; readonly refLuma: number; readonly share: number }
  | { readonly mode: "light-neutral"; readonly refLuma: number; readonly share: number }
  | { readonly mode: "none"; readonly reason: "dark-or-unclear" | "empty" };

const lin = (byte: number) => { const c = byte / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const LIN = Array.from({ length: 256 }, (_, i) => lin(i));

/** HSV of a linear RGB colour (h in 0..1), the same formula as the shader's. */
export function hsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d > 1e-10) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return [h, max > 1e-10 ? d / max : 0, max];
}

/** Texels at least this saturated (linear HSV) and bright enough count as a chromatic paint. */
const CHROMA_MIN_S = 0.35, CHROMA_MIN_V = 0.02;
/** Texels this desaturated and this bright count as a light neutral paint (white, silver). */
const NEUTRAL_MAX_S = 0.15, NEUTRAL_MIN_V = 0.3;
/** Darker texels than this are atlas padding or deep shadow and are ignored. */
const PAD_MAX_V = 0.01;
const HUE_BINS = 36;

/**
 * Find the catalog paint in a baked base-colour texture (RGBA bytes, sRGB). The paint is the largest coloured
 * area of a car's texture, so: the dominant saturated hue (with its neighbouring bins) when it covers at least a
 * quarter of the used texels; otherwise a light neutral (white, silver) covering at least a third; otherwise
 * nothing that can be told apart from tyres and trim.
 */
export function analysePaint(rgba: ArrayLike<number>, width: number, height: number): PaintAnalysis {
  const bins = new Float64Array(HUE_BINS);
  const binLuma = new Float64Array(HUE_BINS);
  let used = 0, neutral = 0, neutralLuma = 0;
  for (let i = 0; i < width * height * 4; i += 4) {
    if ((rgba[i + 3] ?? 255) < 128) continue;
    const r = LIN[rgba[i]!]!, g = LIN[rgba[i + 1]!]!, b = LIN[rgba[i + 2]!]!;
    const [h, s, v] = hsv(r, g, b);
    if (v <= PAD_MAX_V) continue;
    used++;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (s >= CHROMA_MIN_S && v >= CHROMA_MIN_V) {
      const k = Math.min(HUE_BINS - 1, Math.floor(h * HUE_BINS));
      bins[k]! += 1;
      binLuma[k]! += luma;
    } else if (s <= NEUTRAL_MAX_S && v >= NEUTRAL_MIN_V) { neutral++; neutralLuma += luma; }
  }
  if (!used) return { mode: "none", reason: "empty" };
  let best = 0, bestCount = -1;
  for (let k = 0; k < HUE_BINS; k++) {
    const n = bins[(k + HUE_BINS - 1) % HUE_BINS]! + bins[k]! + bins[(k + 1) % HUE_BINS]!;
    if (n > bestCount) { bestCount = n; best = k; }
  }
  if (bestCount / used >= 0.25) {
    // Circular mean of the three bins' centres, weighted by count.
    let sx = 0, sy = 0, lsum = 0;
    for (const k of [best - 1, best, best + 1]) {
      const kk = (k + HUE_BINS) % HUE_BINS, n = bins[kk]!;
      const ang = ((kk + 0.5) / HUE_BINS) * 2 * Math.PI;
      sx += Math.cos(ang) * n; sy += Math.sin(ang) * n; lsum += binLuma[kk]!;
    }
    let hue = Math.atan2(sy, sx) / (2 * Math.PI);
    if (hue < 0) hue += 1;
    return { mode: "chromatic", hue, refLuma: lsum / bestCount, share: bestCount / used };
  }
  if (neutral / used >= 1 / 3) return { mode: "light-neutral", refLuma: neutralLuma / neutral, share: neutral / used };
  return { mode: "none", reason: "dark-or-unclear" };
}

/** A texture's pixels, down-sampled to at most `max` px a side: from a DataTexture's data, or through a 2D canvas. Null when unreadable. */
export function texturePixels(tex: Texture, max = 64): { data: Uint8ClampedArray; width: number; height: number } | null {
  const img = tex.image as { data?: ArrayLike<number>; width?: number; height?: number } | undefined;
  const w = img?.width ?? 0, h = img?.height ?? 0;
  if (!img || w < 1 || h < 1) return null;
  const s = Math.min(1, max / Math.max(w, h));
  const W = Math.max(1, Math.round(w * s)), H = Math.max(1, Math.round(h * s));
  if (img.data && img.data.length >= w * h * 4) {
    const out = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const src = (Math.min(h - 1, Math.floor(y / s)) * w + Math.min(w - 1, Math.floor(x / s))) * 4, dst = (y * W + x) * 4;
      for (let k = 0; k < 4; k++) out[dst + k] = img.data[src + k]!;
    }
    return { data: out, width: W, height: H };
  }
  if (typeof document === "undefined") return null;
  try {
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img as CanvasImageSource, 0, 0, W, H);
    return { data: ctx.getImageData(0, 0, W, H).data, width: W, height: H };
  } catch {
    return null;
  }
}

/* ------------------------------ the tint plan ------------------------------ */

export type TintPlan =
  | { readonly kind: "material"; readonly how: "named" | "largest"; readonly targets: readonly ColoredMaterial[] }
  | { readonly kind: "texture"; readonly targets: readonly ColoredMaterial[]; readonly analysis: Exclude<PaintAnalysis, { mode: "none" }>; readonly uniforms: PaintUniforms }
  | { readonly kind: "none"; readonly reason: "no-material" | "dark-or-unclear" | "unreadable-texture" };

/**
 * Decide how to tint a model (see the header): named body-paint materials first, else the largest opaque
 * non-glass material; a textured target goes through the texture analysis. `pixels` reads a texture (injected for tests).
 */
export function planTint(root: Object3D, pixels: (t: Texture) => ReturnType<typeof texturePixels> = texturePixels): TintPlan {
  const areas = materialAreas(root);
  const colored = [...areas.keys()].filter(isColored);
  let targets: ColoredMaterial[] = colored.filter((m) => PAINT_NAME.test(m.name) && !NOT_PAINT.test(m.name));
  let how: "named" | "largest" = "named";
  if (!targets.length) {
    const candidates = colored.filter((m) => !isGlassy(m) && !NOT_PAINT.test(m.name)).sort((x, y) => (areas.get(y) ?? 0) - (areas.get(x) ?? 0));
    targets = candidates.slice(0, 1);
    how = "largest";
  }
  if (!targets.length) return { kind: "none", reason: "no-material" };
  const textured = targets.filter((m) => m.map);
  if (!textured.length) return { kind: "material", how, targets };
  const px = pixels(textured[0]!.map!);
  if (!px) return { kind: "none", reason: "unreadable-texture" };
  const analysis = analysePaint(px.data, px.width, px.height);
  if (analysis.mode === "none") return { kind: "none", reason: "dark-or-unclear" };
  const uniforms = paintUniforms();
  for (const m of textured) installPaintShader(m, uniforms);
  return { kind: "texture", targets: textured, analysis, uniforms };
}

/* ------------------------------ the shader patch ------------------------------ */

export interface PaintUniforms {
  readonly uPaintMode: { value: number };
  readonly uPaint: { value: Color };
  readonly uRefHue: { value: number };
  readonly uHueTol: { value: number };
  readonly uRefLuma: { value: number };
}

export const paintUniforms = (): PaintUniforms => ({
  uPaintMode: { value: 0 }, uPaint: { value: new Color() }, uRefHue: { value: 0 }, uHueTol: { value: 0.06 }, uRefLuma: { value: 0.2 },
});

export const PAINT_DECL = /* glsl */ `
uniform float uPaintMode;
uniform vec3 uPaint;
uniform float uRefHue;
uniform float uHueTol;
uniform float uRefLuma;
vec3 csdHsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
`;

/** Runs after the base-colour texture is applied: texels near the catalog paint take the picked colour, keeping their shading. */
export const PAINT_CHUNK = /* glsl */ `
if (uPaintMode > 0.5) {
  vec3 csdC = diffuseColor.rgb;
  vec3 csdH = csdHsv(csdC);
  float csdMask;
  if (uPaintMode < 1.5) {
    float csdDh = abs(csdH.x - uRefHue);
    csdDh = min(csdDh, 1.0 - csdDh);
    csdMask = (1.0 - smoothstep(uHueTol, uHueTol * 1.8, csdDh)) * smoothstep(0.25, 0.4, csdH.y) * smoothstep(0.008, 0.03, csdH.z);
  } else {
    csdMask = (1.0 - smoothstep(0.1, 0.2, csdH.y)) * smoothstep(0.2, 0.35, csdH.z);
  }
  float csdShade = clamp(dot(csdC, vec3(0.2126, 0.7152, 0.0722)) / max(uRefLuma, 1e-4), 0.0, 2.0);
  diffuseColor.rgb = mix(csdC, uPaint * csdShade, csdMask);
}
`;

/** Patch a textured material so `uniforms` recolour its baked paint. One program for every such material. */
export function installPaintShader(m: Material, uniforms: PaintUniforms): void {
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${PAINT_DECL}`)
      .replace("#include <map_fragment>", `#include <map_fragment>\n${PAINT_CHUNK}`);
  };
  m.customProgramCacheKey = () => "csd-paint-v1";
  m.needsUpdate = true;
}

/**
 * Tint the model to `paint` (the picked colour, or the vehicle's token colour for "Not sure": the same
 * `vehicleColor()` answer as everywhere else). Returns false when the model keeps the catalog's paint.
 * Cheap and allocation-free: call it when the paint changes, never per frame.
 */
export function applyTint(plan: TintPlan, paint: Color): boolean {
  if (plan.kind === "material") { for (const m of plan.targets) m.color.copy(paint); return true; }
  if (plan.kind === "texture") {
    const u = plan.uniforms, a = plan.analysis;
    u.uPaint.value.copy(paint);
    u.uRefLuma.value = a.refLuma;
    if (a.mode === "chromatic") { u.uPaintMode.value = 1; u.uRefHue.value = a.hue; } else u.uPaintMode.value = 2;
    return true;
  }
  return false;
}

/* ------------------------------ lighting fit ------------------------------ */

/** Metalness our materials use: the scene is lit by a sky and a sun only, with no environment map to reflect. */
const SCENE_METALNESS = 0.15;

/**
 * Make a catalog model read under our lights. glTF's default metallicFactor is 1, and the catalog's sample omits it,
 * so its one material loads fully metallic: with no environment map to reflect, a metal renders almost black. A
 * material with no metalness texture that comes in mostly metallic gets the metalness of our own vehicles.
 * Returns how many materials were changed.
 */
export function fitToSceneLighting(root: Object3D): number {
  let n = 0;
  const seen = new Set<Material>();
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (seen.has(m)) continue;
      seen.add(m);
      const std = m as Material & { metalness?: number; metalnessMap?: Texture | null };
      if (typeof std.metalness === "number" && std.metalness > 0.5 && !std.metalnessMap) { std.metalness = SCENE_METALNESS; n++; }
    }
  });
  return n;
}

/* ------------------------------ teardown ------------------------------ */

/** Free every geometry, material and texture under `root` (a loaded catalog model). */
export function disposeModel(root: Object3D): void {
  const textures = new Set<Texture>();
  const materials = new Set<Material>();
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(m);
  });
  for (const m of materials) {
    for (const v of Object.values(m)) if (v && typeof v === "object" && (v as Texture).isTexture) textures.add(v as Texture);
    m.dispose();
  }
  textures.forEach((t) => t.dispose());
}
