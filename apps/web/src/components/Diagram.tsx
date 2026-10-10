// Top-down diagram as React SVG elements (no strings, no innerHTML). Built from the scene, the road
// network (or a plain template when there is none) and the simulation result. Geometry is data in
// meters; colors, fonts and line styles come from CSS classes that use tokens.
import { memo, useMemo } from "react";
import type { Building, RoadNetwork, RoadWay, Scene, SimulationResult, Vec2, VehicleResult, VehicleType } from "@csd/core";
import { offsetPolyline } from "../lib/geometry";
import { templateAxes } from "../lib/streets";
import type { PoseFn, ViewBox } from "../lib/diagramView";

const BIG = 400;
/** Half the width of the template road (two lanes). */
const TEMPLATE_HALF_M = 3.6;

const pts = (list: readonly Vec2[]) => list.map((p) => `${p.x.toFixed(2)},${(-p.y).toFixed(2)}`).join(" ");
const deg = (rad: number) => (rad * 180) / Math.PI;

/* ---------- Vehicle silhouettes (front is up in the vehicle frame), matching the icon set ---------- */

export function VehicleShape({ type, length: L, width: W, cls }: { type: VehicleType; length: number; width: number; cls: "d-veh-body" | "d-ghost-body" }) {
  const x0 = -W / 2;
  const y0 = -L / 2;
  const line = (d: string, key: string) => <path key={key} d={d} className="d-veh-line" strokeWidth={0.14} fill="none" />;
  const rx = Math.min(W * 0.3, 0.6);
  if (type === "motorcycle") {
    return (
      <>
        <rect x={-0.18} y={y0} width={0.36} height={0.65} rx={0.18} className={cls} />
        <rect x={-0.18} y={L / 2 - 0.65} width={0.36} height={0.65} rx={0.18} className={cls} />
        <rect x={-0.22} y={-0.55} width={0.44} height={1.25} rx={0.22} className={cls} />
        <path d={`M${-W / 2} ${y0 + 0.75}H${W / 2}`} className={`${cls}-stroke`} strokeWidth={0.16} fill="none" />
      </>
    );
  }
  if (type === "truck") {
    return (
      <>
        <rect x={x0 + 0.05} y={y0} width={W - 0.1} height={L * 0.22} rx={0.35} className={cls} />
        <rect x={x0} y={y0 + L * 0.25} width={W} height={L * 0.75} rx={0.15} className={cls} />
        {line(`M${x0 + 0.3} ${y0 + L * 0.09}H${-x0 - 0.3}`, "w")}
      </>
    );
  }
  return (
    <>
      <rect x={x0} y={y0} width={W} height={L} rx={type === "car" ? rx : rx * 0.7} className={cls} />
      {type === "car" ? [line(`M${x0 + 0.25} ${y0 + L * 0.3}Q0 ${y0 + L * 0.24} ${-x0 - 0.25} ${y0 + L * 0.3}`, "a"), line(`M${x0 + 0.3} ${y0 + L * 0.84}Q0 ${y0 + L * 0.88} ${-x0 - 0.3} ${y0 + L * 0.84}`, "b")] : null}
      {type === "suv" ? [line(`M${x0 + 0.25} ${y0 + L * 0.26}H${-x0 - 0.25}`, "a"), line(`M${x0 + W * 0.22} ${y0 + L * 0.4}V${y0 + L * 0.88}M${-x0 - W * 0.22} ${y0 + L * 0.4}V${y0 + L * 0.88}`, "b")] : null}
      {type === "pickup" ? [line(`M${x0 + 0.25} ${y0 + L * 0.22}H${-x0 - 0.25}`, "a"), line(`M${x0} ${y0 + L * 0.45}H${-x0}`, "b"), <rect key="c" x={x0 + W * 0.2} y={y0 + L * 0.52} width={W * 0.6} height={L * 0.4} rx={0.1} className="d-veh-line" strokeWidth={0.14} fill="none" />] : null}
      {type === "van" ? [line(`M${x0 + 0.25} ${y0 + L * 0.13}Q0 ${y0 + L * 0.09} ${-x0 - 0.25} ${y0 + L * 0.13}`, "a"), ...[0.38, 0.58, 0.78].map((k) => line(`M${x0 + W * 0.2} ${y0 + L * k}H${-x0 - W * 0.2}`, `r${k}`))] : null}
    </>
  );
}

/* ---------- Ground ---------- */

const ROAD_ORDER: Record<string, number> = { parking_aisle: 0, service: 1, other: 2, unclassified: 3, residential: 4, tertiary: 5, secondary: 6, primary: 7, trunk: 8, motorway: 9 };

interface Ribbon { way: RoadWay; width: number; center: Vec2[] }
function ribbon(way: RoadWay): Ribbon {
  const lw = way.laneWidthM;
  const f = Math.max(0, way.lanesForward);
  const b = Math.max(0, way.lanesBackward);
  const n = Math.max(1, f + b);
  const shift = way.oneway ? 0 : ((f - b) * lw) / 2;
  return { way, width: n * lw, center: shift === 0 ? [...way.centerline] : offsetPolyline(way.centerline, shift) };
}

