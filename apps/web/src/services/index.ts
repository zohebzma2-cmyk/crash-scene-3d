// Wires the UI's service interfaces to the real functions (and, in fixtures mode, to the examples).
// The lead can swap any piece here; nothing else in the app imports @csd/mapdata or @csd/exports.
import { checkScene, directionChoices, placeVehicles, poseAt, roadFitProblems, simulate, streetsAtPin, suggestFixes, toLatLon, toLocal } from "@csd/core";
import { mergeSearchResults, parseOverpass, splitCrossingQuery } from "@csd/mapdata";
import type { buildExports as BuildExports } from "@csd/exports";

/**
 * pdf-lib and the exports are a lazy chunk: only a save needs them (the save step starts it early). Every argument
 * is passed on (typed as the real function, so none can be dropped): the third is the stock photo provider, and
 * leaving it out once made every saved PDF and still lose its photos (2026-10-11).
 */
const buildExports: typeof BuildExports = (...args) => import("@csd/exports").then((m) => m.buildExports(...args));
import { createBrowserCanvasFactory, loadBrandFonts } from "../exports/browser-canvas";
import { createExportsService } from "./exports";
import {
  fakeBuildExports, fakeCheckScene, fakeDirectionChoices, fakeRoadFitProblems, fakeSuggestFixes, fakeMergeSearchResults, fakeParseOverpass, fakePlaceVehicles, fakePoseAt,
  fakeSimulate, fakeSplitCrossingQuery, fakeStreetsAtPin, fakeToLatLon, fakeToLocal,
} from "./fakes";
import { withFallback } from "./fallbacks";
import { createExamplesService } from "./examples";
import { createFixtureGeo, createFixtureRoads, createFixtureVehicles, fixturesAllowed, fixturesRequested, loadCuratedRoads } from "./fixtures";
import { createGeoService } from "./geo";
import { createPdfPreviewService } from "./pdfPreview";
import { createRoadsService, shareRoadLoads, ROAD_RADIUS_M, type RoadsDeps } from "./roads";
import type { RoadsService } from "./types";
import { loadTerrain } from "./terrain";
import type { Services } from "./types";
import { createFixer, type WorkerLike } from "../fixer/client";
import { createFixMemory } from "../fixer/memory";
import { createVehiclesService } from "./vehicles";
import { createMediaService } from "./media";
import { createFixtureMediaFetch, fixtureMediaMode } from "./media-fixtures";
import { createFixtureModelFetch, createVehicleModelsService } from "./vehicle-models";

// Fixture GLBs (scripts/make-fixture-glb.mjs) exist only in a dev server or a VITE_FIXTURES=1 build, like the map data.
const FIXTURE_BUILD = import.meta.env.DEV || import.meta.env.VITE_FIXTURES === "1";
const fixtureModels = (FIXTURE_BUILD ? import.meta.glob("../../fixtures/models/*.glb", { query: "?url", import: "default" }) : {}) as Record<string, () => Promise<string>>;

export * from "./types";
export type { VehicleModelAsset, VehicleModelQuery, VehicleModelsService } from "./vehicle-models";
export { fixturesAllowed, fixturesRequested };

export interface CreateServicesOptions {
  readonly fixtures: boolean;
  readonly fetch?: typeof globalThis.fetch;
  /** The page's query string, for fixtures mode's ?media= switch (defaults to the window's). */
  readonly search?: string;
  /**
   * Fixture builds only (?vehicles=proxy): the real vehicle service through /api/vehicles/* while everything
   * else stays on fixtures, so a test can put a fake proxy behind it (e2e/vehicles-typing.spec.ts).
   */
  readonly vehiclesFromProxy?: boolean;
  /**
   * Fixture builds only (?models=proxy): catalog 3D models are asked for at /api/vehicles/model on the network, so a
   * test can see (and hold) those requests (e2e/vehicles-fixes.spec.ts: none while on the Vehicles step).
   */
  readonly modelsFromProxy?: boolean;
  /**
   * Fixture builds only (?geo=proxy): the real geo service (type-ahead, cross streets, search) through /api/geo/*
   * while the roads and everything else stay on fixtures, so a test can put a fake proxy behind it
   * (e2e/search-slow.spec.ts: a slow or busy type-ahead).
   */
  readonly geoFromProxy?: boolean;
}

/** ?vehicles=proxy, honoured only where fixtures are allowed (a dev server or a VITE_FIXTURES=1 build). */
export function vehiclesFromProxyRequested(search: string): boolean {
  return fixturesAllowed() && new URLSearchParams(search).get("vehicles") === "proxy";
}

/** ?geo=proxy, honoured only where fixtures are allowed. */
export function geoFromProxyRequested(search: string): boolean {
  return fixturesAllowed() && new URLSearchParams(search).get("geo") === "proxy";
}

/** ?models=proxy, honoured only where fixtures are allowed. */
export function modelsFromProxyRequested(search: string): boolean {
  return fixturesAllowed() && new URLSearchParams(search).get("models") === "proxy";
}

