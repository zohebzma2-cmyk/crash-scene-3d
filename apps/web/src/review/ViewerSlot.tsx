// Where the 3D viewer mounts. This placeholder takes the locked ViewerProps and draws the top-down
// fallback (also what a browser without WebGL gets): the diagram, vehicle labels with speeds at the
// current time, measurement pills and street names, with label collision avoidance. The lead swaps in <Viewer>.
//
// Per timeline tick only the vehicle labels and pills are laid out again. Street names are placed
// once, against the static layout (vehicle bodies at impact and at rest, the labels and pills at
// impact, the view controls), and again only when that layout changes.
import { useEffect, useMemo, useState } from "react";
import { formatDistance, formatSpeed, roleWords, vehicleTag, type Scene, type SimulationResult, type Units, type Vec2 } from "@csd/core";
import type { ViewerProps } from "../viewer/types";
import { Diagram } from "../components/Diagram";
import { fitViewBox, pxPerMeter, pxToWorld, sceneBounds, worldToPx, type ViewBox } from "../lib/diagramView";
import type { Rect } from "../lib/geometry";
import { useElementSize, usePhone, tokenPx } from "../lib/dom";
import { streetNames } from "../lib/streets";
import { estimateLabelSize, placeLabels, type LabelRequest } from "../lib/labels";
import { measureRows, shownRows, distanceText, type MeasureGroups, type MeasureRow } from "../lib/measure";
import { useServices } from "../services/context";
import type { PhysicsService } from "../services/types";

const LABEL_H = 32;
const LABEL_CHAR_PX = 7;
const LABEL_PAD = 44;
const PILL_H = 28;
const PILL_PAD = 36;
const GAP = 6;
const FALLBACK_SIZE = { w: 800, h: 560 };
/** Street names are set in --text-xs, uppercase and letter-spaced: about this many font sizes per letter, and this tall. */
const STREET_CHAR_EM = 0.8;
const STREET_HEIGHT_EM = 1.5;
const FALLBACK_TEXT_PX = 12;
/** The overlay the view controls make, found by this selector in the same canvas. */
/** Radius of a dot marking a point of the two-point measurement. */
const MEASURE_DOT_PX = 5;
const CONTROLS_SELECTOR = ".view-controls";

export interface ViewerSlotProps extends ViewerProps {
  /** Tapping a label selects that vehicle in the panel. */
  readonly onSelectVehicle?: (id: string) => void;
  /** Which measurement overlays are on when `showMeasurements` is (default: both). */
  readonly measureGroups?: MeasureGroups;
  /** "Measure two points": a tap on the picture, or on a vehicle's label, adds a point (world meters). */
  readonly measureTool?: boolean;
  readonly measurePoints?: readonly Vec2[];
  readonly onMeasurePoint?: (p: Vec2) => void;
}

const BOTH_GROUPS: MeasureGroups = { impact: true, travel: true };

interface Env {
  readonly scene: Scene;
  readonly sim: SimulationResult;
  readonly physics: PhysicsService;
  readonly vb: ViewBox;
  readonly size: { w: number; h: number };
  readonly ppm: number;
  readonly units: Units;
  readonly showLabels: boolean;
  readonly pills: readonly MeasureRow[];
}

interface LabelItem { id: string; name: string; speed: string; at: { x: number; y: number }; radius: number; w: number }

function itemsAt(env: Env, t: number): LabelItem[] {
  return env.sim.vehicles.map((v) => {
    const pose = env.physics.poseAt(env.sim, v, t);
    const sv = env.scene.vehicles.find((x) => x.id === v.id);
    const parkedStill = sv?.action === "parked" && t <= 0;
    const unsure = sv?.speed.kind === "unsure";
    const speed = parkedStill ? "parked" : `${unsure ? "~" : ""}${formatSpeed(pose.speedMps, { units: env.units }).text}`;
    // Core's one label: "A · Your car · 25 mph" (the letter sits in the badge).
    const text = vehicleTag({ id: v.id }, speed);
    const at = worldToPx(env.vb, env.size, pose.xM, pose.yM);
    const radius = (Math.max(v.lengthM, v.widthM) / 2) * env.ppm;
    return { id: v.id, name: roleWords({ id: v.id }), speed, at, radius, w: estimateLabelSize(text, LABEL_CHAR_PX, LABEL_H, LABEL_PAD).w };
  });
}

const bodyRects = (items: readonly LabelItem[]): Rect[] => items.map((i) => ({ x: i.at.x - i.radius, y: i.at.y - i.radius, w: i.radius * 2, h: i.radius * 2 }));

