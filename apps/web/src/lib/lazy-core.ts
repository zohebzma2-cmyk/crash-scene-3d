// Two parts of @csd/core that the first screens rarely need, loaded on demand instead of in the main bundle:
// the sun estimate (with tz-lookup's ~73 KB zone table) and the icons' stroke geometry (~57 KB of JSON).
// The 3D viewer imports both statically, so they arrive with its chunk; these hooks serve the main-bundle screens.
import { useEffect, useState } from "react";
import type { IconStrokes } from "@csd/core";

type EstimateSun = typeof import("@csd/core/sun").estimateSun;

let estimator: EstimateSun | null = null;
let estimatorLoad: Promise<EstimateSun> | null = null;
/** Starts loading the sun estimate (once); a failed load can be tried again. */
export function loadSunEstimator(): Promise<EstimateSun> {
  estimatorLoad ??= import("@csd/core/sun").then(
    (m) => (estimator = m.estimateSun),
    (e: unknown) => { estimatorLoad = null; throw e; },
  );
  return estimatorLoad;
}
/** The sun estimate once `wanted` (loaded on the first wanted render); null until it has arrived. */
export function useSunEstimator(wanted: boolean): EstimateSun | null {
  const [fn, setFn] = useState<EstimateSun | null>(() => estimator);
  useEffect(() => {
    if (!wanted || fn) return;
    let live = true;
    loadSunEstimator().then((f) => { if (live) setFn(() => f); }, () => undefined);
    return () => { live = false; };
  }, [wanted, fn]);
  return fn;
}
let strokes: IconStrokes | null = null;
let strokesLoad: Promise<IconStrokes> | null = null;
export function loadIconStrokes(): Promise<IconStrokes> {
  strokesLoad ??= import("@csd/core/icon-strokes").then(
    (m) => (strokes = m.iconStrokes),
    (e: unknown) => { strokesLoad = null; throw e; },
  );
  return strokesLoad;
}
/** The icon strokes once `wanted` (e.g. the network has tagged features); null until they have arrived. */
export function useIconStrokes(wanted: boolean): IconStrokes | null {
  const [s, setS] = useState<IconStrokes | null>(() => strokes);
  useEffect(() => {
    if (!wanted || s) return;
    let live = true;
    loadIconStrokes().then((v) => { if (live) setS(v); }, () => undefined);
    return () => { live = false; };
  }, [wanted, s]);
  return s;
}
