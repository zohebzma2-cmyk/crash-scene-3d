// Typical schematic dimensions in metres, not measured OSM dimensions. Tagged positions only.
// Neutral signal lenses: recollections never drive a traffic-signal simulation.
//
// Cost: the viewer mounts this after its first frame (World's `furniture`), so it never holds up the picture.
// Every geometry, material and symbol texture is made once per kind (and per theme) and shared by all the
// features, all the paint (turn arrows and crosswalks) is one line-segments draw, and lamps light up only when
// "Dark with street lights" is the answer, at most MAX_LAMP_LIGHTS of them (each point light is a shader cost
// for every lit material in the scene).
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { BoxGeometry, CanvasTexture, CylinderGeometry, DoubleSide, MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry, SRGBColorSpace, SphereGeometry, type BufferGeometry, type Group, type Material } from "three";
import { useThree } from "@react-three/fiber";
import { Line } from "@react-three/drei";
import { featureIcon, taggedTurnArrows, taggedCrosswalkPaint, type RoadFeature, type RoadNetwork, type Vec2 } from "@csd/core";
import { iconStrokes } from "@csd/core/icon-strokes";
import type { GroundSurface } from "./scene-geometry";
import type { SceneColors } from "./tokens";

/** The most lamps that get a real point light; the rest still glow (emissive). */
export const MAX_LAMP_LIGHTS = 8;
/** A layer no camera draws: the features wait here while their shaders compile. */
const PRECOMPILE_LAYER = 31;
const POLE_HEIGHT = { "street-light": 6, signal: 3.2, other: 2.1 } as const;
const poleHeight = (kind: RoadFeature["kind"]) => kind === "street-light" ? POLE_HEIGHT["street-light"] : kind === "signal" ? POLE_HEIGHT.signal : POLE_HEIGHT.other;
const speedText = (f: RoadFeature) => f.kind === "speed" ? f.label.match(/\d+(?:\.\d+)?/)?.[0] : undefined;

/** A symbol drawn on a canvas: the icon's strokes, or a number (speed limits), on the surface color. */
function symbolTexture(name: string, colors: SceneColors, text: string | undefined): CanvasTexture {
  const canvas = document.createElement("canvas"); canvas.width = 96; canvas.height = 96;
  const c = canvas.getContext("2d");
  if (c) {
    c.fillStyle = colors.css["--color-surface"]; c.fillRect(0, 0, 96, 96);
    c.strokeStyle = colors.css["--color-text"]; c.lineWidth = 8; c.lineCap = "round"; c.lineJoin = "round";
    for (const line of iconStrokes[name] ?? []) {
      c.beginPath(); line.forEach((p, i) => { if (i === 0) c.moveTo(p[0]! * 4, p[1]! * 4); else c.lineTo(p[0]! * 4, p[1]! * 4); }); c.stroke();
    }
    if (text) {
      c.fillStyle = colors.css["--color-surface"]; c.fillRect(0, 0, 96, 96);
      const style = getComputedStyle(document.documentElement);
      c.fillStyle = colors.css["--color-text"]; c.font = `${style.getPropertyValue("--weight-bold")} ${canvas.height * 0.44}px ${style.getPropertyValue("--font-sans")}`; c.textAlign = "center"; c.textBaseline = "middle"; c.fillText(text, 48, 48);
    }
  }
  const t = new CanvasTexture(canvas); t.colorSpace = SRGBColorSpace; return t;
}