/** Lane-divider offsets from the way's own centerline, meters to the right of travel. */
function dividerOffsets(way: RoadWay): { offset: number; center: boolean }[] {
  const lw = way.laneWidthM;
  const out: { offset: number; center: boolean }[] = [];
  if (way.oneway) {
    for (let i = 1; i < way.lanesForward; i++) out.push({ offset: (i - way.lanesForward / 2) * lw, center: false });
  } else {
    for (let k = -(way.lanesBackward - 1); k <= way.lanesForward - 1; k++) out.push({ offset: k * lw, center: k === 0 });
    if (way.lanesBackward === 0 || way.lanesForward === 0) return out.filter((o) => !o.center);
  }
  return out;
}

const RoadsLayer = memo(function RoadsLayer({ roads }: { roads: RoadNetwork }) {
  const ribbons = useMemo(() => [...roads.ways].sort((a, b) => (ROAD_ORDER[a.kind] ?? 2) - (ROAD_ORDER[b.kind] ?? 2)).map(ribbon), [roads]);
  return (
    <g>
      {roads.parking.map((p) => <polygon key={p.id} points={pts(p.outline)} className="d-lot" />)}
      {roads.buildings.map((b: Building) => <polygon key={b.id} points={pts(b.footprint)} className="d-building" strokeWidth={0.2} />)}
      {ribbons.map((r) => <polyline key={`c${r.way.id}`} points={pts(r.center)} className="d-curb-under" strokeWidth={r.width + 0.5} />)}
      {ribbons.map((r) => <polyline key={`r${r.way.id}`} points={pts(r.center)} className="d-road-line" strokeWidth={r.width} />)}
      {ribbons.filter((r) => r.way.kind !== "parking_aisle").flatMap((r) => dividerOffsets(r.way).map((d) => (
        <polyline key={`p${r.way.id}${d.offset}`} points={pts(offsetPolyline(r.way.centerline, d.offset))} className="d-paint" strokeWidth={d.center ? 0.18 : 0.14} strokeDasharray={d.center ? undefined : "3 3"} />
      )))}
    </g>
  );
});

function TemplateLayer({ place, axes }: { place: Scene["location"]["place"]; axes: readonly number[] }) {
  const roadAxes = place === "road" ? axes.slice(0, 1) : axes;
  const half = TEMPLATE_HALF_M;
  return (
    <g>
      {place === "parking" ? <rect x={-BIG} y={-BIG} width={BIG * 2} height={BIG * 2} className="d-lot" /> : null}
      {roadAxes.map((a) => (
        <g key={a} transform={`rotate(${a})`}>
          <rect x={-half - 0.25} y={-BIG} width={half * 2 + 0.5} height={BIG * 2} className="d-curb-rect" />
          <rect x={-half} y={-BIG} width={half * 2} height={BIG * 2} className={place === "parking" ? "d-lot-aisle" : "d-road"} />
          <path d={`M0 ${-BIG}V${BIG}`} className="d-paint" strokeWidth={0.15} strokeDasharray="3 2" fill="none" />
        </g>
      ))}
    </g>
  );
}

export interface GroundProps {
  readonly scene: Scene;
  readonly roads: RoadNetwork | null;
  readonly vb: ViewBox;
}

export const Ground = memo(function Ground({ scene, roads }: GroundProps) {
  const axes = useMemo(() => templateAxes(scene.vehicles), [scene.vehicles]);
  return (
    <g>
      <rect x={-BIG} y={-BIG} width={BIG * 2} height={BIG * 2} className="d-ground" />
      {roads ? <RoadsLayer roads={roads} /> : <TemplateLayer place={scene.location.place} axes={axes} />}
    </g>
  );
});

/* ---------- Actors: paths, impact, ghosts, vehicles ---------- */

export interface ActorsProps {
  readonly sim: SimulationResult;
  readonly poseAt: PoseFn;
  readonly timeS: number;
  readonly showPaths: boolean;
  /** Rest outlines and measurement lines. */
  readonly measure: boolean;
  /** Letter on each vehicle (for pictures that don't have labels). */
  readonly tags?: boolean;
  /** Numbered markers on the measurements. */
  readonly markers?: boolean;
  /** Lines along each approach ("Travel paths"). */
  readonly travel?: boolean;
  readonly anchors?: ReadonlyArray<Vec2>;
}

const vcls = (id: string) => `v-${id.toLowerCase()}`;

function pathPoints(v: VehicleResult, sim: SimulationResult, from: "approach" | "after"): string {
  const impactIdx = Math.round(-sim.startTimeS / sim.dtS);
  const slice = from === "approach" ? v.track.slice(0, impactIdx + 1) : v.track.slice(impactIdx);
  return slice.filter((_, i) => i % 3 === 0 || i === slice.length - 1).map((p) => `${p.xM.toFixed(2)},${(-p.yM).toFixed(2)}`).join(" ");
}

