// "Which way was it going?" Road-relative when the roads are known ("Northbound on Main Street");
// plain N/E/S/W only when there is no road data. The compass arrow turns to the heading.
import type { SceneVehicle, TravelChoice } from "@csd/core";
import { directionCaption } from "@csd/core";
import { Radio, RadioGroup } from "../a11y/roving";
import { Icon } from "../icons/Icon";
import { selectedChoice } from "../state/doc";
import { ucFirst } from "../lib/text";

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
  readonly choices: readonly TravelChoice[];
  readonly onChange: (travel: SceneVehicle["travel"]) => void;
}

export const NOT_PICKED_TEXT = "Not picked yet";

export function DirectionPicker({ vehicle, picked: isPicked, choices, onChange }: DirectionPickerProps) {
  const t = vehicle.travel;
  const legendId = `dir-legend-${vehicle.id}`;
  const roadAware = choices.length > 0;
  const picked = roadAware && isPicked ? selectedChoice(t, choices) : null;
  const pickedIndex = picked ? choices.indexOf(picked) : null;
  const caption = isPicked ? directionCaption(vehicle) : NOT_PICKED_TEXT;
  const arrow = isPicked ? { rotate: `${t.bearingDeg}deg` } : undefined;
  return (
    <fieldset className="group" data-fix-direction>
      <legend className="group-label" id={legendId}>{directionLegend(vehicle.action)}</legend>
      {roadAware ? (
        <div className="direction direction-roads">
          <RadioGroup className="choices" aria-labelledby={legendId} values={choices.map((_, i) => i)} value={pickedIndex} onChange={(i) => {
            const c = choices[i];
            // An unnamed road keeps its description ("the parking aisle (west one)") for the compass line, summary and PDF.
            if (c) onChange({ ...t, bearingDeg: c.bearingDeg, roadId: c.roadId, roadName: c.roadName, roadDesc: c.roadDesc ?? undefined });
          }}>
            {choices.map((c, i) => <Radio key={`${c.roadId}-${c.bearingDeg}`} value={i} className="choice">{ucFirst(c.label)}</Radio>)}
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
          <RadioGroup className="compass" aria-labelledby={legendId} values={CARDINALS.map((c) => c.deg)} value={isPicked && CARDINALS.some((c) => c.deg === t.bearingDeg) ? t.bearingDeg : null} onChange={(deg) => onChange({ ...t, bearingDeg: deg, roadId: null, roadName: null, roadDesc: undefined })}>
            {CARDINALS.map((c) => <Radio key={c.deg} value={c.deg} aria-label={c.word} data-h={c.deg}>{c.letter}</Radio>)}
            {isPicked ? <span className="compass-center" aria-hidden="true" style={arrow}><Icon name="heading" className="icon-lg" /></span> : null}
          </RadioGroup>
          <p className="dir-caption" aria-live="polite">{caption}</p>
        </div>
      )}
      {!isPicked ? <p className="hint">{roadAware ? "Pick the road and direction it was on." : "Pick the direction it was going."}</p> : roadAware && pickedIndex == null ? <p className="hint">Pick the road and direction it was on.</p> : null}
    </fieldset>
  );
}