/** One set of geometries and materials for every feature; symbol materials are made on first use per icon/text. */
function useKit(colors: SceneColors, lit: boolean) {
  const kit = useMemo(() => {
    const metal = colors["--color-scene-glass"];
    const geometries = {
      pole: { "street-light": new CylinderGeometry(0.045, 0.07, POLE_HEIGHT["street-light"], 6), signal: new CylinderGeometry(0.045, 0.07, POLE_HEIGHT.signal, 6), other: new CylinderGeometry(0.045, 0.07, POLE_HEIGHT.other, 6) },
      head: new BoxGeometry(0.4, 1.05, 0.22),
      lens: new CylinderGeometry(0.12, 0.12, 0.035, 12),
      lamp: new SphereGeometry(0.25, 8, 6),
      stop: new CylinderGeometry(0.41, 0.41, 0.045, 8),
      yield: new CylinderGeometry(0.48, 0.48, 0.045, 3),
      sign: new CylinderGeometry(0.41, 0.41, 0.045, 4),
      plane: new PlaneGeometry(1, 1),
    };
    const materials = {
      pole: new MeshStandardMaterial({ color: metal, roughness: 0.8 }),
      metal: new MeshStandardMaterial({ color: metal }),
      lens: new MeshStandardMaterial({ color: colors["--color-scene-lane"] }),
      speed: new MeshStandardMaterial({ color: colors["--color-surface"], side: DoubleSide }),
      sign: new MeshStandardMaterial({ color: colors["--color-scene-impact"], side: DoubleSide }),
    };
    const symbols = new Map<string, MeshBasicMaterial>();
    const symbol = (name: string, text: string | undefined): MeshBasicMaterial => {
      const key = `${name}|${text ?? ""}`;
      let m = symbols.get(key);
      if (!m) { m = new MeshBasicMaterial({ map: symbolTexture(name, colors, text), side: DoubleSide }); symbols.set(key, m); }
      return m;
    };
    const dispose = () => {
      const geos: BufferGeometry[] = [...Object.values(geometries.pole), geometries.head, geometries.lens, geometries.lamp, geometries.stop, geometries.yield, geometries.sign, geometries.plane];
      geos.forEach((g) => g.dispose());
      const mats: Material[] = Object.values(materials);
      mats.forEach((m) => m.dispose());
      for (const m of symbols.values()) { m.map?.dispose(); m.dispose(); }
      symbols.clear();
    };
    return { geometries, materials, symbol, dispose };
  }, [colors]);
  useEffect(() => () => kit.dispose(), [kit]);
  // The lamp glow follows the answer without rebuilding the rest of the kit.
  const lamp = useMemo(() => new MeshStandardMaterial({ color: colors["--color-scene-headlight"], emissive: colors["--color-scene-headlight"], emissiveIntensity: lit ? 1.5 : 0 }), [colors, lit]);
  useEffect(() => () => lamp.dispose(), [lamp]);
  return { ...kit, lamp };
}
type Kit = ReturnType<typeof useKit>;

function Furniture({ feature: f, ground, colors, kit, light, slot }: { feature: RoadFeature; ground: GroundSurface; colors: SceneColors; kit: Kit; light: boolean; slot: number }) {
  const y = ground.heightAt(f.position);
  const physical = f.source === "node" && f.kind !== "crosswalk";
  const height = poleHeight(f.kind);
  const { geometries: g, materials: m } = kit;
  const text = speedText(f);
  const top = physical ? 0.85 : 1.3;
  return <group position={[f.position.x, y, -f.position.y]}>
    {physical ? <>
      <mesh position={[0, height / 2, 0]} castShadow geometry={f.kind === "street-light" ? g.pole["street-light"] : f.kind === "signal" ? g.pole.signal : g.pole.other} material={m.pole} />
      <group position={[0, height, 0]} rotation={[0, (180 - (f.facingDeg ?? 0)) * Math.PI / 180, 0]}>
        {f.kind === "signal" ? <>
          <mesh castShadow geometry={g.head} material={m.metal} />
          {[-0.32, 0, 0.32].map((h) => <mesh key={h} position={[0, h, 0.13]} rotation={[Math.PI / 2, 0, 0]} geometry={g.lens} material={m.lens} />)}
        </> : f.kind === "street-light" ? <>
          <mesh geometry={g.lamp} material={kit.lamp} />
          {light ? <pointLight color={colors["--color-scene-headlight"]} intensity={60} distance={18} decay={2} /> : null}
        </> : <>
          <mesh rotation={[Math.PI / 2, f.kind === "yield" ? Math.PI : Math.PI / 8, 0]} castShadow geometry={f.kind === "stop" ? g.stop : f.kind === "yield" ? g.yield : g.sign} material={f.kind === "speed" ? m.speed : m.sign} />
          <mesh position={[0, 0, 0.04]} scale={[0.45, 0.45, 1]} geometry={g.plane} material={kit.symbol(featureIcon(f.kind), text)} />
        </>}
      </group>
    </> : null}
    {/* Top-view keys are map symbols, not extra signs or fabricated paint. They remain at the tagged point. */}
    <group position={[slot * 1.5, 0.08, 0]} rotation={[0, f.kind === "oneway" && f.facingDeg !== null ? (90 - f.facingDeg) * Math.PI / 180 : 0, 0]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} scale={[top, top, 1]} geometry={g.plane} material={kit.symbol(featureIcon(f.kind), text)} />
    </group>
  </group>;
}

