// Step 3: does this match what happened? The viewer slot, the timeline, and the Vehicles / Measure /
// View tabs. On phones the panel is a bottom sheet and the primary action is fixed at its foot.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PRESETS, ROAD_WORDS, formatDistance, PLACE_WORDS, ZONE_WORDS, directionCaption, formatSpeed, joinClauses, vehicleName,
  type SimulationResult, type Units, type Scene,
} from "@csd/core";
import type { Vec2 } from "@csd/core";
import { Radio, RadioGroup, Tab, TabList, TabPanel } from "../a11y/roving";
import { Icon } from "../icons/Icon";
import { prefersReducedMotion, usePhone } from "../lib/dom";
import { distanceText, hasRanges, measureRows, shownRows } from "../lib/measure";
import { roleName, sceneSummary } from "../lib/text";
import { useDoc } from "../state/DocProvider";
import { useFlow } from "../state/Flow";
import type { GateProblem } from "../state/Flow";
import { useRoads } from "../state/Roads";
import { useUi } from "../state/Ui";
import type { CameraView, ViewerHandle } from "../viewer/types";
import { Timeline, useTimeline } from "./Timeline";
import { useSimulation } from "./useSimulation";
import { SceneView } from "./SceneView";
import { STILL_SIZE, keepStills } from "./stills";
import { Tips } from "../tips/Tips";
import { CompactWarnings } from "../components/Warnings";
import { RefusalFixes } from "./RefusalFixes";
import { ViewerStatus } from "./ViewerStatus";
import { hasWebGL, loadViewer } from "../viewer/load-viewer";
import { prepareRoadArt } from "../lib/roadArt";
import { preloadStep } from "../steps";

const VIEWS: ReadonlyArray<{ id: CameraView; label: string }> = [
  { id: "top", label: "Top" },
  { id: "wide", label: "Wide" },
  { id: "driver-a", label: "Driver A" },
  { id: "driver-b", label: "Driver B" },
];
/** On a phone only Top and Wide show, as in the prototype; the driver views need the room. */
const PHONE_VIEWS: readonly CameraView[] = ["top", "wide"];
const VIEW_KEYS: Record<string, CameraView> = { "1": "top", "2": "wide", "3": "driver-a", "4": "driver-b", "5": "aftermath", a: "aftermath" };

/** The approach plays once on the first visit; later visits open at the moment of impact. */
let approachPlayed = false;
export const resetApproachPlayed = (): void => { approachPlayed = false; };

/**
 * The picture's box before there is a scene to draw (an example's scene file and its roads on their way):
 * the same place and size as the picture, with the loading status in it. The 3D code starts loading now.
 */
export function ReviewSkeleton({ exampleLoading = false }: { exampleLoading?: boolean }) {
  const [webgl] = useState(hasWebGL);
  useEffect(() => { if (webgl) void loadViewer().catch(() => undefined); }, [webgl]);
  return (
    <div className="viewer-layout" data-testid="review-skeleton">
      <div className="viewer">
        <div className="viewer-canvas is-skeleton">
          <ViewerStatus scene="waiting" webgl={webgl} exampleLoading={exampleLoading} />
        </div>
      </div>
    </div>
  );
}

export function ReviewStep() {
  const { doc } = useDoc();
  const flow = useFlow();
  const scene = doc.scene;
  const outcome = useSimulation(scene);
  const roads = useRoads();
  // The road art is the heaviest step before the first 3D frame: build it while the 3D code downloads
  // (only when there will be a 3D picture of this scene).
  const draws = outcome?.ok === true;
  useEffect(() => (draws && hasWebGL() ? prepareRoadArt(roads.net) : undefined), [draws, roads.net]);

  return (
    <section aria-labelledby="h-review">
      <div className="review-head">
        <h1 className="title" id="h-review" tabIndex={-1}>Does this match what happened?</h1>
        {outcome?.ok ? <ReviewWarnings sim={outcome.result} problems={flow.problems} onEdit={() => flow.go("vehicles")} /> : null}
        {outcome?.ok ? <Tips step="review" /> : null}
      </div>
      {outcome == null ? <ReviewSkeleton /> : null}
      {outcome && !outcome.ok ? <RefusalFixes scene={scene} roads={roads.net} errors={outcome.errors} /> : null}
      {outcome?.ok ? <ReviewBody scene={scene} sim={outcome.result} /> : null}
    </section>
  );
}

