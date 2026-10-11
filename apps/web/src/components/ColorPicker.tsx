// The vehicle's colour (round B): twelve common factory colours as named swatches, "Custom" (the browser's own
// colour input) and "Not sure" (no paint: the vehicle's token colour). One radio group with a roving tab stop,
// 44 px targets, the standard focus ring. The swatch fill is the claimant's data, so it reaches CSS only as the
// inline custom property --swatch (lib/paint.ts explains why that is the one exception to "tokens only").
import { useId, type CSSProperties } from "react";
import { CUSTOM_PAINT_NAME, FACTORY_COLORS, customPaint, paintOf, type SceneVehicle, type VehiclePaint } from "@csd/core";
import { RadioGroup, Radio } from "../a11y/roving";
import { Icon } from "../icons/Icon";
import { inkVar } from "../lib/paint";

const UNSURE = "unsure";
const CUSTOM = "custom";
type Choice = string;

const keyOf = (p: VehiclePaint) => p.name.toLowerCase();
const CHOICES: readonly Choice[] = [...FACTORY_COLORS.map(keyOf), CUSTOM, UNSURE];
/** A custom pick starts from the vehicle's current paint, else from the middle grey of the palette. */
const CUSTOM_START = FACTORY_COLORS.find((c) => c.name === "Gray")!.hex;

/** Which choice a vehicle's paint is: a factory swatch only when both its name and hex match. */
export function paintChoice(color: SceneVehicle["color"]): Choice {
  const p = color ? paintOf({ id: "", color }) : null;
  if (!p) return UNSURE;
  const f = FACTORY_COLORS.find((c) => c.name === p.name && c.hex.toLowerCase() === p.hex.toLowerCase());
  return f ? keyOf(f) : CUSTOM;
}

const swatchStyle = (hex: string): CSSProperties => ({ "--swatch": hex, "--paint-ink": inkVar(hex) } as CSSProperties);

export interface ColorPickerProps {
  readonly vehicle: Pick<SceneVehicle, "id" | "color">;
  /** null = "Not sure". */
  readonly onChange: (color: VehiclePaint | null) => void;
}

export function ColorPicker({ vehicle: v, onChange }: ColorPickerProps) {
  const ids = useId();
  const choice = paintChoice(v.color);
  const current = paintOf(v);
  const customHex = choice === CUSTOM && current ? current.hex.toLowerCase() : CUSTOM_START;
  const pick = (c: Choice) => {
    if (c === UNSURE) onChange(null);
    else if (c === CUSTOM) onChange(customPaint(customHex));
    else onChange(FACTORY_COLORS.find((f) => keyOf(f) === c) ?? null);
  };
  return (
    <fieldset className="group paint-picker" data-paint-picker={v.id}>
      <legend className="field-sub" id={`${ids}-legend`}>Colour</legend>
      <RadioGroup className="paint-swatches" aria-labelledby={`${ids}-legend`} aria-describedby={`${ids}-note`} values={CHOICES} value={choice} onChange={pick}>
        {FACTORY_COLORS.map((c) => (
          <Radio key={c.name} value={keyOf(c)} className="paint-swatch" data-paint={c.name}>
            <span className="paint-dot" style={swatchStyle(c.hex)} aria-hidden="true">{choice === keyOf(c) ? <Icon name="check" className="icon-sm" /> : null}</span>
            <span className="paint-name">{c.name}</span>
          </Radio>
        ))}
        <Radio value={CUSTOM} className="paint-swatch" data-paint={CUSTOM_PAINT_NAME}>
          <span className="paint-dot is-custom" style={swatchStyle(customHex)} aria-hidden="true">{choice === CUSTOM ? <Icon name="check" className="icon-sm" /> : <Icon name="plus" className="icon-sm" />}</span>
          <span className="paint-name">Custom</span>
        </Radio>
        <Radio value={UNSURE} className="paint-swatch" data-paint="unsure" aria-label="Not sure of the colour">
          <span className="paint-dot is-unsure" aria-hidden="true">{choice === UNSURE ? <Icon name="check" className="icon-sm" /> : null}</span>
          <span className="paint-name">Not sure</span>
        </Radio>
      </RadioGroup>
      {choice === CUSTOM ? (
        <label className="paint-custom">
          <input type="color" value={customHex} onChange={(e) => { const p = customPaint(e.target.value); if (p) onChange(p); }} />
          <span>Pick the custom colour</span>
        </label>
      ) : null}
      <p className="hint" id={`${ids}-note`}>Shown on the vehicle in the 3D view, the maps and your files. Its letter stays in the {v.id} colour.</p>
    </fieldset>
  );
}