/** The lamps that get a point light: the mapped ones nearest the crash, at most MAX_LAMP_LIGHTS. */
export function litLamps(features: readonly RoadFeature[], focus: Vec2, lit: boolean): Set<string> {
  if (!lit) return new Set();
  const lamps = features.filter((f) => f.kind === "street-light" && f.source === "node");
  lamps.sort((a, b) => Math.hypot(a.position.x - focus.x, a.position.y - focus.y) - Math.hypot(b.position.x - focus.x, b.position.y - focus.y));
  return new Set(lamps.slice(0, MAX_LAMP_LIGHTS).map((f) => f.id));
}

/** `onShown`: the features are in the picture (stills wait for this). */
export function RoadFurniture({ roads, ground, colors, lit, focus, onShown }: { roads: RoadNetwork | null; ground: GroundSurface; colors: SceneColors; lit: boolean; focus: Vec2; onShown?: () => void }) {
  const kit = useKit(colors, lit);
  // All the tagged paint as one set of segments (one draw): each polyline becomes its consecutive pairs.
  const segments = useMemo(() => {
    if (!roads) return [];
    const out: Array<[number, number, number]> = [];
    for (const line of [...taggedTurnArrows(roads), ...taggedCrosswalkPaint(roads)]) {
      const v = line.points.map((p): [number, number, number] => [p.x, ground.heightAt(p) + 0.09, -p.y]);
      for (let i = 1; i < v.length; i++) out.push(v[i - 1]!, v[i]!);
    }
    return out;
  }, [roads, ground]);
  const lights = useMemo(() => litLamps(roads?.features ?? [], focus, lit), [roads, focus, lit]);
  // The features' shaders are compiled off the frame (KHR_parallel_shader_compile where the browser has it) while
  // they sit on a layer no camera draws, then they join the picture. Compiling them inside a frame made the page
  // wait on the GPU (about 1.3 s at 4× CPU in SwiftShader).
  const { gl, camera, scene } = useThree();
  const root = useRef<Group>(null);
  const shown = useRef(false);
  useLayoutEffect(() => {
    const g = root.current;
    if (!g || shown.current) return;
    g.traverse((o) => o.layers.set(PRECOMPILE_LAYER));
    let live = true;
    const show = () => {
      if (!live) return;
      shown.current = true;
      g.traverse((o) => o.layers.set(0));
      onShown?.();
    };
    gl.compileAsync(g, camera, scene).then(show, show);
    return () => { live = false; };
  }, [gl, camera, scene, onShown]);
  // Collocated road annotations form a small key beside their anchor; no extra physical signs.
  const slots = new Map<string, number>();
  return <group ref={root}>{roads?.features?.map((f) => {
    const key = `${f.source}-${f.osmId}`, slot = slots.get(key) ?? 0; slots.set(key, slot + 1);
    return <Furniture key={f.id} feature={f} ground={ground} colors={colors} kit={kit} light={lights.has(f.id)} slot={slot} />;
  })}{segments.length ? <Line points={segments} segments color={colors["--color-scene-lane"]} lineWidth={2} /> : null}</group>;
}
