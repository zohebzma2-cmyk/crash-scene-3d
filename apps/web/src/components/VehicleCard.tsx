// One vehicle: letter badge, year/make/model as type-ahead lists from NHTSA vPIC, type, what it was
// doing, direction, speed and where it was hit. Editing vehicle A never changes the claim header.
import { useEffect, useId, useMemo, useRef, useState, type ComponentType, type RefObject } from "react";
import {
  ACTIONS, FIRST_VPIC_YEAR, MAKE_ALIASES, MODEL_ALIASES, POPULAR_MAKES, PRESETS, VEHICLE_TYPES, modelYears, normName, rankNames, rankYears, resolveName, vehicleName,
  type Action, type SceneVehicle, type VehicleModelResult, type VehicleType,
} from "@csd/core";
import { RadioGroup } from "../a11y/roving";
import { Icon } from "../icons/Icon";
import { roleName } from "../lib/text";
import { useServices } from "../services/context";
import { ServiceError } from "../services/types";
import { VEHICLE_LOOKUP_MESSAGES } from "../services/vehicles";
import { useDoc } from "../state/DocProvider";
import { useRoads } from "../state/Roads";
import { DirectionPicker } from "./DirectionPicker";
import { ImpactZones } from "./ImpactZones";
import { SpeedInput } from "./SpeedInput";
import { Tile } from "./Tile";
import { VehicleCombobox, type ComboItem, type ComboStatus } from "./VehicleCombobox";

const ACTION_TILES: Record<Action, { icon: string; label: string }> = {
  straight: { icon: "act-straight", label: "Straight" },
  "turn-left": { icon: "act-left", label: "Turning left" },
  "turn-right": { icon: "act-right", label: "Turning right" },
  backing: { icon: "act-backing", label: "Backing up" },
  parked: { icon: "act-parked", label: "Parked" },
};

// The maker's logo in each make row, once round B's MakeLogo component exists; nothing until then.
const logoModules = import.meta.glob<Record<string, unknown>>("./MakeLogo.tsx", { eager: true });
const logoModule = Object.values(logoModules)[0];
const MakeLogo = (logoModule?.MakeLogo ?? logoModule?.default) as ComponentType<{ make: string }> | undefined;

/** DESIGN.md doesn't specify a braking control; a plain checkbox, off unless the claimant says so (the physics assumes no braking). */
export const BRAKING_LABEL = "Braking just before the crash";
/**
 * Typing waits this long before a make's models are asked for (the service waits longer still for a make the
 * list doesn't know), so passing through "Mini" or "Chev" on the way to a longer name costs nothing. Picking a
 * year or a make from the list asks at once.
 */
export const LOOKUP_DEBOUNCE_MS = 450;
export { FIRST_VPIC_YEAR };
export const MAKE_LIST_LIMIT = 40;
export const MODEL_LIST_LIMIT = 60;
export const MAKES_LOADING_TEXT = "Loading the makes…";
/**
 * Why a vehicle list couldn't load, as one of the service's vehicle-list sentences ("The vehicle list is busy right
 * now."). Anything else (a proxy message about map requests, an unexpected error) becomes the generic sentence.
 */
export function vehicleListReason(e: unknown): string {
  const known: readonly string[] = Object.values(VEHICLE_LOOKUP_MESSAGES);
  return e instanceof ServiceError && known.includes(e.message) ? e.message : VEHICLE_LOOKUP_MESSAGES.other;
}
export const makesFailedText = (reason: string = VEHICLE_LOOKUP_MESSAGES.other) => `${reason} Type the make; it still works.`;
export const modelsFailedText = (reason: string = VEHICLE_LOOKUP_MESSAGES.other) => `${reason} Type the model; it still works.`;
export const modelsFailedLookup = (reason: string = VEHICLE_LOOKUP_MESSAGES.other) => `${reason} Pick the type below.`;
export const noModelsText = (make: string, year: number) => `No ${make} models found for ${year}. Pick the type below.`;
export const asTypedText = (text: string) => `Use ‘${text}’ as typed`;
export const notInVpic = (make: string) => `‘${make}’ isn't in NHTSA vPIC's list. Pick the type below.`;

/** The makes list for every card: loaded once per session by the Vehicles step. */
export type MakesState = { readonly status: "loading" } | { readonly status: "ok"; readonly names: readonly string[] } | { readonly status: "error"; readonly reason?: string };

type Lookup =
  | { key: string; state: "ok"; models: VehicleModelResult[] }
  | { key: string; state: "warn"; text: string; reason: string; models: VehicleModelResult[] };

