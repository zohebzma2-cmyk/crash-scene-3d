// "About how fast at the moment of the crash?": the speed at impact, in mph. Or "Not sure": then it becomes
// a range around the posted limit (the limit the claimant gives, or a typical city limit when they don't know it).
import { useEffect, useId, useState, type ReactNode } from "react";
import { DEFAULT_LIMIT_MPH, LIMITS, RANGE_HALF_MPH, type SceneSpeed, type SceneVehicle } from "@csd/core";
import { Icon } from "../icons/Icon";
import { useUi } from "../state/Ui";

export const SPEED_STEP_MPH = 5;
/** The speed asked for is the speed at the moment of the crash. */
export const SPEED_QUESTION = "About how fast at the moment of the crash?";

/** The low and high of a "not sure" speed around a limit (null limit = the typical city limit). */
export function unsureRangeMph(limitMph: number | null): { lo: number; mid: number; hi: number } {
  const mid = limitMph ?? DEFAULT_LIMIT_MPH;
  return { lo: Math.max(0, mid - RANGE_HALF_MPH), mid, hi: mid + RANGE_HALF_MPH };
}

// The same words as the scene file uses for a speed it won't take (packages/core scene.ts; a test keeps them equal).
export const SPEED_EMPTY_TEXT = "Enter the speed in mph, like 25, or choose Not sure.";
export const SPEED_NAN_TEXT = "The speed should be a number of mph, like 25.";
export const SPEED_BELOW_TEXT = "The speed can't be below 0 mph.";
export const SPEED_TOO_FAST_TEXT = `That's faster than we can illustrate. Enter ${LIMITS.maxSpeedMph} mph or less.`;
export const SPEED_TENTHS_TEXT = "Use whole or tenths of a mile per hour, like 25 or 25.5.";

/** What was typed in the speed field: a usable speed, or the plain reason it isn't. */
export function parseSpeedText(raw: string): { ok: true; mph: number } | { ok: false; text: string } {
  const s = raw.trim();
  if (s === "") return { ok: false, text: SPEED_EMPTY_TEXT };
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(s)) return { ok: false, text: SPEED_NAN_TEXT };
  const n = Number(s);
  if (n < 0) return { ok: false, text: SPEED_BELOW_TEXT };
  if (n > LIMITS.maxSpeedMph) return { ok: false, text: SPEED_TOO_FAST_TEXT };
  if (Math.abs(n * 10 - Math.round(n * 10)) > 1e-9) return { ok: false, text: SPEED_TENTHS_TEXT };
  return { ok: true, mph: n };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function Stepper({ value, field, unit = "mph", range = false, disabled = false, onStep, labels }: {
  value: string; field?: ReactNode; unit?: string; range?: boolean; disabled?: boolean; onStep: (dir: -1 | 1) => void; labels: [string, string];
}) {
  return (
    <div className="stepper-input" role="group">
      <button className="icon-btn" type="button" aria-label={labels[0]} disabled={disabled} onClick={() => onStep(-1)}><Icon name="minus" /></button>
      {field ?? <output className={`num stepper-value${range ? " range" : ""}`}>{value}</output>}<span className="unit">{unit}</span>
      <button className="icon-btn" type="button" aria-label={labels[1]} disabled={disabled} onClick={() => onStep(1)}><Icon name="plus" /></button>
    </div>
  );
}

export interface SpeedInputProps {
  readonly vehicle: SceneVehicle;
  readonly onChange: (speed: SceneSpeed) => void;
}

