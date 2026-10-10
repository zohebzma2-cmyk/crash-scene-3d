// The 3D viewer (react-three-fiber). Renders the real road layout, buildings,
// terrain and the vehicles from the SimulationResult at time t. All colors
// come from tokens; all text is React text (overlay), never HTML strings.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Line, OrbitControls, OrthographicCamera, PerspectiveCamera } from "@react-three/drei";
import { Vector3, type Color, type Group, type OrthographicCamera as ThreeOrthographicCamera, type PerspectiveCamera as ThreePerspectiveCamera } from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { type Pose, type RoadNetwork, type SimulationResult, type VehicleResult, type Vec2 } from "@csd/core";
import type { CameraKeyEvent, CameraView, ViewerHandle, ViewerProps } from "./types";
import { cameraFor, compassRotationDeg, heightAt, layoutLabels, northUpSpin, screenUpHeading, spunOffset, toThree, type LabelRequest, type PlacedLabel, type Rect, type NorthSpin } from "./math";
import { LIFT } from "./scene-geometry";
import { World } from "./World";
import { readSceneColors, vehicleToken, type SceneColors } from "./tokens";
import { VehicleMesh, RestOutline, useVehicleMaterials } from "./vehicle-view";
import { disposeVehicleModels, vehicleModel } from "./vehicle-models";
import { projectVehicle, vehicleLabel } from "./labels";
import { renderStill, type CaptureContext } from "./capture";
import { ImpactEffects, useDamage, type EffectsApi } from "./effects/ImpactEffects"; // FX
import { Icon } from "../icons/Icon";
import { Compass } from "./Compass";
import { tokenPx } from "../lib/dom";
import { distanceText, measureRows, shownRows } from "../lib/measure";
import type { MeasureGroups } from "../lib/measure";

const BOTH_GROUPS: MeasureGroups = { impact: true, travel: true };
import "./viewer.css";

export function trackPose(sim: SimulationResult, v: VehicleResult, t: number): Pose {
  if (!v.track.length) return v.impactPose;
  const f = (Math.min(Math.max(t, sim.startTimeS), sim.restTimeS) - sim.startTimeS) / sim.dtS;
  const i = Math.min(Math.floor(f), v.track.length - 1), j = Math.min(i + 1, v.track.length - 1), k = f - i;
  const a = v.track[i]!, b = v.track[j]!;
  let dh = b.headingRad - a.headingRad;
  if (dh > Math.PI) dh -= 2 * Math.PI; else if (dh < -Math.PI) dh += 2 * Math.PI;
  return { xM: a.xM + (b.xM - a.xM) * k, yM: a.yM + (b.yM - a.yM) * k, headingRad: a.headingRad + dh * k, speedMps: a.speedMps + (b.speedMps - a.speedMps) * k };
}

function useSceneColors(): SceneColors {
  const [colors, setColors] = useState(() => readSceneColors());
  useEffect(() => {
    const update = () => setColors(readSceneColors());
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
    const mq = matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", update);
    return () => { mo.disconnect(); mq.removeEventListener("change", update); };
  }, []);
  return colors;
}

/* ---------------- paths, impact, measurements ---------------- */
function Paths({ sim, colors, terrain }: { sim: SimulationResult; colors: SceneColors; terrain: RoadNetwork["terrain"] | null }) {
  const lines = useMemo(() => sim.vehicles.flatMap((v) => {
    const iImpact = Math.round((0 - sim.startTimeS) / sim.dtS);
    const pre = v.track.slice(0, iImpact + 1), post = v.track.slice(iImpact);
    const pts = (ps: readonly Pose[]) => ps.filter((_, i) => i % 3 === 0 || i === ps.length - 1).map((p) => toThree({ x: p.xM, y: p.yM }, heightAt(terrain ?? null, { x: p.xM, y: p.yM }) + LIFT.path));
    const out: Array<{ key: string; points: Array<[number, number, number]>; dashed: boolean; color: Color }> = [];
    if (pre.length > 1 && v.approachDistanceM.mid > 0.05) out.push({ key: `${v.id}-pre`, points: pts(pre), dashed: true, color: colors[vehicleToken(v.id)] });
    if (post.length > 1 && v.postImpactDistanceM.mid > 0.05) out.push({ key: `${v.id}-post`, points: pts(post), dashed: false, color: colors[vehicleToken(v.id)] });
    return out;
  }), [sim, colors, terrain]);
  return <>{lines.map((l) => <Line key={l.key} points={l.points} color={l.color} lineWidth={3} dashed={l.dashed} dashSize={1.2} gapSize={0.9} />)}</>;
}