export function Actors({ sim, poseAt, timeS, showPaths, measure, travel = false, tags = false, markers = false, anchors = [] }: ActorsProps) {
  const rows = sim.vehicles;
  return (
    <g>
      {showPaths ? (
        <g className="d-paths">
          {rows.map((v) => (v.speedAtImpactMps.mid > 0.01 ? <polyline key={`a${v.id}`} points={pathPoints(v, sim, "approach")} className={`d-path ${vcls(v.id)}`} strokeWidth={0.18} strokeDasharray="0.8 0.6" fill="none" /> : null))}
          {rows.map((v) => (v.postImpactDistanceM.mid > 0.05 ? <polyline key={`p${v.id}`} points={pathPoints(v, sim, "after")} className={`d-path ${vcls(v.id)}`} strokeWidth={0.18} fill="none" /> : null))}
        </g>
      ) : null}
      <circle cx={sim.impactPointM.x} cy={-sim.impactPointM.y} r={1.1} className="d-impact" strokeWidth={0.25} fill="none" />
      <circle cx={sim.impactPointM.x} cy={-sim.impactPointM.y} r={0.3} className="d-impact-dot" />
      {measure ? rows.map((v) => (
        <g key={`g${v.id}`} className={`${vcls(v.id)} d-ghost`} transform={`translate(${v.restPose.xM.toFixed(2)} ${(-v.restPose.yM).toFixed(2)}) rotate(${deg(v.restPose.headingRad).toFixed(1)})`}>
          <VehicleShape type={v.type} length={v.lengthM} width={v.widthM} cls="d-ghost-body" />
        </g>
      )) : null}
      {travel ? (
        <g className="d-measure d-travel">
          {rows.filter((v) => v.approachDistanceM.hi > 0.05 && v.track[0]).map((v) => <path key={`t${v.id}`} d={`M${v.track[0]?.xM} ${-(v.track[0]?.yM ?? 0)}L${v.impactPose.xM} ${-v.impactPose.yM}`} className="d-measure-line d-travel-line" strokeWidth={0.12} fill="none" />)}
        </g>
      ) : null}
      {measure ? (
        <g className="d-measure">
          {rows.filter((v) => v.postImpactDistanceM.mid >= 0.05).map((v) => <path key={`m${v.id}`} d={`M${v.impactPose.xM} ${-v.impactPose.yM}L${v.restPose.xM} ${-v.restPose.yM}`} className="d-measure-line" strokeWidth={0.12} fill="none" />)}
          {sim.gaps.flatMap((gap) => {
            const a = rows.find((v) => v.id === gap.a);
            const b = rows.find((v) => v.id === gap.b);
            return a && b ? [<path key={`gap${gap.a}${gap.b}`} d={`M${a.restPose.xM} ${-a.restPose.yM}L${b.restPose.xM} ${-b.restPose.yM}`} className="d-measure-line d-gap-line" strokeWidth={0.12} strokeDasharray="0.5 0.4" fill="none" />] : [];
          })}
          {markers ? anchors.map((a, i) => (
            <g key={`k${i}`}>
              <circle cx={a.x} cy={-a.y} r={0.85} className="d-marker" />
              <text x={a.x} y={-a.y + 0.36} className="d-marker-text" fontSize={1.0} textAnchor="middle">{i + 1}</text>
            </g>
          )) : null}
        </g>
      ) : null}
      {rows.map((v) => {
        const p = poseAt(sim, v, timeS);
        return (
          <g key={v.id} className={`${vcls(v.id)} d-veh`} data-veh={v.id} transform={`translate(${p.xM.toFixed(2)} ${(-p.yM).toFixed(2)}) rotate(${deg(p.headingRad).toFixed(1)})`}>
            <VehicleShape type={v.type} length={v.lengthM} width={v.widthM} cls="d-veh-body" />
            {tags ? (
              <>
                <circle r={Math.min(0.75, v.widthM * 0.42)} className="d-tag" />
                <text y={0.38} className="d-tag-text" fontSize={1.05} textAnchor="middle" transform={`rotate(${(-deg(p.headingRad)).toFixed(1)})`}>{v.id}</text>
              </>
            ) : null}
          </g>
        );
      })}
    </g>
  );
}

export interface DiagramProps extends GroundProps, ActorsProps {
  readonly title?: string;
}

/** The whole diagram as one SVG. `vb` frames it; overlays use the same `vb` to place labels. */
export function Diagram({ scene, roads, vb, title = "Top-down picture of the vehicles from the details you entered", ...actors }: DiagramProps) {
  return (
    <svg className="diagram" viewBox={`${vb.x.toFixed(2)} ${vb.y.toFixed(2)} ${vb.w.toFixed(2)} ${vb.h.toFixed(2)}`} preserveAspectRatio="xMidYMid meet" role="img">
      <title>{title}</title>
      <Ground scene={scene} roads={roads} vb={vb} />
      <Actors {...actors} />
    </svg>
  );
}

