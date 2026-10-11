// Catalog models: fitting to the footprint, which material is paint, the paint in a baked texture, tint, dispose.
import { describe, expect, it, vi } from "vitest";
import { Box3, BoxGeometry, Color, DataTexture, Group, Mesh, MeshStandardMaterial, RGBAFormat, Vector3, type Texture } from "three";
import { analysePaint, applyTint, disposeModel, hsv, materialAreas, normalise, planNormalisation, planTint, texturePixels, PAINT_CHUNK, PAINT_DECL } from "../../src/viewer/glb-model";

const FOOT = { lengthM: 4.76, widthM: 1.81, heightM: 1.45 };

function boxCar(opts: { alongX?: boolean; offset?: [number, number, number]; scale?: number } = {}) {
  const s = opts.scale ?? 0.25;
  const root = new Group();
  const body = new MeshStandardMaterial({ name: "Body" });
  const glass = new MeshStandardMaterial({ name: "Glass", transparent: true, opacity: 0.5 });
  const tire = new MeshStandardMaterial({ name: "Tire" });
  // Length 4 along z (or x), width 1.8, height 1.4, then scaled and moved off the origin like a raw catalog file.
  const lower = new Mesh(new BoxGeometry(opts.alongX ? 4 : 1.8, 0.8, opts.alongX ? 1.8 : 4), body); lower.position.y = 0.6;
  const cabin = new Mesh(new BoxGeometry(opts.alongX ? 2 : 1.6, 0.4, opts.alongX ? 1.6 : 2), glass); cabin.position.y = 1.2;
  const wheel = new Mesh(new BoxGeometry(0.3, 0.4, 0.4), tire); wheel.position.set(0, 0.2, 0);
  root.add(lower, cabin, wheel);
  root.scale.setScalar(s);
  root.position.set(...(opts.offset ?? [3, -2, 5]));
  return { root, body, glass, tire };
}

describe("fitting a catalog model to the illustration's footprint", () => {
  it("plans the turn, scale and offset from the bounding box (a model along z faces +z: half a turn)", () => {
    const box = new Box3(new Vector3(-0.25, -0.2, -0.5), new Vector3(0.25, 0.2, 0.5));
    const n = planNormalisation(box, FOOT);
    expect(n.yawRad).toBeCloseTo(Math.PI);
    expect(n.scale[0]).toBeCloseTo(FOOT.widthM / 0.5);
    expect(n.scale[1]).toBeCloseTo(FOOT.heightM / 0.4);
    expect(n.scale[2]).toBeCloseTo(FOOT.lengthM / 1);
    expect(n.offset[1]).toBeCloseTo(0.2 * n.scale[1]);
  });

  it.each([[false], [true]])("a raw model (along x: %s), off the origin and scaled, ends centred in plan, on y = 0, exactly L x W x H", (alongX) => {
    const { root } = boxCar({ alongX, offset: [3, -2, 5] });
    const fit = normalise(root, FOOT);
    const b = new Box3().setFromObject(fit);
    const size = b.getSize(new Vector3()), c = b.getCenter(new Vector3());
    expect(size.x).toBeCloseTo(FOOT.widthM, 5);
    expect(size.y).toBeCloseTo(FOOT.heightM, 5);
    expect(size.z).toBeCloseTo(FOOT.lengthM, 5);
    expect(c.x).toBeCloseTo(0, 5);
    expect(c.z).toBeCloseTo(0, 5);
    expect(b.min.y).toBeCloseTo(0, 5);
  });

  it("a glTF model's front (+z) ends at the viewer's front (-z, north at heading 0)", () => {
    const root = new Group();
    const nose = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshStandardMaterial()); nose.position.z = 0.45;
    const tail = new Mesh(new BoxGeometry(0.4, 0.3, 0.1), new MeshStandardMaterial()); tail.position.z = -0.45;
    root.add(nose, tail);
    const fit = normalise(root, FOOT);
    fit.updateMatrixWorld(true);
    expect(nose.getWorldPosition(new Vector3()).z).toBeLessThan(0);
    expect(tail.getWorldPosition(new Vector3()).z).toBeGreaterThan(0);
  });
});

describe("which material is the paint", () => {
  it("a material named Body wins; it gets the colour exactly", () => {
    const { root, body, glass, tire } = boxCar();
    const plan = planTint(root);
    expect(plan.kind).toBe("material");
    if (plan.kind !== "material") return;
    expect(plan.how).toBe("named");
    expect(plan.targets).toEqual([body]);
    const red = new Color().setRGB(0.7, 0.05, 0.05);
    expect(applyTint(plan, red)).toBe(true);
    expect(body.color.equals(red)).toBe(true);
    expect(glass.color.equals(red)).toBe(false);
    expect(tire.color.equals(red)).toBe(false);
  });

  it("with no paint-like names, the largest opaque non-glass material; never glass or a tyre", () => {
    const { root, body, glass } = boxCar();
    body.name = "Material_001";
    glass.name = "Material_002";
    const areas = materialAreas(root);
    expect(areas.get(body)!).toBeGreaterThan(areas.get(glass)!);
    const plan = planTint(root);
    expect(plan.kind === "material" && plan.how === "largest" && plan.targets[0] === body).toBe(true);
    // Even when the glass is the biggest, it is never painted.
    const g2 = boxCar();
    g2.body.name = "Glass_outer"; g2.body.transparent = true; g2.body.opacity = 0.4;
    const p2 = planTint(g2.root);
    expect(p2.kind === "material" ? p2.targets.includes(g2.body) : false).toBe(false);
  });

  it("nothing to paint: says so instead of painting the wrong thing", () => {
    const root = new Group();
    root.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ name: "Windshield glass", transparent: true, opacity: 0.3 })));
    expect(planTint(root)).toEqual({ kind: "none", reason: "no-material" });
  });
});

