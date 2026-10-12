// The vehicle's colour (round B): twelve common factory colours as named swatches, "Custom" (the browser's own
// colour input) and "Not sure" (no paint: the vehicle's token colour). One radio group with a roving tab stop,
// 44 px targets, the standard focus ring. The swatch fill is the claimant's data, so it reaches CSS only as the
// inline custom property --swatch (lib/paint.ts explains why that is the one exception to "tokens only").
import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type RefObject } from "react";
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
  const f = FACTORY_COLORS.find((c) => c.name.toLowerCase() === p.name.trim().toLowerCase() && c.hex.toLowerCase() === p.hex.toLowerCase());
  return f ? keyOf(f) : CUSTOM;
}

const swatchStyle = (hex: string): CSSProperties => ({ "--swatch": hex, "--paint-ink": inkVar(hex) } as CSSProperties);

export interface ColorPickerProps {
  readonly vehicle: Pick<SceneVehicle, "id" | "color">;
  /** null = "Not sure". */
  readonly onChange: (color: VehiclePaint | null) => void;
}

/** Which ends of the swatch row have more swatches past them (phones show the row as one scrolling line). */
function useScrollEnds(): { ref: RefObject<HTMLDivElement | null>; more: { start: boolean; end: boolean }; update: () => void } {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState({ start: false, end: false });
  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // One pixel of slack: zoomed layouts give fractional scroll positions.
    const start = el.scrollLeft > 1;
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setMore((m) => (m.start === start && m.end === end ? m : { start, end }));
  }, []);
  useEffect(() => {
    const el = ref.current;
    // The picked swatch starts in view (Not sure, the default, is the last one); only the row scrolls, never the page.
    const picked = el?.querySelector<HTMLElement>('[aria-checked="true"]');
    if (el && picked && el.scrollWidth > el.clientWidth) el.scrollLeft = picked.offsetLeft - el.offsetLeft - (el.clientWidth - picked.offsetWidth) / 2;
    update();
    if (!el || typeof ResizeObserver !== "function") return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [update]);
  return { ref, more, update };
}

export function ColorPicker({ vehicle: v, onChange }: ColorPickerProps) {
  const ids = useId();
  const { ref: rowRef, more, update: onRowScroll } = useScrollEnds();
  const choice = paintChoice(v.color);
  const current = paintOf(v);
  const customHex = current ? current.hex.toLowerCase() : CUSTOM_START;
  const pick = (c: Choice) => {
    if (c === UNSURE) onChange(null);
    else if (c === CUSTOM) onChange(customPaint(customHex));
    else { const f = FACTORY_COLORS.find((x) => keyOf(x) === c); onChange(f ? { name: f.name, hex: f.hex } : null); }
  };
  return (
    <fieldset className="group paint-picker" data-paint-picker={v.id}>
      <legend className="field-sub" id={`${ids}-legend`}>Colour</legend>
      {/* Phones (under 480 px): one row that scrolls sideways, faded at an end with more swatches past it. */}
      <div className="paint-row" data-more-start={more.start || undefined} data-more-end={more.end || undefined}>
        <RadioGroup
          ref={rowRef} onScroll={onRowScroll}
          // A swatch reached with the arrow keys comes wholly into view, clear of the fades (focus alone leaves a half-shown one).
          onFocus={(e) => e.target.scrollIntoView?.({ block: "nearest", inline: "nearest" })}
          className="paint-swatches" aria-labelledby={`${ids}-legend`} aria-describedby={`${ids}-note`} values={CHOICES} value={choice} onChange={pick}>
          {FACTORY_COLORS.map((c) => (
            <Radio key={c.name} value={keyOf(c)} className="paint-swatch" data-paint={c.name}>
              <span className="paint-dot" style={swatchStyle(c.hex)} aria-hidden="true">{choice === keyOf(c) ? <Icon name="check" className="icon-sm" /> : null}</span>
              <span className="paint-name">{c.name}</span>
            </Radio>
          ))}
          <Radio value={CUSTOM} className="paint-swatch" data-paint={CUSTOM_PAINT_NAME}>
            <span className="paint-dot is-custom" style={choice === CUSTOM ? swatchStyle(customHex) : undefined} aria-hidden="true">{choice === CUSTOM ? <Icon name="check" className="icon-sm" /> : <Icon name="plus" className="icon-sm" />}</span>
            <span className="paint-name">Custom</span>
          </Radio>
          <Radio value={UNSURE} className="paint-swatch" data-paint="unsure" aria-label="Not sure of the colour">
            <span className="paint-dot is-unsure" aria-hidden="true">{choice === UNSURE ? <Icon name="check" className="icon-sm" /> : null}</span>
            <span className="paint-name">Not sure</span>
          </Radio>
        </RadioGroup>
      </div>
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