/**
 * The physics' own warnings (e.g. "…so the picture uses the front right instead") come first, since they say
 * what the picture actually shows; then the gate's problems. The same sentence is listed once (DESIGN.md section 18).
 */
function ReviewWarnings({ sim, problems, onEdit }: { sim: SimulationResult; problems: readonly GateProblem[]; onEdit: () => void }) {
  const all = useMemo(() => {
    // A zone-used note says what the picture actually shows, so it leads.
    const ordered = [...sim.warnings].sort((a, b) => Number(b.code === "zone-used") - Number(a.code === "zone-used"));
    const fromSim: GateProblem[] = ordered.map((w) => ({ text: w.text, step: "vehicles", blocking: false, vehicleIds: w.vehicleIds }));
    const seen = new Set<string>();
    return [...fromSim, ...problems].filter((p) => (seen.has(p.text) ? false : (seen.add(p.text), true)));
  }, [sim, problems]);
  return all.length > 0 ? <CompactWarnings problems={all} onEdit={onEdit} /> : null;
}

function vehicleSpeedText(sim: SimulationResult, id: string, parked: boolean, unsure: boolean, units: Units): string | null {
  if (parked) return null;
  const r = sim.vehicles.find((v) => v.id === id);
  if (!r) return null;
  return `${unsure ? "not sure, " : ""}about ${formatSpeed(r.speedAtImpactMps, { units }).text}`;
}

