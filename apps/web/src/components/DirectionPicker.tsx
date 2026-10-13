// "Which way was it going?" The choices come from the roads at the pin (core directionChoices): each road's directions
// ("Northbound on Main Street", "Heading northwest on Willow Bend Road"), turns named by the road they come from, and
// "Out of a driveway or parking lot" on either side of the road. Plain N/E/S/W only when there are no mapped roads, and
// then it says so. The compass arrow turns to the heading.
import type { DirectionChoice, SceneVehicle } from "@csd/core";
import { directionCaption } from "@csd/core";
import { Radio, RadioGroup } from "../a11y/roving";
import { Icon } from "../icons/Icon";
import { angleDiffDeg } from "../lib/geometry";

const CARDINALS = [
  { deg: 0, letter: "N", word: "North" },
  { deg: 90, letter: "E", word: "East" },
  { deg: 180, letter: "S", word: "South" },
  { deg: 270, letter: "W", word: "West" },
] as const;

export function directionLegend(action: SceneVehicle["action"]): string {
  switch (action) {
    case "backing": return "Which way was it facing? (It was backing up.)";
    case "parked": return "Which way was it facing?";
    case "turn-left":
    case "turn-right": return "Which way was it heading after the turn?";
    default: return "Which way was it going?";
  }
}

export interface DirectionPickerProps {
  readonly vehicle: SceneVehicle;
  /** False until the claimant picks: nothing is shown as chosen. */
  readonly picked: boolean;
  readonly choices: readonly DirectionChoice[];
  /** A line under a compass fallback ("No mapped roads here, so pick a compass direction."), or null. */
  readonly note?: string | null;
  readonly onChange: (travel: SceneVehicle["travel"]) => void;
}

export const NOT_PICKED_TEXT = "Not picked yet";

/**
 * The choice a vehicle's travel points at, or null: the same road (by id, else by name; none for both), the same kind of start
 * (out of a driveway or not), and a bearing within 25 degrees, the nearest one.
 */
export function pickedChoice(travel: SceneVehicle["travel"], choices: readonly DirectionChoice[]): DirectionChoice | null {
  let best: DirectionChoice | null = null, bestDiff = Infinity;
  for (const c of choices) {
    if ((c.travel.fromDriveway === true) !== (travel.fromDriveway === true)) continue;
    const sameRoad = travel.roadId != null && c.travel.roadId != null ? c.travel.roadId === travel.roadId
      : travel.roadName != null && c.travel.roadName != null ? c.travel.roadName === travel.roadName
        : travel.roadId == null && travel.roadName == null && c.travel.roadId == null;
    if (!sameRoad) continue;
    const d = angleDiffDeg(c.travel.bearingDeg, travel.bearingDeg);
    if (d <= 25 && d < bestDiff) { best = c; bestDiff = d; }
  }
  return best;
}

export function DirectionPicker({ vehicle, picked: isPicked, choices, note = null, onChange }: DirectionPickerProps) {
  const t = vehicle.travel;
  const legendId = `dir-legend-${vehicle.id}`;
  const roadAware = choices.some((c) => c.kind !== "compass");
  const picked = roadAware && isPicked ? pickedChoice(t, choices) : null;
  const pickedIndex = picked ? choices.indexOf(picked) : null;
  const caption = isPicked ? directionCaption(vehicle) : NOT_PICKED_TEXT;
  const arrow = isPicked ? { rotate: `${t.bearingDeg}deg` } : undefined;
  const pick = (c: DirectionChoice) => {
    // An unnamed road keeps its description ("the parking aisle (west one)") for the compass line, summary and PDF; a vehicle
    // out of a driveway or parking lot says so (and only then is fromDriveway set).
    onChange({ ...t, bearingDeg: c.travel.bearingDeg, roadId: c.travel.roadId, roadName: c.travel.roadName, roadDesc: c.travel.roadDesc ?? undefined, fromDriveway: c.travel.fromDriveway });
  };
  return (
    <fieldset className="group" data-fix-direction>
      <legend className="group-label" id={legendId}>{directionLegend(vehicle.action)}</legend>
      {roadAware ? (
        <div className="direction direction-roads">
          <RadioGroup className="choices" aria-labelledby={legendId} values={choices.map((_, i) => i)} value={pickedIndex} onChange={(i) => {
            const c = choices[i];
            if (c) pick(c);
          }}>
            {choices.map((c, i) => <Radio key={`${i}-${c.kind}-${c.travel.roadId ?? "none"}-${c.travel.bearingDeg}`} value={i} className="choice" data-kind={c.kind}>{c.label}</Radio>)}
          </RadioGroup>
          <div className="direction-now">
            <div className="compass compass-static" aria-hidden="true">
              {CARDINALS.map((c) => <span key={c.deg} className="compass-tick" data-h={c.deg}>{c.letter}</span>)}
              {isPicked ? <span className="compass-center" style={arrow}><Icon name="heading" className="icon-lg" /></span> : null}
            </div>
            <p className="dir-caption" aria-live="polite">{caption}</p>
          </div>
        </div>
      ) : (
        <div className="direction">
          <RadioGroup className="compass" aria-labelledby={legendId} values={CARDINALS.map((c) => c.deg)} value={isPicked && CARDINALS.some((c) => c.deg === t.bearingDeg) ? t.bearingDeg : null} onChange={(deg) => onChange({ ...t, bearingDeg: deg, roadId: null, roadName: null, roadDesc: undefined, fromDriveway: undefined })}>
            {CARDINALS.map((c) => <Radio key={c.deg} value={c.deg} aria-label={c.word} data-h={c.deg}>{c.letter}</Radio>)}
            {isPicked ? <span className="compass-center" aria-hidden="true" style={arrow}><Icon name="heading" className="icon-lg" /></span> : null}
          </RadioGroup>
          <p className="dir-caption" aria-live="polite">{caption}</p>
          {note ? <p className="hint" data-compass-note>{note}</p> : null}
        </div>
      )}
      {!isPicked ? <p className="hint">{roadAware ? "Pick the road and direction it was on." : "Pick the direction it was going."}</p> : roadAware && pickedIndex == null ? <p className="hint">Pick the road and direction it was on.</p> : null}
    </fieldset>
  );
}
