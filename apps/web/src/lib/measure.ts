// Measurements shown on the Measure tab, in the diagram and in the previews. Every value is read
// from the simulation result and formatted by core's formatter; nothing is typed in.
import { formatDistance, type Range, type SimulationResult, type Units, type Vec2 } from "@csd/core";

/** DESIGN.md section 7: "Distances at impact" and "Travel paths" are the two overlays that carry numbers. */
export type MeasureGroup = "impact" | "travel";
export type MeasureGroups = Readonly<Record<MeasureGroup, boolean>>;

export interface MeasureRow {
  readonly key: string;
  readonly group: MeasureGroup;
  readonly label: string;
  readonly value: Range;
  /** Where the number sits on the diagram, when it has a marker. */
  readonly anchor: Vec2 | null;
  /** For a gap: the two vehicle centers the line is drawn between. */
  readonly between?: readonly [Vec2, Vec2];
}

/** Rows in display order. The first rows (moved after impact, then the gap) are the numbered markers. */
export function measureRows(sim: SimulationResult): MeasureRow[] {
  const rows: MeasureRow[] = [];
  for (const v of sim.vehicles) {
    if (v.postImpactDistanceM.hi < 0.05) continue;
    rows.push({
      key: `moved-${v.id}`,
      group: "impact",
      label: `${v.id} moved after impact`,
      value: v.postImpactDistanceM,
      anchor: { x: (v.impactPose.xM + v.restPose.xM) / 2, y: (v.impactPose.yM + v.restPose.yM) / 2 },
    });
  }
  // sim.gaps lists the pairs that touched. One row for each, between that pair's vehicles; none when it is empty.
  for (const gap of sim.gaps) {
    const a = sim.vehicles.find((v) => v.id === gap.a);
    const b = sim.vehicles.find((v) => v.id === gap.b);
    if (!a || !b) continue;
    rows.push({
      key: `gap-${gap.a}${gap.b}`,
      group: "impact",
      label: `${gap.a} to ${gap.b} at final rest, center to center`,
      value: gap.restGapM,
      anchor: { x: (a.restPose.xM + b.restPose.xM) / 2, y: (a.restPose.yM + b.restPose.yM) / 2 },
      between: [{ x: a.restPose.xM, y: a.restPose.yM }, { x: b.restPose.xM, y: b.restPose.yM }],
    });
  }
  for (const v of sim.vehicles) {
    const start = v.track[0];
    if (v.approachDistanceM.hi > 0.05 && start) {
      // The line runs from where the vehicle was at the start of the picture to where it was at impact.
      const from = { x: start.xM, y: start.yM };
      const to = { x: v.impactPose.xM, y: v.impactPose.yM };
      rows.push({
        key: `approach-${v.id}`,
        group: "travel",
        label: `${v.id}, last ${Math.abs(sim.startTimeS)} s before impact`,
        value: v.approachDistanceM,
        anchor: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 },
        between: [from, to],
      });
    }
  }
  return rows;
}

export const markerRows = (rows: readonly MeasureRow[]): MeasureRow[] => rows.filter((r) => r.anchor != null);

/** The rows currently drawn on the picture (their group is switched on), in marker order. */
export const shownRows = (rows: readonly MeasureRow[], groups: MeasureGroups): MeasureRow[] => rows.filter((r) => r.anchor != null && groups[r.group]);

/** "about 15 ft": every measurement is an estimate (DESIGN.md section 3). */
export const distanceText = (r: MeasureRow, units: Units, both = false): string => `about ${formatDistance(r.value, { both, units }).text}`;

/** True when any speed behind the numbers was "not sure". */
export const hasRanges = (sim: SimulationResult): boolean => sim.vehicles.some((v) => v.speedAtImpactMps.lo !== v.speedAtImpactMps.hi);