/** A synthetic baked texture: `paint` on `share` of the texels, grey glass and black tyres on the rest, black padding. */
function bakedTexture(paint: [number, number, number], share = 0.6, size = 32): DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const f = i / (size * size);
    const px: [number, number, number] = f < share ? paint.map((c) => Math.round(c * (0.75 + 0.25 * (i % 5) / 4))) as [number, number, number]
      : f < share + 0.15 ? [120, 124, 128] : f < share + 0.25 ? [20, 20, 22] : [0, 0, 0];
    data.set([...px, 255], i * 4);
  }
  const t = new DataTexture(data, size, size, RGBAFormat);
  t.needsUpdate = true;
  return t;
}

describe("the paint baked into a texture (the catalog's case)", () => {
  it("finds a red catalog paint as a chromatic hue near 0", () => {
    const t = bakedTexture([200, 20, 25]);
    const px = texturePixels(t)!;
    const a = analysePaint(px.data, px.width, px.height);
    expect(a.mode).toBe("chromatic");
    if (a.mode !== "chromatic") return;
    expect(Math.min(a.hue, 1 - a.hue)).toBeLessThan(0.03);
    expect(a.share).toBeGreaterThan(0.5);
    // The reference hue is the shader's own hue of that paint (same formula, linear RGB).
    const lin = (b: number) => ((b / 255) <= 0.04045 ? b / 255 / 12.92 : ((b / 255 + 0.055) / 1.055) ** 2.4);
    expect(Math.min(Math.abs(hsv(lin(200), lin(20), lin(25))[0] - a.hue), 1 - Math.abs(hsv(lin(200), lin(20), lin(25))[0] - a.hue))).toBeLessThan(0.03);
  });

  it("finds a blue one, a white one (light neutral), and gives up on a black one", () => {
    const blue = texturePixels(bakedTexture([30, 80, 200]))!;
    const b = analysePaint(blue.data, blue.width, blue.height);
    expect(b.mode === "chromatic" && b.hue > 0.55 && b.hue < 0.7).toBe(true);
    const white = texturePixels(bakedTexture([235, 236, 233]))!;
    expect(analysePaint(white.data, white.width, white.height).mode).toBe("light-neutral");
    const black = texturePixels(bakedTexture([22, 24, 26]))!;
    expect(analysePaint(black.data, black.width, black.height)).toEqual({ mode: "none", reason: "dark-or-unclear" });
    expect(analysePaint(new Uint8Array(16), 2, 2)).toEqual({ mode: "none", reason: "empty" });
  });

  it("a single textured material: the shader patch is installed and the uniforms take the paint", () => {
    const map = bakedTexture([200, 20, 25]);
    const mat = new MeshStandardMaterial({ map });
    const root = new Group();
    root.add(new Mesh(new BoxGeometry(1, 0.4, 2), mat));
    const plan = planTint(root);
    expect(plan.kind).toBe("texture");
    if (plan.kind !== "texture") return;
    expect(mat.customProgramCacheKey()).toBe("csd-paint-v1");
    const shader = { uniforms: {} as Record<string, unknown>, fragmentShader: "#include <common>\nvoid main() {\n#include <map_fragment>\n}", vertexShader: "" };
    mat.onBeforeCompile(shader as never, undefined as never);
    expect(shader.fragmentShader).toContain(PAINT_DECL.trim().split("\n")[0]!);
    expect(shader.fragmentShader).toContain("diffuseColor.rgb = mix(csdC, uPaint * csdShade, csdMask);");
    expect(shader.fragmentShader.indexOf(PAINT_CHUNK.trim().split("\n")[0]!)).toBeGreaterThan(shader.fragmentShader.indexOf("#include <map_fragment>"));
    const blue = new Color().setRGB(0.05, 0.2, 0.7);
    expect(applyTint(plan, blue)).toBe(true);
    expect(plan.uniforms.uPaintMode.value).toBe(1);
    expect(plan.uniforms.uPaint.value.equals(blue)).toBe(true);
    expect(shader.uniforms.uPaint).toBe(plan.uniforms.uPaint);
  });

  it("a black catalog paint keeps its texture: no tint, and applyTint says so", () => {
    const root = new Group();
    root.add(new Mesh(new BoxGeometry(1, 0.4, 2), new MeshStandardMaterial({ map: bakedTexture([22, 24, 26]) })));
    const plan = planTint(root);
    expect(plan).toEqual({ kind: "none", reason: "dark-or-unclear" });
    expect(applyTint(plan, new Color())).toBe(false);
  });

  it("a texture that can't be read (no pixels) is not guessed at", () => {
    const root = new Group();
    root.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ map: { isTexture: true, image: null } as unknown as Texture })));
    expect(planTint(root)).toEqual({ kind: "none", reason: "unreadable-texture" });
  });
});

describe("dispose", () => {
  it("frees every geometry, material and texture once", () => {
    const map = bakedTexture([200, 20, 25]);
    const mat = new MeshStandardMaterial({ map });
    const root = new Group();
    const a = new Mesh(new BoxGeometry(1, 1, 1), mat), b = new Mesh(new BoxGeometry(1, 1, 1), mat);
    root.add(a, b);
    const spies = [vi.spyOn(a.geometry, "dispose"), vi.spyOn(b.geometry, "dispose")];
    const m = vi.spyOn(mat, "dispose"), t = vi.spyOn(map, "dispose");
    disposeModel(normalise(root, FOOT));
    for (const s of spies) expect(s).toHaveBeenCalledTimes(1);
    expect(m).toHaveBeenCalledTimes(1);
    expect(t).toHaveBeenCalledTimes(1);
  });
});
