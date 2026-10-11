// One vehicle: letter badge, year/make/model with a vPIC lookup, type, what it was doing,
// direction, speed and where it was hit. Editing vehicle A never changes the claim header.
import { useEffect, useId, useRef, useState } from "react";
import { ACTIONS, PRESETS, VEHICLE_TYPES, vehicleName, type Action, type SceneVehicle, type VehicleModelResult, type VehicleType } from "@csd/core";
import { RadioGroup } from "../a11y/roving";
import { Icon } from "../icons/Icon";
import { roleName } from "../lib/text";
import { useServices } from "../services/context";
import { ServiceError } from "../services/types";
import { useDoc } from "../state/DocProvider";
import { useRoads } from "../state/Roads";
import { DirectionPicker } from "./DirectionPicker";
import { ImpactZones } from "./ImpactZones";
import { MakeLogo } from "./MakeLogo";
import { VehiclePhoto } from "./VehiclePhoto";
import { SpeedInput } from "./SpeedInput";
import { Tile } from "./Tile";

const ACTION_TILES: Record<Action, { icon: string; label: string }> = {
  straight: { icon: "act-straight", label: "Straight" },
  "turn-left": { icon: "act-left", label: "Turning left" },
  "turn-right": { icon: "act-right", label: "Turning right" },
  backing: { icon: "act-backing", label: "Backing up" },
  parked: { icon: "act-parked", label: "Parked" },
};

/** DESIGN.md doesn't specify a braking control; a plain checkbox, off unless the claimant says so (the physics assumes no braking). */
export const BRAKING_LABEL = "Braking just before the crash";
export const LOOKUP_DEBOUNCE_MS = 450;
/** vPIC has no models before this model year. */
export const FIRST_VPIC_YEAR = 1981;

type Lookup =
  | { key: string; state: "ok"; models: VehicleModelResult[] }
  | { key: string; state: "warn"; text: string; models: VehicleModelResult[] };

const lookupKey = (v: Pick<SceneVehicle, "year" | "make">) => `${v.year ?? ""}|${v.make.trim().toLowerCase()}`;

export interface VehicleCardProps {
  readonly vehicle: SceneVehicle;
  readonly canRemove: boolean;
  /** Has the claimant picked the direction yet? */
  readonly directionSet: boolean;
  readonly onRemove: () => void;
}