/**
 * Live roads, but if a live Overpass fetch fails and the pin sits right on a bundled example location (a famous
 * curated intersection, or an NH example), serve that example's baked roads instead of an empty scene. Nowhere
 * bundled nearby: the live failure is re-thrown, so the app shows its honest "roads couldn't load" notice over
 * the map tiles and the recreation still plays (the person can pick directions by hand).
 */
function withCuratedFallback(live: RoadsService, deps: RoadsDeps): RoadsService {
  return {
    async load(center, radiusM = ROAD_RADIUS_M, onProgress) {
      try {
        return await live.load(center, radiusM, onProgress);
      } catch (e) {
        const curated = await loadCuratedRoads(center, radiusM, deps, onProgress).catch(() => null);
        if (curated) return curated;
        throw e;
      }
    },
  };
}

export function createServices(opts: CreateServicesOptions): Services {
  // Fixtures exist only in a dev server or a VITE_FIXTURES=1 build, whatever the caller asks for.
  const fx = opts.fixtures && fixturesAllowed();
  const fetchFn = (input: string, init?: RequestInit) => (opts.fetch ?? globalThis.fetch.bind(globalThis))(input, init);
  const split = withFallback(splitCrossingQuery, fakeSplitCrossingQuery, fx);
  const merge = withFallback(mergeSearchResults, fakeMergeSearchResults, fx) as typeof mergeSearchResults;
  const parse = withFallback(parseOverpass, fakeParseOverpass, fx);
  const roadsDeps = { parseOverpass: parse, terrain: loadTerrain };
  const physics: Services["physics"] = {
    toLocal: withFallback(toLocal, fakeToLocal, fx),
    toLatLon: withFallback(toLatLon, fakeToLatLon, fx),
    streetsAtPin: withFallback(streetsAtPin, fakeStreetsAtPin, fx),
    placeVehicles: withFallback(placeVehicles, fakePlaceVehicles, fx),
    simulate: withFallback(simulate, fakeSimulate, fx),
    poseAt: withFallback(poseAt, fakePoseAt, fx),
    checkScene: withFallback(checkScene, fakeCheckScene, fx),
    directionChoices: withFallback(directionChoices, fakeDirectionChoices, fx),
    roadFitProblems: withFallback(roadFitProblems, fakeRoadFitProblems, fx),
    suggestFixes: withFallback(suggestFixes, fakeSuggestFixes, fx),
  };
  // A module worker built by Vite into its own file on this origin (CSP worker-src 'self'); none where the browser has no Worker.
  const makeWorker = typeof Worker === "function"
    ? () => new Worker(new URL("../fixer/fixer.worker.ts", import.meta.url), { type: "module", name: "fixer" }) as unknown as WorkerLike
    : null;
  const search = opts.search ?? (typeof window !== "undefined" ? window.location.search : "");
  // An example scene (/?example=<name>) serves its roads and terrain from the bundled cache even in a live
  // production build, so the demo never depends on a live Overpass call. Everything else (vehicles, media,
  // geo) stays live, so the example still shows real catalog vehicles.
  const exampleMap = !fx && new URLSearchParams(search).has("example");
  // ?media=proxy (fixture builds only, like ?vehicles=proxy / ?models=proxy): fetch the real catalog photos
  // and logos through /api instead of the synthetic fixture files, so a demo recording shows real vehicles.
  const mediaProxy = fixturesAllowed() && new URLSearchParams(search).get("media") === "proxy";
  const mediaFetch = fx && !mediaProxy ? createFixtureMediaFetch(fixtureMediaMode(search)) : fetchFn;
  const media = createMediaService(mediaFetch);
  return {
    mode: fx ? "fixtures" : "live",
    media,
    geo: fx && !opts.geoFromProxy ? createFixtureGeo(split, roadsDeps) : createGeoService(fetchFn, { splitCrossing: split, mergeResults: merge }),
    roads: shareRoadLoads(fx || exampleMap ? createFixtureRoads(roadsDeps) : withCuratedFallback(createRoadsService(fetchFn, roadsDeps), roadsDeps)),
    vehicles: fx && !opts.vehiclesFromProxy ? createFixtureVehicles() : createVehiclesService(fetchFn),
    physics,
    fixer: createFixer({ makeWorker, run: (scene, roads, o) => physics.suggestFixes(scene, roads, o) }),
    fixMemory: createFixMemory(),
    exports: createExportsService({
      buildExports: withFallback(buildExports, (req) => fakeBuildExports(req), fx),
      canvas: createBrowserCanvasFactory(),
      loadFonts: () => loadBrandFonts(),
      // Only photos this session already showed on a card: saving never spends a provider call.
      media: { vehiclePhoto: (v) => media.photoPng(v, { cachedOnly: true }) },
    }),
    pdf: createPdfPreviewService(),
    examples: createExamplesService(),
    // The one client of the model route; in fixtures mode the synthetic GLBs answer first, then images' media fixtures.
    vehicleModels: createVehicleModelsService(fx && !opts.modelsFromProxy ? createFixtureModelFetch(fixtureModels, mediaFetch) : fetchFn),
  };
}