function ImpactRing({ sim, colors, terrain }: { sim: SimulationResult; colors: SceneColors; terrain: RoadNetwork["terrain"] | null }) {
  const p = sim.impactPointM;
  return (
    <mesh position={toThree(p, heightAt(terrain ?? null, p) + LIFT.ring)} rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[1.3, 1.65, 48]} />
      <meshBasicMaterial color={colors["--color-scene-impact"]} />
    </mesh>
  );
}

/** The measurement lines: impact to rest per vehicle, and the gap between each touching pair. */
function Measurements({ sim, colors, terrain, groups }: { sim: SimulationResult; colors: SceneColors; terrain: RoadNetwork["terrain"] | null; groups: MeasureGroups }) {
  const up = (p: Pose) => toThree({ x: p.xM, y: p.yM }, heightAt(terrain ?? null, { x: p.xM, y: p.yM }) + 0.25);
  // One dashed line per touching pair in sim.gaps, between that pair's own vehicles (never "the first two").
  const gapLines = measureRows(sim).flatMap((r) => (r.between && groups[r.group] ? [r] : []));
  const at = (p: Vec2) => toThree(p, heightAt(terrain ?? null, p) + 0.25);
  return (
    <>
      {groups.impact && sim.vehicles.filter((v) => v.postImpactDistanceM.hi >= 0.05).map((v) => (
        <Line key={v.id} points={[up(v.impactPose), up(v.restPose)]} color={colors["--color-scene-measure"]} lineWidth={2} />
      ))}
      {gapLines.map((r) => <Line key={r.key} points={[at(r.between![0]), at(r.between![1])]} color={colors["--color-scene-measure"]} lineWidth={2} dashed dashSize={0.6} gapSize={0.5} />)}
    </>
  );
}

/* ---------------- camera ---------------- */
const isOrtho = (c: unknown): c is ThreeOrthographicCamera => (c as ThreeOrthographicCamera).isOrthographicCamera === true;

/** Orthographic zoom limits, pixels per meter. */
const ORTHO_ZOOM = { min: 2, max: 200 } as const;
const FLY_MS = 600;

/** Puts the camera `k` (0 to 1) of the way through a compass turn around the controls' target. */
function applySpin(camera: ThreeOrthographicCamera | ThreePerspectiveCamera, ctl: OrbitControlsImpl, out: [number, number, number], s: NorthSpin, k: number) {
  spunOffset(s, k, out);
  camera.position.set(ctl.target.x + out[0], ctl.target.y + out[1], ctl.target.z + out[2]);
  ctl.update();
}

