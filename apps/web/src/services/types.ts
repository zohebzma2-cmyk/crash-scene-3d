// Every call the UI makes to physics, map data, the proxy and exports goes through
// these interfaces, so the screens work against fakes in tests and the real
// functions in the app. Nothing outside src/services imports @csd/mapdata or
// @csd/exports, and nothing calls fetch.
import type {
  CrossStreetsResult,
  ExportBundle, ExportRequest, LatLon, LocalFrame, PlaceResult, PlainMessage, PlacementOutcome, Pose,
  FixOptions, FixSuggestions, RoadNetwork, Scene, SimulationOutcome, SimulationResult, StreetsAtPin, VehicleModelResult, VehicleResult, Vec2,
} from "@csd/core";
import type { FixerService } from "../fixer/client";
import type { FixMemory } from "../fixer/memory";
import type { MediaService } from "./media";

export type { MediaAnswer, MediaService, VehicleRef } from "./media";
import type { VehicleModelsService } from "./vehicle-models";

export type ServiceErrorCode = "busy" | "timeout" | "upstream" | "bad-request" | "not-found" | "network" | "bad-response";

/** An error whose message is safe to show as text (a ProxyError.message, or our own plain sentence). */
export class ServiceError extends Error {
  readonly code: ServiceErrorCode;
  readonly retryAfterS: number | undefined;
  constructor(message: string, code: ServiceErrorCode, retryAfterS?: number) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
    this.retryAfterS = retryAfterS;
  }
}

export interface SearchOptions {
  /** Where to look first when the text is "A and B" with no town (sent as lat and lon to /api/geo/crossing). */
  readonly bias?: LatLon | null;
  /** The town and state from the claim ("Nashua, NH"): the `near` text when "A and B" names no town and there is no bias. */
  readonly town?: string | null;
  /** Called when the 1 request/second queue makes the search wait. */
  readonly onWait?: () => void;
}

export interface SuggestOptions {
  /** The map view, west,south,east,north: results inside it come first. */
  readonly bbox?: readonly [number, number, number, number] | null;
  /** Where to look first: the claim's location, else the pin, else the middle of the map. */
  readonly bias?: LatLon | null;
  readonly signal?: AbortSignal;
  /** Called when the proxy answered "busy" and the request is tried once more after a short wait. */
  readonly onBusy?: () => void;
}

export interface CrossStreetsOptions {
  readonly signal?: AbortSignal;
  readonly ways?: readonly number[];
  /** Called when the proxy answered "busy" and the request is tried once more after a short wait. */
  readonly onBusy?: () => void;
}

/** A town found by name ("Nashua, NH"): where it is, its state's two-letter code, and "Town, ST". */
export interface TownPlace {
  readonly point: LatLon;
  readonly state: string | null;
  readonly label: string;
}

/** A street found in a typed town: its name as the map spells it, a point on it, its OSM way ids, and "Town, ST". */
export interface StreetInTown {
  readonly name: string;
  readonly at: LatLon;
  readonly ways: readonly number[];
  readonly place: string;
}

export interface GeoService {
  /**
   * "X and Y" / "X & Y" goes to /api/geo/crossing; anything else to /api/geo/search.
   * Duplicate street segments are merged; at most 5 results. Never called with the claim address
   * unless the claimant taps Search.
   */
  search(query: string, opts?: SearchOptions): Promise<PlaceResult[]>;
  /**
   * Type-ahead (Photon through /api/geo/suggest): at least 3 characters, cached for the session, results
   * biased toward `bias`; each result carries "Town, State" in `sub`. Aborts with an AbortError when the
   * signal fires.
   */
  suggest(query: string, opts?: SuggestOptions): Promise<PlaceResult[]>;
  /** The streets that really cross `street` near a point (/api/geo/cross-streets), each with its crossing point. */
  crossStreets(street: string, near: LatLon | null, opts?: CrossStreetsOptions): Promise<CrossStreetsResult>;
  /** Where a town is ("Nashua, NH"), from the type-ahead; never a place in another state than the one typed. Null when not found. */
  town(text: string, opts?: { signal?: AbortSignal }): Promise<TownPlace | null>;
  /**
   * A street in a typed town ("Elm St" in "Manchester NH"): the street itself when the type-ahead finds it there,
   * else the town's spot with the typed name. Null when neither can be found.
   */
  streetIn(street: string, town: string, opts?: { signal?: AbortSignal }): Promise<StreetInTown | null>;
}