const focusSoon = (ref: RefObject<HTMLInputElement | null>) => window.setTimeout(() => ref.current?.focus(), 0);
const findModel = (models: readonly VehicleModelResult[], text: string, make: string | null) => {
  const name = resolveName(text, models.map((m) => m.name), { aliases: MODEL_ALIASES, ...(make ? { stripPrefix: make } : {}) });
  return name == null ? undefined : models.find((m) => m.name === name);
};

export interface VehicleCardProps {
  readonly vehicle: SceneVehicle;
  readonly canRemove: boolean;
  /** Has the claimant picked the direction yet? */
  readonly directionSet: boolean;
  readonly onRemove: () => void;
  /** vPIC's makes (cars, MPVs, trucks, motorcycles), shared by every card. */
  readonly makes?: MakesState;
}

export function VehicleCard({ vehicle: v, canRemove, directionSet, onRemove, makes = { status: "loading" } }: VehicleCardProps) {
  const { doc, dispatch } = useDoc();
  const { vehicles } = useServices();
  const roads = useRoads();
  const ids = useId();
  const claim = doc.scene.claim.vehicle;
  const [yearText, setYearText] = useState(v.year == null ? "" : String(v.year));
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [matchNote, setMatchNote] = useState<{ key: string; model: string; text: string; warn: boolean } | null>(null);
  /** The make text was left (picked, Tab, Enter, a tap elsewhere), not still being typed. */
  const [makeDone, setMakeDone] = useState(v.make.trim() !== "");
  const latest = useRef(v);
  useEffect(() => { latest.current = v; });
  const makeRef = useRef<HTMLInputElement>(null);
  const modelRef = useRef<HTMLInputElement>(null);

  const patch = (p: Partial<SceneVehicle>) => dispatch({ type: "vehicle", id: v.id, patch: p });
  const years = useMemo(() => modelYears(), []);
  const lastYear = years[0] ?? FIRST_VPIC_YEAR;
  const makeNames = makes.status === "ok" ? makes.names : null;
  const resolvedMake = makeNames ? resolveName(v.make, makeNames, { aliases: MAKE_ALIASES }) : null;
  // Models are asked for under the makes list's spelling when the text is one of vPIC's makes (typed exactly, by a
  // common name like "chevy", or picked). Anything else is asked for as typed once typing stops (vPIC may know a
  // make outside the list): the service waits longer for it, and the next keystroke drops that wait, so half a
  // make is never asked for while someone is typing. One request per make and year either way.
  const typedMake = v.make.trim();
  const lookupMake = resolvedMake ?? (normName(typedMake).length >= 2 ? typedMake : null);
  /** Set by a pick from the list: ask at once instead of after the typing pause. */
  const askNow = useRef(false);
  const key = `${v.year ?? ""}|${lookupMake ? normName(lookupMake) : ""}`;
  const keyRef = useRef(key);
  useEffect(() => { keyRef.current = key; });
  const yearOk = v.year != null && v.year >= FIRST_VPIC_YEAR && v.year <= lastYear;
  const badYear = v.year != null && !yearOk;
  const askable = yearOk && lookupMake != null;
  const current = lookup && lookup.key === key ? lookup : null;

  // vPIC models for this year and make, once the make is known: one request per make and year, cached for the
  // session by the service (which retries a busy answer first). Changing the make clears the model (in the
  // reducer) and loads the new make's list; typing on drops the wait (the signal).
  useEffect(() => {
    if (!askable || v.year == null || lookupMake == null) return;
    const asked = key;
    const make = lookupMake;
    const year = v.year;
    const typedOn = new AbortController();
    const wait = askNow.current ? 0 : LOOKUP_DEBOUNCE_MS;
    askNow.current = false;
    const timer = window.setTimeout(() => {
      vehicles.models(make, year, { signal: typedOn.signal }).then(
        (models) => {
          if (keyRef.current !== asked) return;
          setLookup({ key: asked, state: "ok", models });
          applyModel(models, latest.current.model, asked, make);
        },
        (e: unknown) => {
          // The service has already retried a busy answer; here one plain line worded for the vehicle list.
          if (typedOn.signal.aborted || keyRef.current !== asked) return;
          const reason = vehicleListReason(e);
          setLookup({ key: asked, state: "warn", text: modelsFailedLookup(reason), reason, models: [] });
        },
      );
    }, wait);
    return () => { window.clearTimeout(timer); typedOn.abort(); };
    // `applyModel` only reads refs and dispatch; the key stands for year + make.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, askable, vehicles]);

  function applyModel(models: readonly VehicleModelResult[], modelText: string, asked: string, make: string | null) {
    const m = findModel(models, modelText, make);
    if (!m) { setMatchNote(null); return; }
    if (m.type) {
      const label = PRESETS[m.type].label;
      dispatch({ type: "vehicle", id: latest.current.id, patch: { type: m.type, typeSource: "vpic" } });
      setMatchNote({ key: asked, model: m.name, warn: false, text: `${label} from NHTSA vPIC (${m.vpicType}). Weight and size: ${label.toLowerCase()} class average.` });
    } else {
      setMatchNote({ key: asked, model: m.name, warn: true, text: `vPIC lists ${m.name} as "${m.vpicType}". Pick the closest type below.` });
    }
  }

  // ---- the lookup line under the fields ----
  let lookupText: string;
  let warn = false;
  // Only a type that really came from vPIC is a success; instructions and hints get no check mark.
  let matched = false;
  let loading = false;
  const typedModel = current?.state === "ok" ? findModel(current.models, v.model, lookupMake) : undefined;
  const note = matchNote && matchNote.key === key && typedModel?.name === matchNote.model ? matchNote : null;
  // A make still being typed (not one of vPIC's, field not left) gets no "Looking up…" yet.
  const settledMake = resolvedMake != null || makeDone;
  if (badYear) { lookupText = "Check the year. Pick the type below."; warn = true; }
  else if (current?.state === "warn") { lookupText = current.text; warn = true; }
  else if (note) { lookupText = note.text; warn = note.warn; matched = !note.warn; }
  else if (current?.state === "ok" && v.year != null) {
    if (current.models.length) lookupText = `${current.models.length} ${lookupMake} models for ${v.year}. Pick yours to fill in the type.`;
    else { lookupText = noModelsText(lookupMake ?? typedMake, v.year); warn = !resolvedMake; }
  }
  else if (askable && settledMake) { lookupText = `Looking up ${lookupMake} models for ${v.year}…`; loading = true; }
  else if (makeNames && makeDone && typedMake && !resolvedMake && v.year == null) { lookupText = notInVpic(typedMake); warn = true; }
  else if (v.typeSource === "claim") lookupText = `${PRESETS[v.type].label}, from your claim. Change it if it's wrong.`;
  else lookupText = "Enter the year, make and model to fill in the type, or pick it below.";

  // ---- year ----
  const yearItems: ComboItem[] = rankYears(yearText, years).map((y) => ({ id: `${ids}-y${y}`, value: String(y), main: String(y) }));
  const yearStatus: ComboStatus | null = yearItems.length === 0 ? { kind: "note", text: `vPIC has model years ${FIRST_VPIC_YEAR} to ${lastYear}. Check the year.` } : null;

  // ---- make ----
  const makeItems: ComboItem[] = useMemo(() => {
    const out: ComboItem[] = (makeNames ? rankNames(v.make, makeNames, { aliases: MAKE_ALIASES, popular: POPULAR_MAKES, limit: MAKE_LIST_LIMIT }) : [])
      .map((r, i) => ({ id: `${ids}-mk${i}`, value: r.name, main: r.name, lead: MakeLogo ? <MakeLogo make={r.name} /> : undefined }));
    const typed = v.make.trim();
    if (typed && !makeNames?.some((n) => normName(n) === normName(typed))) out.push({ id: `${ids}-mk-typed`, value: typed, main: asTypedText(typed), free: true });
    return out;
  }, [v.make, makeNames, ids]);
  const makeStatus: ComboStatus | null = makes.status === "loading" ? { kind: "loading", text: MAKES_LOADING_TEXT } : makes.status === "error" ? { kind: "note", text: makesFailedText(makes.reason) } : null;

  // ---- model ----
  const modelItems: ComboItem[] = useMemo(() => {
    const models = current?.state === "ok" ? current.models : [];
    const byName = new Map(models.map((m) => [m.name, m]));
    const out: ComboItem[] = rankNames(v.model, models.map((m) => m.name), { aliases: MODEL_ALIASES, limit: MODEL_LIST_LIMIT, ...(lookupMake ? { stripPrefix: lookupMake } : {}) })
      .map((r, i) => {
        const t = byName.get(r.name)?.type;
        return { id: `${ids}-md${i}`, value: r.name, main: r.name, sub: t ? PRESETS[t].label : "Pick the type yourself" };
      });
    const typed = v.model.trim();
    if (typed && !models.some((m) => normName(m.name) === normName(typed))) out.push({ id: `${ids}-md-typed`, value: typed, main: asTypedText(typed), free: true });
    return out;
  }, [v.model, current, lookupMake, ids]);
  let modelStatus: ComboStatus | null = null;
  if (v.year == null) modelStatus = { kind: "note", text: "Enter the year to see the models." };
  else if (badYear) modelStatus = { kind: "note", text: "Check the year to see the models." };
  else if (lookupMake == null) {
    modelStatus = makes.status === "loading" && typedMake ? { kind: "loading", text: MAKES_LOADING_TEXT }
      : !typedMake ? { kind: "note", text: "Pick the make to see its models." }
      : { kind: "note", text: "No model list for this make. Type the model; it still works." };
  } else if (!current) modelStatus = { kind: "loading", text: `Loading ${lookupMake} models for ${v.year}…` };
  else if (current.state === "warn") modelStatus = { kind: "note", text: modelsFailedText(current.reason) };
  else if (current.models.length === 0) modelStatus = { kind: "note", text: `vPIC has no ${lookupMake} models for ${v.year}. Type the model; it still works.` };

  const sameAsClaim = v.id === "A" && v.year === claim.year && v.make === claim.make && v.model === claim.model;
  const sub = [vehicleName(v), v.id === "A" ? (sameAsClaim ? "from your claim" : "changed from your claim") : null].filter(Boolean).join(" · ") || "Year, make and model if you know them";
  const titleId = `${ids}-title`;

  return (
    <article className={`vehicle v-${v.id.toLowerCase()}`} id={`vehicle-${v.id}`} aria-labelledby={titleId}>
      <header className="vehicle-head">
        <span className="badge-letter">{v.id}</span>
        <div className="vehicle-title">
          <h2 id={titleId}>{roleName(v)}</h2>
          <p className="vehicle-sub">{sub}</p>
        </div>
        {canRemove ? <button className="btn btn-quiet btn-sm" type="button" aria-label={`Remove vehicle ${v.id}`} onClick={onRemove}><Icon name="trash" className="icon-sm" /><span>Remove</span></button> : null}
      </header>

      <div className="vehicle-grid">
        <div className="group">
          <p className="group-label">Vehicle</p>
          <div className="ymm">
            <VehicleCombobox
              id={`${ids}-year`} label="Year" className="field-year" inputClassName="num" inputMode="numeric" maxLength={4}
              value={yearText} items={yearItems} status={yearStatus}
              onType={(text) => {
                const y = text.replace(/\D/g, "").slice(0, 4);
                setYearText(y);
                patch({ year: y.length === 4 ? Number(y) : null });
              }}
              onPick={(item) => {
                setYearText(item.value);
                if (Number(item.value) !== latest.current.year) { askNow.current = lookupMake != null; patch({ year: Number(item.value) }); }
                focusSoon(makeRef);
              }}
            />
            <VehicleCombobox
              id={`${ids}-make`} label="Make" inputRef={makeRef}
              value={v.make} items={makeItems} status={makeStatus}
              onType={(text) => { patch({ make: text }); setMakeDone(false); }}
              onPick={(item) => {
                setMakeDone(true);
                if (`${v.year ?? ""}|${normName(item.value)}` !== key) askNow.current = true;
                if (item.value !== latest.current.make) patch({ make: item.value });
                focusSoon(modelRef);
              }}
              onCommit={() => {
                const now = latest.current.make;
                setMakeDone(now.trim() !== "");
                const name = makeNames ? resolveName(now, makeNames, { aliases: MAKE_ALIASES }) : null;
                if (name && name !== now) patch({ make: name });
              }}
            />
            <VehicleCombobox
              id={`${ids}-model`} label="Model" inputRef={modelRef}
              value={v.model} items={modelItems} status={modelStatus}
              onType={(text) => {
                patch({ model: text });
                if (current?.state === "ok") applyModel(current.models, text, key, lookupMake);
              }}
              onPick={(item) => {
                if (item.value !== latest.current.model) patch({ model: item.value });
                if (current?.state === "ok") applyModel(current.models, item.value, key, lookupMake);
              }}
              onCommit={() => {
                const now = latest.current.model;
                const m = current?.state === "ok" ? findModel(current.models, now, lookupMake) : undefined;
                if (m && m.name !== now && current?.state === "ok") {
                  patch({ model: m.name });
                  applyModel(current.models, m.name, key, lookupMake);
                }
              }}
            />
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