function Rig(props: {
  view: CameraView; sim: SimulationResult; terrain: RoadNetwork["terrain"] | null; timeS: number; reducedMotion: boolean;
  resetToken: number; /** Changes when the compass is pressed: turn to look north, same distance and elevation. */ northToken: number; controls: React.RefObject<OrbitControlsImpl | null>; userMoved: React.RefObject<boolean>;
  /** FX: debris and slide-mark end points, for framing the Aftermath view. */
  extraPoints?: () => readonly Vec2[];
}) {
  const { camera, size } = useThree();
  const lastKey = useRef("");
  const lastSize = useRef("");
  const anim = useRef<{ from: Vector3; to: Vector3; fromT: Vector3; toT: Vector3; fromZoom: number; toZoom: number; t0: number } | null>(null);
  const { view, sim, terrain, timeS, reducedMotion, resetToken, northToken, controls, userMoved, extraPoints } = props;
  // The compass turn: an orbit around the target by azimuth (a straight lerp of the position would cut through the target on a half turn).
  const spin = useRef<{ s: NorthSpin; t0: number } | null>(null);
  const lastNorth = useRef(northToken);
  const offset = useRef<[number, number, number]>([0, 0, 0]);
  const spec = useCallback(() => cameraFor(view, sim, (id) => {
    const v = sim.vehicles.find((x) => x.id === id);
    return v ? trackPose(sim, v, timeS) : null;
  }, { w: size.width, h: size.height }, terrain, view === "aftermath" ? extraPoints?.() : undefined), [view, sim, timeS, terrain, size.width, size.height, extraPoints]);

  useEffect(() => {
    const s = spec();
    if (isOrtho(camera) !== (s.kind === "orthographic")) return;      // the camera swap is still in flight
    const key = `${view}|${resetToken}|${camera.uuid}|${sim.vehicles.length}`;
    const sizeKey = `${size.width}x${size.height}`;
    const keyChanged = key !== lastKey.current;
    const resized = sizeKey !== lastSize.current;
    lastSize.current = sizeKey;
    if (!keyChanged && !(resized && !userMoved.current)) return;
    const sameCamera = lastKey.current.split("|")[2] === camera.uuid;
    lastKey.current = key;
    spin.current = null;   // a new view or reset wins over a compass turn still in flight
    if (keyChanged) userMoved.current = false;
    const to = new Vector3(...s.position), toT = new Vector3(...s.target);
    const ctl = controls.current;
    if (!isOrtho(camera)) { (camera as ThreePerspectiveCamera).fov = s.fovDeg; camera.updateProjectionMatrix(); }
    if (reducedMotion || !ctl || !sameCamera || !keyChanged) {
      camera.position.copy(to);
      if (isOrtho(camera)) { camera.zoom = s.zoom; camera.updateProjectionMatrix(); }
      if (ctl) { ctl.target.copy(toT); ctl.update(); }
      camera.lookAt(toT);
      anim.current = null;
      return;
    }
    anim.current = { from: camera.position.clone(), to, fromT: ctl.target.clone(), toT, fromZoom: isOrtho(camera) ? camera.zoom : 1, toZoom: s.zoom, t0: performance.now() };
  }, [camera, spec, view, resetToken, reducedMotion, controls, userMoved, sim.vehicles.length, size.width, size.height]);

  // Pressing the compass: look north. The driver views follow their vehicle, so they ignore it.
  useEffect(() => {
    if (northToken === lastNorth.current) return;
    lastNorth.current = northToken;
    const ctl = controls.current;
    if (!ctl || view === "driver-a" || view === "driver-b") return;
    userMoved.current = true;
    anim.current = null;
    const s = northUpSpin(camera.position.x - ctl.target.x, camera.position.y - ctl.target.y, camera.position.z - ctl.target.z);
    if (reducedMotion || Math.abs(s.delta) < 1e-6) { spin.current = null; applySpin(camera, ctl, offset.current, s, 1); }
    else spin.current = { s, t0: performance.now() };
  }, [northToken, view, camera, controls, userMoved, reducedMotion]);

  useFrame(() => {
    const ctl = controls.current;
    const a = anim.current;
    const sp = spin.current;
    if (sp && ctl) {
      const k = Math.min(1, (performance.now() - sp.t0) / FLY_MS);
      applySpin(camera, ctl, offset.current, sp.s, 1 - Math.pow(1 - k, 3));
      if (k >= 1) spin.current = null;
    } else if (a && ctl) {
      const k = Math.min(1, (performance.now() - a.t0) / FLY_MS);
      const e = 1 - Math.pow(1 - k, 3);
      camera.position.lerpVectors(a.from, a.to, e);
      ctl.target.lerpVectors(a.fromT, a.toT, e);
      if (isOrtho(camera)) { camera.zoom = a.fromZoom + (a.toZoom - a.fromZoom) * e; camera.updateProjectionMatrix(); }
      ctl.update();
      if (k >= 1) anim.current = null;
    } else if (ctl && (view === "driver-a" || view === "driver-b")) {
      const s = spec();                                    // chase view follows the vehicle through time
      camera.position.set(...s.position); ctl.target.set(...s.target); ctl.update();
    }
  });
  return null;
}

/* ---------------- labels ---------------- */
interface LabelItem { readonly id: string; readonly kind: "vehicle" | "measure"; /** Vehicle id for vehicle labels. */ readonly vid: string; readonly letter: string; readonly text: string }
interface VehicleAnchor { readonly item: LabelItem; readonly pose: Pose; readonly dims: { lengthM: number; widthM: number; heightM: number }; readonly ground: number }
interface MeasureAnchor { readonly item: LabelItem; readonly world: Vector3 }
interface LiveLabel { readonly placed: PlacedLabel; readonly item: LabelItem; readonly anchor: { x: number; y: number } }
type Sizes = Map<string, { w: number; h: number }>;