export function VehicleCard({ vehicle: v, canRemove, directionSet, onRemove }: VehicleCardProps) {
  const { doc, dispatch } = useDoc();
  const { vehicles } = useServices();
  const roads = useRoads();
  const ids = useId();
  const claim = doc.scene.claim.vehicle;
  const [yearText, setYearText] = useState(v.year == null ? "" : String(v.year));
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [matchNote, setMatchNote] = useState<{ key: string; model: string; text: string; warn: boolean } | null>(null);
  const latest = useRef(v);
  useEffect(() => { latest.current = v; });

  const patch = (p: Partial<SceneVehicle>) => dispatch({ type: "vehicle", id: v.id, patch: p });
  const key = lookupKey(v);
  const currentYear = new Date().getFullYear();
  const askable = v.year != null && v.make.trim().length >= 2 && v.year >= FIRST_VPIC_YEAR && v.year <= currentYear + 1;
  const badYear = v.year != null && v.make.trim().length >= 2 && !askable;
  const current = lookup && lookup.key === key ? lookup : null;

  // vPIC lookup for this year and make, after a short pause in typing. Changing the make clears the
  // model (in the reducer), and this reloads the model list for the new make.
  useEffect(() => {
    if (!askable || v.year == null) return;
    const asked = key;
    const make = v.make;
    const year = v.year;
    const timer = window.setTimeout(() => {
      vehicles.models(make, year).then(
        (models) => {
          if (lookupKey(latest.current) !== asked) return;
          setLookup(models.length ? { key: asked, state: "ok", models } : { key: asked, state: "warn", text: `No ${make} models found for ${year}. Pick the type below.`, models: [] });
          applyModel(models, latest.current.model, asked);
        },
        (e: unknown) => {
          if (lookupKey(latest.current) !== asked) return;
          setLookup({ key: asked, state: "warn", text: `${e instanceof ServiceError ? e.message : "Couldn't reach the vehicle list."} Pick the type below.`, models: [] });
        },
      );
    }, LOOKUP_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // `applyModel` only reads refs and dispatch; the key stands for year + make.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, askable, vehicles]);

  function applyModel(models: readonly VehicleModelResult[], modelText: string, asked: string) {
    const m = models.find((x) => x.name.toLowerCase() === modelText.trim().toLowerCase());
    if (!m) { setMatchNote(null); return; }
    if (m.type) {
      const label = PRESETS[m.type].label;
      dispatch({ type: "vehicle", id: latest.current.id, patch: { type: m.type, typeSource: "vpic" } });
      setMatchNote({ key: asked, model: m.name, warn: false, text: `${label} from NHTSA vPIC (${m.vpicType}). Weight and size: ${label.toLowerCase()} class average.` });
    } else {
      setMatchNote({ key: asked, model: m.name, warn: true, text: `vPIC lists ${m.name} as "${m.vpicType}". Pick the closest type below.` });
    }
  }

  let lookupText: string;
  let warn = false;
  // Only a type that really came from vPIC is a success; instructions and hints get no check mark.
  let matched = false;
  let loading = false;
  const note = matchNote && matchNote.key === key && matchNote.model.toLowerCase() === v.model.trim().toLowerCase() ? matchNote : null;
  if (badYear) { lookupText = "Check the year. Pick the type below."; warn = true; }
  else if (askable && !current) { lookupText = `Looking up ${v.make.trim()} models for ${v.year}…`; loading = true; }
  else if (current?.state === "warn") { lookupText = current.text; warn = true; }
  else if (note) { lookupText = note.text; warn = note.warn; matched = !note.warn; }
  else if (current?.state === "ok") lookupText = `${current.models.length} ${v.make.trim()} models for ${v.year}. Pick yours to fill in the type.`;
  else if (v.typeSource === "claim") lookupText = `${PRESETS[v.type].label}, from your claim. Change it if it's wrong.`;
  else lookupText = "Enter the year, make and model to fill in the type, or pick it below.";

  const sameAsClaim = v.id === "A" && v.year === claim.year && v.make === claim.make && v.model === claim.model;
  const sub = [vehicleName(v), v.id === "A" ? (sameAsClaim ? "from your claim" : "changed from your claim") : null].filter(Boolean).join(" · ") || "Year, make and model if you know them";
  // A photo is asked for only once a model from the vPIC list is picked (never per keystroke).
  const modelPicked = current?.state === "ok" && current.models.some((m) => m.name.toLowerCase() === v.model.trim().toLowerCase());
  const modelsListId = `${ids}-models`;
  const titleId = `${ids}-title`;

  return (
    <article className={`vehicle v-${v.id.toLowerCase()}`} id={`vehicle-${v.id}`} aria-labelledby={titleId}>
      <header className="vehicle-head">
        <span className="badge-letter">{v.id}</span>
        <div className="vehicle-title">
          <h2 id={titleId}>{roleName(v)}</h2>
          <p className="vehicle-sub">{v.make.trim() ? <MakeLogo make={v.make} showName={false} /> : null}<span>{sub}</span></p>
        </div>
        <VehiclePhoto vehicle={v} ready={modelPicked} />
        {canRemove ? <button className="btn btn-quiet btn-sm" type="button" aria-label={`Remove vehicle ${v.id}`} onClick={onRemove}><Icon name="trash" className="icon-sm" /><span>Remove</span></button> : null}
      </header>

      <div className="vehicle-grid">
        <div className="group">
          <p className="group-label">Vehicle</p>
          <div className="ymm">
            <div className="field field-year">
              <label className="field-sub" htmlFor={`${ids}-year`}>Year</label>
              <input className="input num" id={`${ids}-year`} type="text" inputMode="numeric" maxLength={4} autoComplete="off" value={yearText} onChange={(e) => {
                const y = e.target.value.replace(/\D/g, "").slice(0, 4);
                setYearText(y);
                patch({ year: y.length === 4 ? Number(y) : null });
              }} />
            </div>
            <div className="field">
              <label className="field-sub" htmlFor={`${ids}-make`}>Make</label>
              <input className="input" id={`${ids}-make`} type="text" list="dl-makes" autoComplete="off" spellCheck={false} value={v.make} onChange={(e) => patch({ make: e.target.value })} />
            </div>
            <div className="field">
              <label className="field-sub" htmlFor={`${ids}-model`}>Model</label>
              <input className="input" id={`${ids}-model`} type="text" list={modelsListId} autoComplete="off" spellCheck={false} value={v.model} onChange={(e) => {
                patch({ model: e.target.value });
                if (current) applyModel(current.models, e.target.value, key);
              }} />
              <datalist id={modelsListId}>{current?.models.map((m) => <option key={m.name} value={m.name} />)}</datalist>
            </div>
          </div>
          <p className={`lookup${warn ? " is-warn" : ""}`} aria-live="polite">
            {loading ? <span className="spinner" aria-hidden="true" /> : warn ? <Icon name="info" className="icon-sm" /> : matched ? <Icon name="check" className="icon-sm" /> : null}
            <span>{lookupText}</span>
          </p>
          <fieldset className="group">
            <legend className="field-sub">Type</legend>
            <RadioGroup className="tiles tiles-6 tiles-compact" aria-label={`Type of vehicle ${v.id}`} values={VEHICLE_TYPES} value={v.type} onChange={(t: VehicleType) => patch({ type: t, typeSource: "manual" })}>
              {VEHICLE_TYPES.map((t) => <Tile key={t} value={t} icon={PRESETS[t].icon} label={PRESETS[t].label} badge={t === v.type && v.typeSource === "vpic" ? <span className="auto">vPIC</span> : null} />)}
            </RadioGroup>
          </fieldset>
        </div>

        <fieldset className="group">
          <legend className="group-label">What was it doing?</legend>
          <RadioGroup className="tiles tiles-5 tiles-compact" aria-label={`What vehicle ${v.id} was doing`} values={ACTIONS} value={v.action} onChange={(a: Action) => patch({ action: a })}>
            {ACTIONS.map((a) => <Tile key={a} value={a} icon={ACTION_TILES[a].icon} label={ACTION_TILES[a].label} />)}
          </RadioGroup>
        </fieldset>

        <DirectionPicker vehicle={v} picked={directionSet} choices={roads.streets?.directions ?? []} onChange={(travel) => patch({ travel })} />

        {v.action === "parked" ? null : (
          <div className="speed-braking">
            <SpeedInput vehicle={v} onChange={(speed) => dispatch({ type: "speed", id: v.id, speed })} />
            <label className="check-row" data-braking>
              <input type="checkbox" checked={v.braking} onChange={(e) => patch({ braking: e.target.checked })} />
              <span>{BRAKING_LABEL}</span>
            </label>
          </div>
        )}

        <ImpactZones vehicle={v} onChange={(zone) => patch({ zone })} />
      </div>
    </article>
  );
}