/** How far a roads load has got: the roads are in and the terrain tiles are arriving. */
export interface RoadsProgress {
  readonly terrainDone: number;
  readonly terrainTotal: number;
}

export interface RoadsService {
  /** Roads, buildings, parking and terrain around a point (the proxy's Overpass + terrain routes). */
  load(center: LatLon, radiusM?: number, onProgress?: (p: RoadsProgress) => void): Promise<RoadNetwork>;
  /** Is a load for exactly this point already running (started early, e.g. at boot for an example)? */
  inFlight?(center: LatLon, radiusM?: number): boolean;
}

export interface ModelsOptions {
  /** The claimant typed on: stop waiting (an AbortError), though a request already sent still fills the cache. */
  readonly signal?: AbortSignal;
}

export interface VehiclesService {
  /** vPIC makes, fetched once a session. */
  makes(): Promise<string[]>;
  /**
   * Model lists for a make and model year: one request per make and year for the session, under the makes
   * list's spelling of the make ("chevy" asks for Chevrolet). A make the list doesn't know waits a little
   * longer first, so a half-typed make is not asked for. Failures are ServiceErrors worded for the vehicle list.
   */
  models(make: string, year: number, opts?: ModelsOptions): Promise<VehicleModelResult[]>;
  /** The makes list's spelling of a typed make, or null (not a known make, or the list isn't loaded). */
  canonicalMake(text: string): string | null;
}

export interface PhysicsService {
  toLocal(frame: LocalFrame, p: LatLon): Vec2;
  toLatLon(frame: LocalFrame, v: Vec2): LatLon;
  streetsAtPin(net: RoadNetwork, pin: Vec2): StreetsAtPin;
  placeVehicles(scene: Scene, roads: RoadNetwork | null, pin: Vec2): PlacementOutcome;
  simulate(scene: Scene, roads: RoadNetwork | null): SimulationOutcome;
  poseAt(sim: SimulationResult, vehicle: VehicleResult, tS: number): Pose;
  checkScene(scene: Scene, roads: RoadNetwork | null): readonly PlainMessage[];
  /** When the picture can't be drawn: why, and up to three small changes that do draw (DESIGN.md section 18). On the main thread: the app calls it through `fixer`. */
  suggestFixes(scene: Scene, roads: RoadNetwork | null, opts?: FixOptions): FixSuggestions;
}

/** What the Save step supplies; the service adds the brand fonts and the clock. */
export type ExportInput = Omit<ExportRequest, "fonts" | "now">;

export interface ExportsService {
  build(input: ExportInput): Promise<ExportBundle>;
}

/** One opened PDF, for the Save step's preview of the real file. */
export interface PdfPreviewDocument {
  readonly numPages: number;
  /** Draw page n (1-based) onto the canvas, scaled to the given CSS width. */
  renderPage(n: number, canvas: HTMLCanvasElement, cssWidthPx: number): Promise<void>;
  destroy(): void;
}
export interface PdfPreviewService {
  open(bytes: Uint8Array): Promise<PdfPreviewDocument>;
}

export interface ExamplesService {
  names(): readonly string[];
  load(name: string): Promise<Scene | null>;
}

export interface Services {
  /** "fixtures" = examples/* only; nothing calls /api. */
  readonly mode: "live" | "fixtures";
  readonly geo: GeoService;
  readonly roads: RoadsService;
  readonly vehicles: VehiclesService;
  /** Vehicle photos, 3D models and maker logos, from our own /api (fixtures: synthetic files, see media-fixtures.ts). */
  readonly media: MediaService;
  readonly physics: PhysicsService;
  /** The one-tap fixer's search, in a Web Worker when the browser has one. */
  readonly fixer: FixerService;
  /** Which kinds of fix the claimant on this device picked before (localStorage only). */
  readonly fixMemory: FixMemory;
  readonly exports: ExportsService;
  readonly pdf: PdfPreviewService;
  readonly examples: ExamplesService;
  /** Catalog 3D models (round B). Optional: without it the viewer always draws our own low-poly models. */
  readonly vehicleModels?: VehicleModelsService;
}