const LABEL_H_PX = 24;
/** Space kept between labels, px, and how far a measurement pill may move from its line (it has leader lines to get back). */
const LABEL_GAP_PX = 8;
const LABEL_STEP_PX = 8;
const PILL_REACH_PX = 150;
const estimateWidth = (it: LabelItem) => (it.kind === "vehicle" ? 14 + it.text.length * 6.6 : 30 + it.text.length * 7.2);
const OBSTACLES = ".view-controls, .scene-caption, .viewer3d-controls, .viewer3d-legend, .viewer3d-compass";

function LabelProjector({ vehicles, measures, showVehicleLabels, sizes, obstacles, onLayout }: {
  vehicles: readonly VehicleAnchor[]; measures: readonly MeasureAnchor[]; showVehicleLabels: boolean;
  sizes: React.RefObject<Sizes>; obstacles: React.RefObject<Rect[]>; onLayout: (l: LiveLabel[]) => void;
}) {
  const { camera, size } = useThree();
  const prev = useRef("");
  const tmp = useMemo(() => new Vector3(), []);
  useFrame(() => {
    const view = { w: size.width, h: size.height };
    camera.updateMatrixWorld();
    const bodies: Rect[] = [];
    const requests: LabelRequest[] = [];
    const items = new Map<string, LabelItem>();
    const dim = (it: LabelItem) => sizes.current.get(it.id) ?? { w: estimateWidth(it), h: LABEL_H_PX };
    for (const v of vehicles) {
      const p = projectVehicle(camera, view, v.pose, v.dims, v.ground);
      if (!p.valid) continue;
      bodies.push(...p.strips);
      if (!showVehicleLabels) continue;
      const d = dim(v.item);
      requests.push({ id: v.item.id, anchor: p.anchor, rect: p.rect, w: d.w, h: d.h });
      items.set(v.item.id, v.item);
    }
    for (const m of measures) {
      tmp.copy(m.world).project(camera);
      if (tmp.z > 1) continue;
      const x = ((tmp.x + 1) / 2) * view.w, y = ((1 - tmp.y) / 2) * view.h;
      const d = dim(m.item);
      requests.push({ id: m.item.id, anchor: { x, y }, rect: { x, y, w: 0, h: 0 }, w: d.w, h: d.h, prefer: ["C"], maxDistance: PILL_REACH_PX });
      items.set(m.item.id, m.item);
    }
    // One pass for the vehicle labels and the measurement pills, at their real measured sizes.
    const placed = layoutLabels(requests, { viewport: view, obstacles: [...bodies, ...obstacles.current], gap: LABEL_GAP_PX, step: LABEL_STEP_PX }).filter((p) => p.visible);
    const key = placed.map((p) => `${p.id}:${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.w)}:${items.get(p.id)?.text ?? ""}`).join("|");
    if (key === prev.current) return;
    prev.current = key;
    onLayout(placed.map((p) => ({ placed: p, item: items.get(p.id)!, anchor: requests.find((r) => r.id === p.id)!.anchor })));
  });
  return null;
}

/**
 * Keeps the compass pointing at north. It reads the camera's orientation each frame and writes the arrow's turn
 * straight to the button (a ref, not React state), and only when the turn changed by more than a tenth of a degree.
 */
function CompassSync({ target }: { target: React.RefObject<HTMLButtonElement | null> }) {
  const { camera } = useThree();
  const last = useRef(Number.NaN);
  useFrame(() => {
    const el = target.current;
    if (!el) return;
    const e = camera.matrixWorld.elements;
    const deg = compassRotationDeg(screenUpHeading(e[4]!, e[6]!, -e[8]!, -e[10]!));
    if (Math.abs(deg - last.current) < 0.1) return;
    last.current = deg;
    el.style.setProperty("--compass-deg", `${deg.toFixed(1)}deg`);
    el.dataset.rotation = deg.toFixed(0);
  });
  return null;
}

function Ready({ onReady }: { onReady?: () => void }) {
  const done = useRef(false);
  useFrame(() => { if (!done.current) { done.current = true; requestAnimationFrame(() => onReady?.()); } });
  return null;
}

/** Hands the live renderer and scene to the still-image capture. */
function Capture({ build, register }: { build: () => Omit<CaptureContext, "live" | "scene">; register: (fn: ViewerHandle["captureStill"]) => void }) {
  const { gl, scene } = useThree();
  useEffect(() => {
    register((t, view, out) => renderStill({ live: gl, scene, ...build() }, t, view, out));
  }, [gl, scene, build, register]);
  return null;
}

