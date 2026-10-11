// The Review picture's loading stages: map data, terrain, the 3D view (the viewer's code) and drawing the
// first frame. Pure: the stages are derived from what the app already knows (the roads' status and terrain
// progress, the viewer chunk's status, the 3D view's first frame), so they can never drift from the real work.
// No three, no React: this module is in the main chunk.

export type StageId = "map" | "terrain" | "models" | "scene";
export type StageStatus = "waiting" | "active" | "done" | "skipped" | "failed";

export interface Stage {
  readonly id: StageId;
  readonly label: string;
  readonly status: StageStatus;
  /** Terrain tiles: how many of how many have arrived. */
  readonly count?: { readonly done: number; readonly total: number };
  /** Why it failed, in plain words (shown as text). */
  readonly message?: string;
  /** The same, in a few words, for narrow screens (the full message stays for screen readers). */
  readonly short?: string;
}

/** Why the 3D view failed, when it did. */
export type SceneFailure = "webgl" | "lost";

export interface LoadInputs {
  /** The roads around the pin (and, for an example, its scene file before that). "none": there is no place to load. */
  readonly map: "loading" | "ready" | "none" | "failed";
  /** Terrain tiles while they arrive; `available` once the roads are in (false: the ground is drawn flat). */
  readonly terrain: { readonly done: number; readonly total: number; readonly available?: boolean } | null;
  /** The 3D viewer's code chunk. "none": no WebGL, so the top-down diagram is the picture. */
  readonly models: "idle" | "loading" | "ready" | "failed" | "none";
  /** The 3D view's first frame. */
  readonly scene: "waiting" | "building" | "ready" | { readonly failed: SceneFailure };
}

export const STAGE_LABELS: Readonly<Record<StageId, string>> = {
  map: "Map data",
  terrain: "Terrain",
  models: "3D view",
  scene: "Drawing the scene",
};

export const FAILURE_TEXT = {
  map: "We couldn't load the map data, so the picture has no roads.",
  models: "We couldn't load the 3D view. Check your connection and try again.",
  webgl: "The 3D view couldn't start in this browser, so this is the top-down diagram.",
  lost: "The 3D view stopped, so this is the top-down diagram.",
} as const;

/** The failures in a few words, for a phone-width banner. */
export const FAILURE_SHORT = {
  map: "No map data, so no roads.",
  models: "3D view didn't load.",
  webgl: "3D view couldn't start.",
  lost: "3D view stopped.",
} as const;

const ACTIVE_TEXT: Readonly<Record<StageId, string>> = {
  map: "Loading the map data",
  terrain: "Loading the terrain",
  models: "Loading the 3D view",
  scene: "Drawing the scene",
};

export const HEADLINE = "Building the scene…";

export function loadStages(i: LoadInputs): Stage[] {
  const mapStatus: StageStatus = i.map === "loading" ? "active" : i.map === "ready" ? "done" : i.map === "none" ? "skipped" : "failed";
  const map: Stage = { id: "map", label: STAGE_LABELS.map, status: mapStatus, ...(mapStatus === "failed" ? { message: FAILURE_TEXT.map, short: FAILURE_SHORT.map } : {}) };

  // Terrain comes after the roads in the same request chain: waiting until they are in, then counting tiles.
  let terrainStatus: StageStatus;
  if (i.map === "failed" || i.map === "none") terrainStatus = "skipped";
  else if (i.map === "ready") terrainStatus = i.terrain?.available === false ? "skipped" : "done";
  else terrainStatus = i.terrain && i.terrain.total > 0 ? "active" : "waiting";
  const count = i.terrain && i.terrain.total > 0 ? { done: Math.min(i.terrain.done, i.terrain.total), total: i.terrain.total } : undefined;
  const terrain: Stage = { id: "terrain", label: STAGE_LABELS.terrain, status: terrainStatus, ...(count && terrainStatus === "active" ? { count } : {}) };

  const modelsStatus: StageStatus = i.models === "loading" ? "active" : i.models === "ready" ? "done" : i.models === "none" ? "skipped" : i.models === "failed" ? "failed" : "waiting";
  const models: Stage = { id: "models", label: STAGE_LABELS.models, status: modelsStatus, ...(modelsStatus === "failed" ? { message: FAILURE_TEXT.models, short: FAILURE_SHORT.models } : {}) };

  let scene: Stage;
  if (typeof i.scene === "object") scene = { id: "scene", label: STAGE_LABELS.scene, status: "failed", message: FAILURE_TEXT[i.scene.failed], short: FAILURE_SHORT[i.scene.failed] };
  else if (i.models === "none") scene = { id: "scene", label: STAGE_LABELS.scene, status: "skipped" };
  else scene = { id: "scene", label: STAGE_LABELS.scene, status: i.scene === "ready" ? "done" : i.scene === "building" ? "active" : "waiting" };

  return [map, terrain, models, scene];
}

const finished = (s: Stage) => s.status === "done" || s.status === "skipped";

/** 0 to 1: each stage is a quarter; terrain moves by tiles. A failed stage counts as not done. */
export function loadProgress(stages: readonly Stage[]): number {
  if (!stages.length) return 1;
  let sum = 0;
  for (const s of stages) {
    if (finished(s)) sum += 1;
    else if (s.status === "active" && s.count && s.count.total > 0) sum += s.count.done / s.count.total;
  }
  return sum / stages.length;
}

/** Every stage done or skipped: the picture is up. Failed map data counts as done: the picture is drawn without roads (see `loadNotice`). */
export const loadComplete = (stages: readonly Stage[]): boolean => stages.every((s) => finished(s) || (s.id === "map" && s.status === "failed"));

/**
 * What stops the picture from being built: a failed 3D chunk or a failed 3D view. The map data failing is
 * not one of these (the picture is drawn without roads): see `loadNotice`.
 */
export const loadFailure = (stages: readonly Stage[]): Stage | null => stages.find((s) => s.status === "failed" && s.id !== "map") ?? null;

/** A failure the picture is drawn through (only the map data), shown as a notice with Retry. */
export const loadNotice = (stages: readonly Stage[]): Stage | null => stages.find((s) => s.status === "failed" && s.id === "map") ?? null;

/**
 * The headline and what is happening now ("Loading the terrain, 2 of 4."). The live region asks for it without
 * the tile count (`counts: false`), so a screen reader hears each stage once, not every tile.
 */
export function loadMessage(stages: readonly Stage[], { counts = true }: { counts?: boolean } = {}): string {
  const now = stages.find((s) => s.status === "active") ?? stages.find((s) => s.status === "waiting");
  if (!now) return HEADLINE;
  const n = counts && now.count && now.status === "active" ? `, ${now.count.done} of ${now.count.total}` : "";
  return `${HEADLINE} ${ACTIVE_TEXT[now.id]}${n}.`;
}

/** What the live region says once the picture is up. */
export const READY_TEXT = "The scene is ready.";

/** Only the first frame is still to come (everything else is in): a revisit with the code cached draws it in a moment. */
export const onlySceneLeft = (stages: readonly Stage[]): boolean =>
  stages.every((s) => s.id === "scene" || finished(s) || (s.id === "map" && s.status === "failed"));

/** Stages whose status changed between two derivations (for performance marks). */
export function stageChanges(prev: readonly Stage[], next: readonly Stage[]): Array<{ id: StageId; from: StageStatus | null; to: StageStatus }> {
  return next.flatMap((s) => {
    const before = prev.find((p) => p.id === s.id)?.status ?? null;
    return before === s.status ? [] : [{ id: s.id, from: before, to: s.status }];
  });
}
