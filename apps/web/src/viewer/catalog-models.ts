// Loads the catalog model (GLB) of each vehicle with a make and a model, fits it to that vehicle's footprint and
// plans its tint. Never blocks the picture: our low-poly model shows from the first frame and the catalog model
// replaces it when (and only if) it arrives. A vehicle edited or removed aborts its request and frees its model;
// unmounting frees everything.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Scene, SimulationResult } from "@csd/core";
import type { Mesh } from "three";
import type { VehicleModelAsset, VehicleModelQuery } from "../services/vehicle-models";
import { askable, modelKey } from "../services/vehicle-models";
import { parseGlb } from "./glb-loader";
import { disposeModel, fitToSceneLighting, normalise, planTint, type Footprint } from "./glb-model";
import { SKIN_M, vehicleModel } from "./vehicle-models";
import type { CatalogModel } from "./vehicle-view";

export type ModelLoader = (q: VehicleModelQuery, signal?: AbortSignal) => Promise<VehicleModelAsset | null>;

interface Want { readonly id: string; readonly q: VehicleModelQuery; readonly foot: Footprint; readonly key: string }
interface Live { readonly key: string; readonly ctrl: AbortController; model: CatalogModel | null }

/** What to ask for: one entry per vehicle with a make and a model, keyed by the query and the footprint it must fit. */
export function catalogWants(scene: Scene, sim: SimulationResult): Want[] {
  return scene.vehicles.flatMap((v) => {
    const rv = sim.vehicles.find((x) => x.id === v.id);
    const q: VehicleModelQuery = { year: v.year, make: v.make, model: v.model };
    if (!rv || !askable(q)) return [];
    // The same box our own model fills: the footprint less its skin, and our model's height for that type.
    const foot: Footprint = { lengthM: rv.lengthM - 2 * SKIN_M, widthM: rv.widthM - 2 * SKIN_M, heightM: vehicleModel(rv.type, rv.lengthM, rv.widthM).heightM };
    return [{ id: v.id, q, foot, key: `${modelKey(q)}|${foot.lengthM.toFixed(3)}|${foot.widthM.toFixed(3)}|${foot.heightM.toFixed(3)}` }];
  });
}

export function useCatalogModels(scene: Scene, sim: SimulationResult, load: ModelLoader | undefined): ReadonlyMap<string, CatalogModel> {
  const [models, setModels] = useState<ReadonlyMap<string, CatalogModel>>(() => new Map());
  const live = useRef(new Map<string, Live>());
  /** Models taken out of `models`: freed only after the commit that removed them, so no frame draws a freed model. */
  const dropped = useRef<CatalogModel[]>([]);
  /** The deferred "free everything" of an unmount; a remount (React strict mode in dev) cancels it and keeps the models. */
  const closing = useRef<number | null>(null);
  const wants = useMemo(() => (load ? catalogWants(scene, sim) : []), [load, scene, sim]);
  const wantKey = wants.map((w) => `${w.id}:${w.key}`).join(";");

  useEffect(() => {
    if (closing.current !== null) { window.clearTimeout(closing.current); closing.current = null; }
    const cur = live.current;
    const publish = () => setModels(new Map([...cur].flatMap(([id, e]) => (e.model ? [[id, e.model] as const] : []))));
    let changed = false;
    for (const [id, e] of [...cur]) {
      // Kept: still wanted, and either loaded or still loading (an unmount aborted the ones in flight).
      if (wants.some((w) => w.id === id && w.key === e.key) && (e.model || !e.ctrl.signal.aborted)) continue;
      e.ctrl.abort();
      if (e.model) { dropped.current.push(e.model); changed = true; }
      cur.delete(id);
    }
    if (changed) publish();
    if (!load) return;
    for (const w of wants) {
      if (cur.has(w.id)) continue;
      const entry: Live = { key: w.key, ctrl: new AbortController(), model: null };
      cur.set(w.id, entry);
      const { signal } = entry.ctrl;
      load(w.q, signal)
        .then((asset) => (asset ? parseGlb(asset.bytes, signal).then((root): CatalogModel => {
          try {
            const object = normalise(root, w.foot);
            object.traverse((o) => { if ((o as Mesh).isMesh) (o as Mesh).castShadow = true; });
            fitToSceneLighting(object);
            return { object, plan: planTint(object), watermarked: asset.watermarked };
          } catch (e) {
            disposeModel(root);
            throw e;
          }
        }) : null))
        .then((m) => {
          if (!m) return;
          if (signal.aborted || cur.get(w.id) !== entry) { disposeModel(m.object); return; }
          entry.model = m;
          publish();
        })
        .catch(() => undefined);   // aborted, or a file three can't read: our own model stays
    }
    // `wants` is represented by `wantKey`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantKey, load]);

  // Free the models a commit has taken out of the picture.
  useEffect(() => {
    if (!dropped.current.length) return;
    const list = dropped.current;
    dropped.current = [];
    for (const m of list) disposeModel(m.object);
  }, [models]);

  useEffect(() => () => {
    const cur = live.current;
    for (const e of cur.values()) if (!e.model) e.ctrl.abort();
    // The picture is going away (the Canvas with it): free everything once this commit is done, unless a remount
    // (strict mode) takes the models back first.
    closing.current = window.setTimeout(() => {
      closing.current = null;
      for (const e of cur.values()) { e.ctrl.abort(); if (e.model) disposeModel(e.model.object); }
      cur.clear();
      for (const m of dropped.current) disposeModel(m.object);
      dropped.current = [];
    }, 0);
  }, []);

  return models;
}