export function SpeedInput({ vehicle, onChange }: SpeedInputProps) {
  const speed = vehicle.speed;
  const { setFieldError } = useUi();
  const errorId = useId();
  const fieldKey = `speed-${vehicle.id}`;
  // What is being typed, until it is a usable speed (then the scene's own value shows again). null = show the scene's value.
  const [draft, setDraft] = useState<string | null>(null);
  const problem = draft == null ? null : parseSpeedText(draft);
  const bad = problem != null && !problem.ok ? problem.text : null;
  // Leaving (parked, removed, another step) takes a half-typed value with it, so it can't block anything.
  useEffect(() => () => setFieldError(fieldKey, null), [fieldKey, setFieldError]);
  const settle = (d: string | null) => {
    setDraft(d);
    const r = d == null ? null : parseSpeedText(d);
    setFieldError(fieldKey, r && !r.ok ? { text: r.text, vehicleId: vehicle.id } : null);
    return r;
  };
  // The speed to come back to when "Not sure" is turned off again.
  const [lastKnown, setLastKnown] = useState(speed.kind === "known" ? speed.mph : 25);
  const unsure = speed.kind === "unsure";
  const limit = speed.kind === "unsure" ? speed.limitMph : null;
  const range = unsureRangeMph(limit);
  const street = vehicle.travel.roadName;
  return (
    <div className="group" data-speed-group>
      <p className="group-label">{SPEED_QUESTION}</p>
      <div className="speed-row">
        <Stepper
          value={speed.kind === "known" ? String(speed.mph) : `${range.lo}–${range.hi}`}
          field={speed.kind === "known" ? (
            <input
              className="num stepper-value stepper-field"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              spellCheck={false}
              aria-label={`Speed at impact in mph, vehicle ${vehicle.id}`}
              aria-invalid={bad != null}
              aria-describedby={bad != null ? errorId : undefined}
              value={draft ?? String(speed.mph)}
              onChange={(e) => {
                const r = settle(e.target.value);
                if (r?.ok) onChange({ kind: "known", mph: r.mph });
              }}
              onBlur={() => { if (draft != null && parseSpeedText(draft).ok) settle(null); }}
            />
          ) : undefined}
          range={unsure}
          disabled={unsure}
          labels={[`Slower, vehicle ${vehicle.id}`, `Faster, vehicle ${vehicle.id}`]}
          onStep={(d) => { if (speed.kind !== "known") return; settle(null); onChange({ kind: "known", mph: clamp(speed.mph + d * SPEED_STEP_MPH, 0, LIMITS.maxSpeedMph) }); }}
        />
        <button className="chip" type="button" aria-pressed={unsure} onClick={() => {
          settle(null);
          if (speed.kind === "known") setLastKnown(speed.mph);
          onChange(unsure ? { kind: "known", mph: lastKnown } : { kind: "unsure", limitMph: DEFAULT_LIMIT_MPH });
        }}>Not sure</button>
      </div>
      {bad != null ? <p className="hint field-error" id={errorId} role="alert">{bad}</p> : null}
      {speed.kind === "unsure" ? (
        <div className="limit">
          <p className="field-sub">{street ? `Speed limit on ${street}` : "Speed limit where it was driving"}</p>
          <div className="speed-row">
            <Stepper
              value={limit == null ? "—" : String(limit)}
              disabled={limit == null}
              labels={[`Lower limit, vehicle ${vehicle.id}`, `Higher limit, vehicle ${vehicle.id}`]}
              onStep={(d) => { if (limit != null) onChange({ kind: "unsure", limitMph: clamp(limit + d * SPEED_STEP_MPH, LIMITS.minLimitMph, LIMITS.maxLimitMph) }); }}
            />
            <button className="chip" type="button" aria-pressed={limit == null} onClick={() => onChange({ kind: "unsure", limitMph: limit == null ? DEFAULT_LIMIT_MPH : null })}>I don't know the limit</button>
          </div>
          <p className="hint">
            {limit == null
              ? `We'll show ${range.lo}–${range.hi} mph at the moment of the crash, around ${range.mid} mph, a typical city limit. The picture uses ${range.mid} mph.`
              : `We'll show ${range.lo}–${range.hi} mph at the moment of the crash, around the ${range.mid} mph limit. The picture uses ${range.mid} mph.`}
          </p>
        </div>
      ) : null}
    </div>
  );
}