function ReviewBody({ scene, sim }: { scene: Scene; sim: SimulationResult }) {
  const roads = useRoads();
  const flow = useFlow();
  const { units, setUnits } = useUi();
  const phone = usePhone();
  const t0 = sim.startTimeS;
  const t1 = sim.restTimeS;
  const reduced = prefersReducedMotion();
  const timeline = useTimeline(t0, t1, { startAtImpact: true, reducedMotion: reduced });
  const t = Math.min(t1, Math.max(t0, timeline.t));
  const [view, setView] = useState<CameraView>("top");
  const shownViews = phone ? VIEWS.filter((v) => PHONE_VIEWS.includes(v.id)) : VIEWS;
  // Narrowing to a phone while a driver view is selected falls back to Top.
  // Aftermath is not one of the four presets: it has its own button on the timeline (and keys 5 / A), so no preset shows as selected.
  const shownView: CameraView = view === "aftermath" ? view : shownViews.some((v) => v.id === view) ? view : "top";
  const [tab, setTab] = useState("vehicles");
  const [labels, setLabels] = useState(true);
  const [paths, setPaths] = useState(true);
  // DESIGN.md section 7: the measurement overlays are off until switched on.
  const [distances, setDistances] = useState(false);
  const [travel, setTravel] = useState(false);
  const [twoPoint, setTwoPoint] = useState(false);
  const [points, setPoints] = useState<readonly Vec2[]>([]);
  const measure = distances || travel;
  const [selected, setSelected] = useState<string | null>(null);

  const { playApproach } = timeline;
  useEffect(() => {
    // Opens at impact. The first visit plays the approach once, unless motion is reduced or this is a test browser.
    if (approachPlayed || reduced || navigator.webdriver) return;
    approachPlayed = true;
    playApproach();
  }, [reduced, playApproach]);

  const rows = useMemo(() => measureRows(sim), [sim]);
  const groups = { impact: distances, travel };
  const shown = shownRows(rows, groups);
  const canvasRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<ViewerHandle | null>(null);
  /** Set once the 3D view has drawn its first frame (or the 2D fallback is shown): e2e and assistive tech can wait on it. */
  const [viewerReady, setViewerReady] = useState(false);
  // Once the picture is up, the next screens' code (save, or back to edit) loads in the background.
  const markReady = useCallback(() => { setViewerReady(true); preloadStep("export"); preloadStep("vehicles"); }, []);
  const [saving, setSaving] = useState(false);

  // The export stills are taken here, while the 3D view exists: the moment of impact (Wide camera) and final rest (the Aftermath view).
  const saveIt = async () => {
    setSaving(true);
    try {
      const v = viewerRef.current;
      if (v) {
        const impact = await v.captureStill(0, "wide", STILL_SIZE).catch(() => undefined);
        const rest = await v.captureStill(sim.restTimeS, "aftermath", STILL_SIZE).catch(() => undefined);
        keepStills(scene, { ...(impact ? { impact } : {}), ...(rest ? { rest } : {}) });
      }
    } finally {
      setSaving(false);
      flow.go("export");
    }
  };

  // One focus target for the whole picture: it handles the timeline and view keys itself and hands the
  // camera keys (arrows, + and -, R) to the 3D view.
  const onCanvasKey = (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === " ") { e.preventDefault(); timeline.toggle(); }
    else if (e.key.toLowerCase() === "i") timeline.seek(0);
    else if (VIEW_KEYS[e.key]) { const next = VIEW_KEYS[e.key] as CameraView; if (next === "aftermath" || shownViews.some((v) => v.id === next)) chooseView(next); }
    else viewerRef.current?.handleKey?.(e);
  };

  // On phones the numbers live in the Measure tab (pills would cover the small view), so it opens by itself.
  const opening = (on: boolean) => { if (on && phone) setTab("measure"); };
  const pickDistances = (on: boolean) => { setDistances(on); opening(on); };
  const pickTravel = (on: boolean) => { setTravel(on); opening(on); };
  const pickTwoPoint = (on: boolean) => { setTwoPoint(on); setPoints([]); opening(on); };
  // The Aftermath view: final rest, with the distances on (both cars where they stopped, the marks, the debris, the ring).
  const chooseView = (next: CameraView) => {
    setView(next);
    if (next === "aftermath") { timeline.seek(t1); pickDistances(true); }
  };
  const addPoint = (p: Vec2) => setPoints((prev) => (prev.length >= 2 ? [p] : [...prev, p]));
  const twoPointMeters = points.length === 2 ? Math.hypot((points[0]?.x ?? 0) - (points[1]?.x ?? 0), (points[0]?.y ?? 0) - (points[1]?.y ?? 0)) : null;

  return (
    <div className="viewer-layout">
      <div className="viewer">
        <div ref={canvasRef} className="viewer-canvas" data-ready={viewerReady ? "true" : undefined} tabIndex={0} role="application" aria-roledescription="illustration" aria-label="Illustration of the crash. Space plays, I jumps to impact, 1 to 5 pick a view, A is the Aftermath view, arrow keys turn the view, plus and minus zoom, R resets the view." onKeyDown={onCanvasKey}>
          <SceneView
            ref={viewerRef} phone={phone}
            scene={scene} roads={roads.net} sim={sim} timeS={t} view={shownView}
            showLabels={labels} showMeasurements={measure} showPaths={paths} units={units} reducedMotion={reduced}
            measureGroups={groups} measureTool={twoPoint} measurePoints={points} onMeasurePoint={addPoint}
            onSelectVehicle={(id) => { setSelected(id); setTab("vehicles"); }}
            onReady={markReady}
          />
          <RadioGroup className="view-controls" aria-label="View" values={shownViews.map((v) => v.id)} value={shownView === "aftermath" ? null : shownView} onChange={chooseView}>
            {shownViews.map((v) => <Radio key={v.id} value={v.id} className="seg">{v.label}</Radio>)}
          </RadioGroup>
          <span className="scene-caption">{view === "aftermath" ? "Aftermath" : VIEWS.find((v) => v.id === view)?.label ?? ""} view</span>
        </div>
        <Timeline api={{ ...timeline, t }} t0={t0} t1={t1} onAftermath={() => chooseView("aftermath")} aftermathOn={shownView === "aftermath"} />
      </div>

      <aside className="panel" aria-label="Scene details">
        <span className="sheet-handle" aria-hidden="true" />
        <TabList className="tabs" value={tab} onChange={setTab} idBase="review" aria-label="Scene details">
          <Tab className="tab" value="vehicles">Vehicles</Tab>
          <Tab className="tab" value="measure">Measure</Tab>
          <Tab className="tab" value="view">View</Tab>
        </TabList>

        <TabPanel className="panel-body" idBase="review" value="vehicles" current={tab}>
          <ul className="summary-list">
            {scene.vehicles.map((v) => {
              const speed = vehicleSpeedText(sim, v.id, v.action === "parked", v.speed.kind === "unsure", units);
              return (
                <li key={v.id} className={`summary-item v-${v.id.toLowerCase()}`} data-selected={selected === v.id || undefined}>
                  <span className="badge-letter">{v.id}</span>
                  <div>
                    <h2>{roleName(v)} · {vehicleName(v) ?? PRESETS[v.type].label}</h2>
                    <p>{[directionCaption(v), speed, v.braking && v.action !== "parked" ? "braking" : null].filter(Boolean).join(" · ")}</p>
                    <p>Hit on the {ZONE_WORDS[v.zone]}</p>
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="summary-road"><Icon name={`road-${scene.road.condition}`} className="icon-sm" />{joinClauses([PLACE_WORDS[scene.location.place], `${ROAD_WORDS[scene.road.condition]} road`])}</p>
          <p className="summary-text" aria-live="polite" data-testid="scene-summary">{sceneSummary(scene, sim, units)}</p>
        </TabPanel>

        <TabPanel className="panel-body" idBase="review" value="measure" current={tab}>
          <label className="switch-row"><span>Distances at impact</span><input className="switch" type="checkbox" checked={distances} onChange={(e) => pickDistances(e.target.checked)} /></label>
          <label className="switch-row"><span>Travel paths</span><input className="switch" type="checkbox" checked={travel} onChange={(e) => pickTravel(e.target.checked)} /></label>
          <div className="two-point">
            <label className="switch-row"><span>Measure two points</span><input className="switch" type="checkbox" checked={twoPoint} onChange={(e) => pickTwoPoint(e.target.checked)} /></label>
            {twoPoint ? (
              <>
                <p className="hint" aria-live="polite">{points.length === 0 ? "Tap the first spot on the picture, or a vehicle's label." : points.length === 1 ? "Now tap the second spot." : "Tap again to start a new measurement."}</p>
                {twoPointMeters != null ? (
                  <p className="two-point-result">
                    <span className="num" data-testid="two-point-value">{`about ${formatDistance(twoPointMeters, { both: false, units }).text}`}</span>
                    <button type="button" className="link-btn" onClick={() => setPoints([])}>Clear</button>
                  </p>
                ) : null}
              </>
            ) : null}
          </div>
          <dl className="measure-list">
            {rows.map((r) => (
              <div key={r.key}>
                <dt>{shown.includes(r) ? <span className="mnum">{shown.indexOf(r) + 1}</span> : null}{r.label}</dt>
                <dd><span className="num">{distanceText(r, units)}</span></dd>
              </div>
            ))}
          </dl>
          <p className="hint">{hasRanges(sim) ? "Ranges come from the speeds you weren't sure of. The picture uses the middle value." : "Dashed outlines on the picture show where each vehicle ends up."}</p>
        </TabPanel>

        <TabPanel className="panel-body" idBase="review" value="view" current={tab}>
          <label className="switch-row"><span>Vehicle labels</span><input className="switch" type="checkbox" checked={labels} onChange={(e) => setLabels(e.target.checked)} /></label>
          <label className="switch-row"><span>Paths</span><input className="switch" type="checkbox" checked={paths} onChange={(e) => setPaths(e.target.checked)} /></label>
          <div className="group">
            <p className="group-label" id="units-label">Units on screen</p>
            <RadioGroup className="segmented" aria-labelledby="units-label" values={["us", "metric"] as const} value={units} onChange={setUnits}>
              <Radio value="us">ft · mph</Radio>
              <Radio value="metric">m · km/h</Radio>
            </RadioGroup>
          </div>
          <p className="hint">Keys: <kbd>Space</kbd> play · <kbd>←</kbd><kbd>→</kbd> step · <kbd>Home</kbd><kbd>End</kbd> · <kbd>I</kbd> impact · <kbd>1</kbd>–<kbd>5</kbd> views</p>
        </TabPanel>

        <div className="panel-foot">
          <button type="button" className="btn btn-primary" onClick={() => void saveIt()} disabled={saving} aria-busy={saving}>Looks right: save it</button>
          <button type="button" className="btn btn-quiet" onClick={() => flow.go("vehicles")}>Edit details</button>
        </div>
      </aside>
    </div>
  );
}