/* ---------------- the viewer ---------------- */
const HINT_TEXT = "Use Ctrl + scroll or pinch to zoom";
const HINT_MS = 2200;
const HINT_FADE_MS = 400;
const KEY_ZOOM = 1 / 0.85;
const BUTTON_ZOOM = 1.25;

export const Viewer = forwardRef<ViewerHandle, ViewerProps>(function Viewer(props, ref) {
  const colors = useSceneColors();
  const mats = useVehicleMaterials(colors);
  const terrain = props.roads?.terrain ?? null;
  const rootRef = useRef<HTMLDivElement>(null);
  const controls = useRef<OrbitControlsImpl | null>(null);
  const userMoved = useRef(false);
  const captureFn = useRef<ViewerHandle["captureStill"] | null>(null);
  const groups = useRef(new Map<string, Group>());
  const fxApi = useRef<EffectsApi | null>(null);        // FX
  const measureRef = useRef<Group | null>(null);         // FX: measurements stay mounted so the Aftermath still can show them
  const damage = useDamage(props.scene, props.sim);      // FX: dent callbacks per vehicle
  const extraPoints = useCallback(() => fxApi.current?.extraPoints() ?? [], []);   // FX
  const sizes = useRef<Sizes>(new Map());
  const obstacles = useRef<Rect[]>([]);
  const [resetToken, setResetToken] = useState(0);
  const [northToken, setNorthToken] = useState(0);
  const compassRef = useRef<HTMLButtonElement>(null);
  const [labels, setLabels] = useState<LiveLabel[]>([]);
  const [hint, setHint] = useState<"off" | "on" | "fading">("off");
  const hintShown = useRef(false);
  const ghostStroke = useMemo(() => tokenPx("--size-stroke-ghost", 1.5), []);
  const ortho = props.view === "top";
  const driver = props.view === "driver-a" || props.view === "driver-b";

  useEffect(() => () => disposeVehicleModels(), []);

  const registerGroup = useCallback((id: string, g: Group | null) => { if (g) groups.current.set(id, g); else groups.current.delete(id); }, []);
  const poses = useMemo(() => props.sim.vehicles.map((v) => ({ v, pose: trackPose(props.sim, v, props.timeS) })), [props.sim, props.timeS]);

  // Everything the still capture needs, read at capture time so it is always current.
  const latest = useRef({ props, colors, terrain });
  useEffect(() => { latest.current = { props, colors, terrain }; });
  const buildCapture = useCallback((): Omit<CaptureContext, "live" | "scene"> => {
    const { props: p, colors: c, terrain: tr } = latest.current;
    return {
      sim: p.sim, doc: p.scene, units: p.units, terrain: tr, roads: p.roads, colors: c, groups: groups.current,
      poseAt: (sim, id, time) => trackPose(sim, sim.vehicles.find((x) => x.id === id)!, time),
      prepare: (t, view) => fxApi.current?.prepare(t, view) ?? (() => undefined),   // FX
      extraPoints,                                                                  // FX
    };
  }, [extraPoints]);

  useImperativeHandle(ref, () => ({
    captureStill: (t, view, size) => (captureFn.current ? captureFn.current(t, view, size) : Promise.reject(new Error("The 3D view isn't ready yet."))),
    handleKey: (e) => cameraKey(e),
  }));

  // Test hook, only in a dev server or a VITE_FIXTURES=1 build (dropped from production): the e2e takes stills and reads the camera through it.
  useEffect(() => {
    if (!(import.meta.env.DEV || import.meta.env.VITE_FIXTURES === "1")) return;
    const hook = {
      captureStill: (t: number, view: CameraView, size: { width: number; height: number }) => captureFn.current!(t, view, size),
      hide: (id: string, hidden: boolean) => { const g = groups.current.get(id); if (g) g.visible = !hidden; },
      camera: () => { const c = controls.current?.object; return c ? { orthographic: isOrtho(c), zoom: c.zoom, position: c.position.toArray(), target: controls.current!.target.toArray() } : null; },
    };
    (window as unknown as { __csdViewer?: typeof hook }).__csdViewer = hook;
    return () => { delete (window as unknown as { __csdViewer?: typeof hook }).__csdViewer; };
  }, []);
  // Where the vehicles go, one point every few meters: street names are kept off these.
  const pathPoints = useMemo(() => props.sim.vehicles.flatMap((v) => v.track.filter((_, i) => i % 20 === 0).map((p): Vec2 => ({ x: p.xM, y: p.yM }))), [props.sim]);

  /* ---- label anchors ---- */
  const vehicleAnchors: VehicleAnchor[] = useMemo(() => poses.map(({ v, pose }) => {
    const model = vehicleModel(v.type, v.lengthM, v.widthM);
    const label = vehicleLabel(props.scene.vehicles.find((x) => x.id === v.id), v.id, pose, props.timeS, props.units);
    return {
      item: { id: `v-${v.id}`, kind: "vehicle", vid: v.id, letter: v.id, text: label.text },
      pose, dims: { lengthM: v.lengthM, widthM: v.widthM, heightM: model.heightM }, ground: heightAt(terrain, { x: pose.xM, y: pose.yM }),
    };
  }), [poses, props.scene.vehicles, props.timeS, props.units, terrain]);

  const showValues = props.showMeasureValues !== false;
  const mg = props.measureGroups ?? BOTH_GROUPS;
  // Same switches as the Measure tab, so the pill numbers match its numbered rows.
  const shownGroups = useMemo(() => ({ impact: mg.impact, travel: mg.travel }), [mg.impact, mg.travel]);
  const measureAnchors: MeasureAnchor[] = useMemo(() => {
    if (!props.showMeasurements || !showValues) return [];
    // Same rows and numbering as the Measure tab and the exports (lib/measure).
    return shownRows(measureRows(props.sim), shownGroups).map((r, n) => {
      const mid = r.anchor!;
      return { item: { id: `m-${r.key}`, kind: "measure" as const, vid: "", letter: String(n + 1), text: distanceText(r, props.units) }, world: new Vector3(...toThree(mid, heightAt(terrain, mid) + 0.5)) };
    });
  }, [props.showMeasurements, showValues, props.sim, props.units, terrain, shownGroups]);

  /* ---- what the labels must keep clear of: view controls, zoom buttons, legend, caption ---- */
  const measureObstacles = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const base = root.getBoundingClientRect();
    const found = new Set<Element>([...root.querySelectorAll(OBSTACLES), ...(root.parentElement?.querySelectorAll(OBSTACLES) ?? [])]);
    const rects: Rect[] = [];
    for (const el of found) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) rects.push({ x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height });
    }
    obstacles.current = rects;
  }, []);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    measureObstacles();
    if (typeof ResizeObserver !== "function") return;
    const ro = new ResizeObserver(measureObstacles);
    ro.observe(root);
    for (const el of [...root.querySelectorAll(OBSTACLES), ...(root.parentElement?.querySelectorAll(OBSTACLES) ?? [])]) ro.observe(el);
    return () => ro.disconnect();
  }, [measureObstacles, props.showPaths, props.view]);

  // Real label sizes, measured from the DOM after each layout, replace the estimates.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    for (const el of root.querySelectorAll<HTMLElement>("[data-label]")) {
      const id = el.dataset.label!;
      const w = el.offsetWidth, h = el.offsetHeight;
      const cur = sizes.current.get(id);
      if (w > 0 && (!cur || Math.abs(cur.w - w) > 0.5 || Math.abs(cur.h - h) > 0.5)) sizes.current.set(id, { w, h });
    }
  });

  /* ---- zoom: ctrl/cmd + wheel (and trackpad pinch), buttons, keys. A plain wheel scrolls the page. ---- */
  const zoomBy = useCallback((scale: number) => {
    const ctl = controls.current;
    if (!ctl) return;
    userMoved.current = true;
    const cam = ctl.object;
    if (isOrtho(cam)) {
      cam.zoom = Math.min(ctl.maxZoom, Math.max(ctl.minZoom, cam.zoom * scale));
      cam.updateProjectionMatrix();
    } else {
      const offset = cam.position.clone().sub(ctl.target);
      offset.setLength(Math.min(ctl.maxDistance, Math.max(ctl.minDistance, offset.length() / scale)));
      cam.position.copy(ctl.target).add(offset);
    }
    ctl.update();
  }, []);

  const hintTimers = useRef<number[]>([]);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const showHint = () => {
      if (hintShown.current) return;
      hintShown.current = true;
      setHint("on");
      hintTimers.current.push(window.setTimeout(() => setHint("fading"), HINT_MS), window.setTimeout(() => setHint("off"), HINT_MS + HINT_FADE_MS));
    };
    // Only ctrl/cmd + wheel (a trackpad pinch arrives as ctrl + wheel) reaches OrbitControls' zoom. A plain
    // wheel is left alone: we never preventDefault, so the page scrolls.
    const before = (e: WheelEvent) => {
      const zoomWanted = e.ctrlKey || e.metaKey;
      if (controls.current) controls.current.enableZoom = zoomWanted;
      if (!zoomWanted) showHint();
    };
    const after = () => { if (controls.current) controls.current.enableZoom = true; };    // two-finger touch pinch still zooms
    el.addEventListener("wheel", before, { capture: true, passive: true });
    el.addEventListener("wheel", after, { passive: true });
    const timers = hintTimers.current;
    return () => { el.removeEventListener("wheel", before, { capture: true }); el.removeEventListener("wheel", after); timers.forEach((t) => window.clearTimeout(t)); };
  }, []);

  /* ---- camera keys (the page's single focus target forwards what it doesn't use) ---- */
  const cameraKey = (e: CameraKeyEvent): boolean => {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    const ctl = controls.current;
    if (!ctl) return false;
    const cam = ctl.object;
    const offset = cam.position.clone().sub(ctl.target);
    const step = e.shiftKey ? 0.25 : 0.08;
    const rotate = (axis: Vector3, angle: number) => { userMoved.current = true; offset.applyAxisAngle(axis, angle); cam.position.copy(ctl.target).add(offset); ctl.update(); };
    const key = e.key;
    if (key === "ArrowLeft") { e.preventDefault(); rotate(new Vector3(0, 1, 0), step); }
    else if (key === "ArrowRight") { e.preventDefault(); rotate(new Vector3(0, 1, 0), -step); }
    else if (key === "ArrowUp" || key === "ArrowDown") {
      e.preventDefault();
      const side = new Vector3().crossVectors(offset, new Vector3(0, 1, 0)).normalize();
      const next = offset.clone().applyAxisAngle(side, key === "ArrowUp" ? step : -step);
      const elev = Math.asin(next.y / next.length());
      if (elev > 0.08 && elev < 1.55) rotate(side, key === "ArrowUp" ? step : -step);
    } else if (key === "+" || key === "=") { e.preventDefault(); zoomBy(KEY_ZOOM); }
    else if (key === "-" || key === "_") { e.preventDefault(); zoomBy(1 / KEY_ZOOM); }
    else if (key.toLowerCase() === "r") { e.preventDefault(); setResetToken((x) => x + 1); }
    else return false;
    return true;
  };

  const onLayout = useCallback((l: LiveLabel[]) => setLabels(l), []);
  const registerCapture = useCallback((fn: ViewerHandle["captureStill"]) => { captureFn.current = fn; }, []);

  return (
    <div className="viewer3d" ref={rootRef}>
      <Canvas shadows="percentage" dpr={[1, 2]} gl={{ preserveDrawingBuffer: true, antialias: true }}>
        <PerspectiveCamera makeDefault={!ortho} fov={45} near={0.3} far={4000} position={[0, 120, 0.01]} />
        <OrthographicCamera makeDefault={ortho} near={0.3} far={4000} zoom={8} position={[0, 400, 0.001]} />
        <hemisphereLight args={[colors["--color-scene-sky"], colors["--color-scene-lot"], 1]} />
        <directionalLight color={colors["--color-scene-sun"]} position={[60, 120, 40]} intensity={1.6} castShadow shadow-mapSize={[2048, 2048]} shadow-camera-left={-120} shadow-camera-right={120} shadow-camera-top={120} shadow-camera-bottom={-120} />
        <World roads={props.roads} colors={colors} focus={props.sim.impactPointM} avoid={pathPoints} />
        {props.showPaths && <Paths sim={props.sim} colors={colors} terrain={terrain} />}
        <ImpactRing sim={props.sim} colors={colors} terrain={terrain} />
        {poses.map(({ v, pose }) => <VehicleMesh key={v.id} v={v} pose={pose} mats={mats} terrain={terrain} register={registerGroup} damage={damage.get(v.id)} />)}
        <group ref={measureRef} visible={props.showMeasurements}><Measurements sim={props.sim} colors={colors} terrain={terrain} groups={shownGroups} /></group>{/* FX: always mounted, shown by the toggle or the Aftermath still */}
        <ImpactEffects scene={props.scene} sim={props.sim} roads={props.roads} colors={colors} timeS={props.timeS} reducedMotion={props.reducedMotion} apiRef={fxApi} measureRef={measureRef} groups={groups} />{/* FX */}
        {(props.showMeasurements || props.showPaths) && props.sim.vehicles.map((v) => (
          <RestOutline key={`rest-${v.id}`} v={v} terrain={terrain} strokePx={ghostStroke} color={colors[vehicleToken(v.id)]} />
        ))}
        <OrbitControls ref={controls} makeDefault enableDamping={!props.reducedMotion} maxPolarAngle={Math.PI / 2 - 0.05} minDistance={6} maxDistance={900} minZoom={ORTHO_ZOOM.min} maxZoom={ORTHO_ZOOM.max} onStart={() => { userMoved.current = true; }} />
        <Rig view={props.view} sim={props.sim} terrain={terrain} timeS={props.timeS} reducedMotion={props.reducedMotion} resetToken={resetToken} northToken={northToken} controls={controls} userMoved={userMoved} extraPoints={extraPoints} />
        <LabelProjector vehicles={vehicleAnchors} measures={measureAnchors} showVehicleLabels={props.showLabels} sizes={sizes} obstacles={obstacles} onLayout={onLayout} />
        <CompassSync target={compassRef} />
        <Capture build={buildCapture} register={registerCapture} />
        <Ready onReady={props.onReady} />
      </Canvas>

      <div className="viewer3d-labels">
        <svg className="viewer3d-leaders" aria-hidden="true">
          {labels.filter((l) => l.placed.leader).map((l) => (
            <line key={l.item.id} className={`viewer3d-leader v-${l.item.letter.toLowerCase()}${l.item.kind === "measure" ? " is-measure" : ""}`}
              x1={l.placed.leader!.x1} y1={l.placed.leader!.y1} x2={l.placed.leader!.x2} y2={l.placed.leader!.y2} />
          ))}
        </svg>
        {labels.map((l) => {
          const cls = `viewer3d-label viewer3d-${l.item.kind} v-${l.item.letter.toLowerCase()}`;
          const style = { transform: `translate(${Math.round(l.placed.x)}px, ${Math.round(l.placed.y)}px)` };
          const inner = (<><span className="viewer3d-badge">{l.item.letter}</span><span className="viewer3d-text">{l.item.text}</span></>);
          return l.item.kind === "vehicle" ? (
            <button key={l.item.id} type="button" className={cls} style={style} data-label={l.item.id} onClick={() => props.onSelectVehicle?.(l.item.vid)}>{inner}</button>
          ) : (
            <span key={l.item.id} className={cls} style={style} data-label={l.item.id} aria-hidden="true">{inner}</span>
          );
        })}
        {labels.filter((l) => l.placed.leader).map((l) => (
          <span key={`dot-${l.item.id}`} className={`viewer3d-dot v-${l.item.letter.toLowerCase()}${l.item.kind === "measure" ? " is-measure" : ""}`} style={{ transform: `translate(${Math.round(l.placed.leader!.x1)}px, ${Math.round(l.placed.leader!.y1)}px)` }} aria-hidden="true" />
        ))}
      </div>

      <div className="viewer3d-hud">
        {props.showPaths ? <span className="viewer3d-legend">Dashed: before impact · Solid: after</span> : null}
        {/* The compass sits in one row with the zoom buttons, so the legend above keeps its place (labels plan around both). */}
        <div className="viewer3d-hud-row">
          <Compass ref={compassRef} driver={driver} onReset={() => setNorthToken((x) => x + 1)} />
          <div className="viewer3d-controls" role="group" aria-label="Zoom">
            <button type="button" className="icon-btn" aria-label="Zoom in" onClick={() => zoomBy(BUTTON_ZOOM)}><Icon name="plus" /></button>
            <button type="button" className="icon-btn" aria-label="Zoom out" onClick={() => zoomBy(1 / BUTTON_ZOOM)}><Icon name="minus" /></button>
            <button type="button" className="icon-btn" aria-label="Reset view" onClick={() => setResetToken((x) => x + 1)}><Icon name="crosshair" /></button>
          </div>
        </div>
      </div>

      <div className={`viewer3d-hint${hint === "on" ? " is-on" : ""}`} role="status" aria-live="polite">{hint === "off" ? "" : HINT_TEXT}</div>
    </div>
  );
});
