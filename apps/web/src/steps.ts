// Steps 1, 2 and 4 are their own chunks: the maps (leaflet) and the save step (pdf-lib, the exports) are not
// needed to open Review, which is what an example link does. Review stays in the main chunk. Each step's code
// starts loading at boot when it is the step on screen, and the next step's code once the current one is up.
// A step whose code is already in renders at once (no "Loading…" flash): lazy() is handed a thenable that
// answers synchronously.
import { lazy, type ComponentType } from "react";

export type LazyStep = "location" | "vehicles" | "export";

const loaders = {
  location: () => import("./components/LocationStep"),
  vehicles: () => import("./components/VehiclesStep"),
  export: () => import("./save/SaveStep"),
} as const;
type Loaded = { [K in LazyStep]: Awaited<ReturnType<(typeof loaders)[K]>> };

const loaded: Partial<Loaded> = {};

function load<K extends LazyStep>(step: K): Promise<Loaded[K]> {
  return loaders[step]().then((m) => { loaded[step] = m as Loaded[K]; return m as Loaded[K]; });
}

function lazyStep<K extends LazyStep>(step: K, pick: (m: Loaded[K]) => ComponentType) {
  return lazy(() => {
    const m = loaded[step];
    // React reads a thenable that settles inside then() as already resolved. (Typed as a Promise for lazy().)
    if (m) return { then: (resolve: (v: { default: ComponentType }) => void) => resolve({ default: pick(m) }) } as unknown as Promise<{ default: ComponentType }>;
    return load(step).then((x) => ({ default: pick(x) }));
  });
}

export const LocationStep = lazyStep("location", (m) => m.LocationStep);
export const VehiclesStep = lazyStep("vehicles", (m) => m.VehiclesStep);
export const SaveStep = lazyStep("export", (m) => m.SaveStep);

/** Starts loading a step's code (a no-op once it is in). A failure is left for the step's own load to report. */
export function preloadStep(step: string): void {
  if ((step === "location" || step === "vehicles" || step === "export") && !loaded[step]) void load(step).catch(() => undefined);
}

/**
 * Starts loading steps' code after `delayMs` and then only when the page is idle: Save's code brings pdf-lib
 * (a large module to evaluate), which must not land while the person is already using another screen. Returns
 * a cancel (call it when leaving the screen that asked).
 */
export function preloadStepsWhenIdle(steps: readonly string[], delayMs: number): () => void {
  let idle: number | null = null;
  const run = () => { for (const s of steps) preloadStep(s); };
  const timer = window.setTimeout(() => {
    // No rIC timeout: a forced run could land mid-animation. Without rIC (Safari before 18), after the delay.
    if (typeof requestIdleCallback === "function") idle = requestIdleCallback(run);
    else run();
  }, delayMs);
  return () => { window.clearTimeout(timer); if (idle !== null) cancelIdleCallback(idle); };
}

/** Every step's code, loaded (unit tests mount the app synchronously). */
export async function loadAllSteps(): Promise<void> {
  await Promise.all((Object.keys(loaders) as LazyStep[]).map((k) => load(k)));
}
