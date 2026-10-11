// Wires the UI's service interfaces to the real functions (and, in fixtures mode, to the examples).
// The lead can swap any piece here; nothing else in the app imports @csd/mapdata or @csd/exports.
import { checkScene, placeVehicles, poseAt, simulate, streetsAtPin, suggestFixes, toLatLon, toLocal } from "@csd/core";
import { mergeSearchResults, parseOverpass, splitCrossingQuery } from "@csd/mapdata";
import type { CanvasFactory } from "@csd/exports";
import type { ExportRequest } from "@csd/core";

/** pdf-lib and the exports are a lazy chunk: only a save needs them (the save step starts it early). */
const buildExports = (req: ExportRequest, canvas: CanvasFactory) => import("@csd/exports").then((m) => m.buildExports(req, canvas));
import { createBrowserCanvasFactory, loadBrandFonts } from "../exports/browser-canvas";
import { createExportsService } from "./exports";
import {
  fakeBuildExports, fakeCheckScene, fakeSuggestFixes, fakeMergeSearchResults, fakeParseOverpass, fakePlaceVehicles, fakePoseAt,
  fakeSimulate, fakeSplitCrossingQuery, fakeStreetsAtPin, fakeToLatLon, fakeToLocal,
} from "./fakes";
import { withFallback } from "./fallbacks";
import { createExamplesService } from "./examples";
import { createFixtureGeo, createFixtureRoads, createFixtureVehicles, fixturesAllowed, fixturesRequested } from "./fixtures";
import { createGeoService } from "./geo";
import { createPdfPreviewService } from "./pdfPreview";
import { createRoadsService, shareRoadLoads } from "./roads";
import { loadTerrain } from "./terrain";
import type { Services } from "./types";
import { createFixer, type WorkerLike } from "../fixer/client";
import { createFixMemory } from "../fixer/memory";
import { createVehiclesService } from "./vehicles";

export * from "./types";
export { fixturesAllowed, fixturesRequested };

export interface CreateServicesOptions {
  readonly fixtures: boolean;
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Fixture builds only (?vehicles=proxy): the real vehicle service through /api/vehicles/* while everything
   * else stays on fixtures, so a test can put a fake proxy behind it (e2e/vehicles-typing.spec.ts).
   */
  readonly vehiclesFromProxy?: boolean;
}

/** ?vehicles=proxy, honoured only where fixtures are allowed (a dev server or a VITE_FIXTURES=1 build). */
export function vehiclesFromProxyRequested(search: string): boolean {
  return fixturesAllowed() && new URLSearchParams(search).get("vehicles") === "proxy";
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
    suggestFixes: withFallback(suggestFixes, fakeSuggestFixes, fx),
  };
  // A module worker built by Vite into its own file on this origin (CSP worker-src 'self'); none where the browser has no Worker.
  const makeWorker = typeof Worker === "function"
    ? () => new Worker(new URL("../fixer/fixer.worker.ts", import.meta.url), { type: "module", name: "fixer" }) as unknown as WorkerLike
    : null;
  return {
    mode: fx ? "fixtures" : "live",
    geo: fx ? createFixtureGeo(split, roadsDeps) : createGeoService(fetchFn, { splitCrossing: split, mergeResults: merge }),
    roads: shareRoadLoads(fx ? createFixtureRoads(roadsDeps) : createRoadsService(fetchFn, roadsDeps)),
    vehicles: fx && !opts.vehiclesFromProxy ? createFixtureVehicles() : createVehiclesService(fetchFn),
    physics,
    fixer: createFixer({ makeWorker, run: (scene, roads, o) => physics.suggestFixes(scene, roads, o) }),
    fixMemory: createFixMemory(),
    exports: createExportsService({
      buildExports: withFallback(buildExports, (req) => fakeBuildExports(req), fx),
      canvas: createBrowserCanvasFactory(),
      loadFonts: () => loadBrandFonts(),
    }),
    pdf: createPdfPreviewService(),
    examples: createExamplesService(),
  };
}