function requestsFor(env: Env, items: readonly LabelItem[]) {
  const requests: LabelRequest[] = [];
  if (env.showLabels) for (const i of items) requests.push({ id: `v${i.id}`, anchor: i.at, w: i.w, h: LABEL_H, clearance: i.radius + GAP });
  const pillItems = env.pills.map((row, n) => ({ n, row, at: worldToPx(env.vb, env.size, row.anchor?.x ?? 0, row.anchor?.y ?? 0) }));
  for (const p of pillItems) {
    const text = `${p.n + 1} ${distanceText(p.row, env.units)}`;
    requests.push({ id: `m${p.n}`, anchor: p.at, w: estimateLabelSize(text, LABEL_CHAR_PX, PILL_H, PILL_PAD).w, h: PILL_H, clearance: 0, prefer: ["center", "above", "below"] });
  }
  return { requests, pillItems };
}

const rectOf = (p: { x: number; y: number }, w: number, h: number): Rect => ({ x: p.x, y: p.y, w, h });

export function ViewerSlot({ scene, roads, sim, timeS, view, showLabels, showMeasurements, showPaths, units, onReady, onSelectVehicle, measureGroups = BOTH_GROUPS, measureTool = false, measurePoints = [], onMeasurePoint }: ViewerSlotProps) {
  const { physics } = useServices();
  const phone = usePhone();
  const [ref, measured] = useElementSize<HTMLDivElement>(FALLBACK_SIZE);
  const size = useMemo(() => ({ w: measured.w, h: measured.h }), [measured.w, measured.h]);
  const [reserved, setReserved] = useState<Rect | null>(null);
  useEffect(() => { onReady?.(); }, [onReady]);

  // Read once: token sizes don't change while the page is open.
  const fontPx = useMemo(() => tokenPx("--text-xs", FALLBACK_TEXT_PX), []);

  // The view controls float over the picture: their rectangle is kept clear of every label, in every layout.
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const controls = slot?.parentElement?.querySelector<HTMLElement>(CONTROLS_SELECTOR);
    if (!slot || !controls) return;
    const a = slot.getBoundingClientRect();
    const b = controls.getBoundingClientRect();
    const next = b.width > 0 && b.height > 0 ? { x: b.left - a.left, y: b.top - a.top, w: b.width, h: b.height } : null;
    // Measuring the page after layout is what this effect is for.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReserved((prev) => (prev && next && prev.x === next.x && prev.y === next.y && prev.w === next.w && prev.h === next.h ? prev : next));
  }, [slot, size.w, size.h, phone]);

  const mode = view === "wide" ? "wide" : "near";
  const vb = useMemo(() => fitViewBox(sceneBounds(sim, physics.poseAt, mode), size.w / size.h), [sim, physics, mode, size.w, size.h]);
  const markers = useMemo(() => shownRows(measureRows(sim), { impact: measureGroups.impact, travel: measureGroups.travel }), [sim, measureGroups.impact, measureGroups.travel]);
  const ppm = pxPerMeter(vb, size);
  const pills = showMeasurements && !phone ? markers : [];
  const env: Env = { scene, sim, physics, vb, size, ppm, units, showLabels, pills };

  // Street names: once per static layout (not per timeline tick).
  const streets = useMemo(() => {
    const e: Env = { scene, sim, physics, vb, size, ppm, units, showLabels, pills: showMeasurements && !phone ? markers : [] };
    const atImpact = itemsAt(e, 0);
    const atRest = itemsAt(e, sim.restTimeS);
    const { requests } = requestsFor(e, atImpact);
    const keep = reserved ? [reserved] : [];
    const placedAtImpact = placeLabels(requests, { bounds: size, obstacles: [...bodyRects(atImpact), ...keep], gap: GAP });
    const labelRects = placedAtImpact.map((p) => {
      const r = requests.find((q) => q.id === p.id);
      return rectOf(p, r?.w ?? 0, r?.h ?? 0);
    });
    const obstacles = [...bodyRects(atImpact), ...bodyRects(atRest), ...labelRects, ...keep];
    const w0 = (name: string) => name.length * fontPx * STREET_CHAR_EM;
    const h0 = fontPx * STREET_HEIGHT_EM;
    const named = streetNames(scene, roads, vb, sim.impactPointM).map((s) => ({
      ...s,
      rects: s.spots.map((sp) => {
        const c = worldToPx(vb, size, sp.at.x, sp.at.y);
        const t = (sp.angleDeg * Math.PI) / 180;
        const w = Math.abs(w0(s.name) * Math.cos(t)) + Math.abs(h0 * Math.sin(t));
        const h = Math.abs(w0(s.name) * Math.sin(t)) + Math.abs(h0 * Math.cos(t));
        return { x: c.x - w / 2, y: c.y - h / 2, w, h };
      }),
    }));
    const placed = placeLabels(named.map((s): LabelRequest => ({ id: s.name, anchor: { x: 0, y: 0 }, w: 0, h: 0, clearance: 0, spots: s.rects, optional: true })), { bounds: size, obstacles, gap: GAP });
    return named.flatMap((s) => {
      const p = placed.find((x) => x.id === s.name);
      const sp = p?.spot == null ? null : s.spots[p.spot];
      const rc = p?.spot == null ? null : s.rects[p.spot];
      return sp && rc ? [{ name: s.name, angleDeg: sp.angleDeg, x: rc.x + rc.w / 2, y: rc.y + rc.h / 2 }] : [];
    });
    // `roads` and the scene change the street spots; the rest is the layout they are placed against.
    // The compiler can't see that `vb` and `size` are never mutated after render; they are plain values.
    // eslint-disable-next-line react-hooks/preserve-manual-memoization
  }, [scene, roads, sim, physics, vb, size, ppm, units, showLabels, showMeasurements, phone, markers, reserved, fontPx]);

  // Vehicle labels and pills: laid out for the current time.
  const items = itemsAt(env, timeS);
  const { requests, pillItems } = requestsFor(env, items);

  // "Measure two points": the line, its two dots and its number (the number is the world distance, through the formatter).
  const pts = measurePoints.map((p) => worldToPx(vb, size, p.x, p.y));
  const twoText = measurePoints.length === 2 ? `about ${formatDistance(Math.hypot(measurePoints[0]!.x - measurePoints[1]!.x, measurePoints[0]!.y - measurePoints[1]!.y), { both: false, units }).text}` : null;
  if (twoText && pts[0] && pts[1] && !phone) {
    requests.push({ id: "m2", anchor: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }, w: estimateLabelSize(twoText, LABEL_CHAR_PX, PILL_H, PILL_PAD).w, h: PILL_H, clearance: 0, prefer: ["above", "below", "center"] });
  }
  const pickFromPointer = (e: { clientX: number; clientY: number }) => {
    const box = slot?.getBoundingClientRect();
    if (!box || !box.width) return;
    onMeasurePoint?.(pxToWorld(vb, size, e.clientX - box.left, e.clientY - box.top));
  };
  const pickVehicle = (id: string) => {
    const result = sim.vehicles.find((x) => x.id === id);
    if (!result) return;
    const pose = physics.poseAt(sim, result, timeS);
    onMeasurePoint?.({ x: pose.xM, y: pose.yM });
  };
  const placed = placeLabels(requests, { bounds: size, obstacles: [...bodyRects(items), ...(reserved ? [reserved] : [])], gap: GAP });
  const at = (id: string) => placed.find((p) => p.id === id);

  return (
    <div className={`viewer-slot${measureTool ? " is-measuring" : ""}`} ref={(el) => { ref(el); setSlot(el); }} onClick={measureTool ? pickFromPointer : undefined}>
      <div className="diagram-host">
        <Diagram scene={scene} roads={roads} vb={vb} sim={sim} poseAt={physics.poseAt} timeS={timeS} showPaths={showPaths} measure={showMeasurements && measureGroups.impact} travel={showMeasurements && measureGroups.travel} />
      </div>
      <div className="street-layer" aria-hidden="true">
        {streets.map((s) => (
          <span key={s.name} className="street-label" style={{ left: s.x, top: s.y, transform: `translate(-50%, -50%) rotate(${-s.angleDeg}deg)` }}>{s.name}</span>
        ))}
      </div>
      {pts.length ? (
        <svg className="measure-two" aria-hidden="true">
          {pts[0] && pts[1] ? <line x1={pts[0].x} y1={pts[0].y} x2={pts[1].x} y2={pts[1].y} className="measure-two-line" /> : null}
          {pts.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={MEASURE_DOT_PX} className="measure-two-dot" />)}
        </svg>
      ) : null}
      <svg className="leaders" aria-hidden="true">
        {placed.filter((p) => p.leader).map((p) => <line key={p.id} x1={p.leader?.x1} y1={p.leader?.y1} x2={p.leader?.x2} y2={p.leader?.y2} className="leader" />)}
      </svg>
      {showLabels ? (
        <div className="label-layer">
          {items.map((i) => {
            const p = at(`v${i.id}`);
            if (!p) return null;
            return (
              <button type="button" key={i.id} className={`vlabel v-${i.id.toLowerCase()}`} data-id={i.id} data-side={p.side} style={{ left: p.x, top: p.y }} onClick={(e) => { if (measureTool) { e.stopPropagation(); pickVehicle(i.id); } else onSelectVehicle?.(i.id); }}>
                <span className="badge-letter">{i.id}</span>
                <span>{i.name} ·</span>
                <span className="num">{i.speed}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      {twoText && at("m2") ? <span className="mpill mpill-two" data-testid="two-point-pill" style={{ left: at("m2")?.x, top: at("m2")?.y }}><span className="num">{twoText}</span></span> : null}
      {pillItems.length ? (
        <div className="measure-pills">
          {pillItems.map((p) => {
            const pl = at(`m${p.n}`);
            return pl ? (
              <span key={p.row.key} className="mpill" style={{ left: pl.x, top: pl.y }}>
                <span className="mnum">{p.n + 1}</span>
                <span className="num">{distanceText(p.row, units)}</span>
              </span>
            ) : null;
          })}
        </div>
      ) : null}
    </div>
  );
}
