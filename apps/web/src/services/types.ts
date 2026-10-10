// Every call the UI makes to physics, map data, the proxy and exports goes through
// these interfaces, so the screens work against fakes in tests and the real
// functions in the app. Nothing outside src/services imports @csd/mapdata or
// @csd/exports, and nothing calls fetch.
import type {
  CrossStreetsResult,
  ExportBundle, ExportRequest, LatLon, LocalFrame, PlaceResult, PlainMessage, PlacementOutcome, Pose,
  FixSuggestions, RoadNetwork, Scene, SimulationOutcome, SimulationResult, StreetsAtPin, VehicleModelResult, VehicleResult, Vec2,
} from "@csd/core";

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
  crossStreets(street: string, near: LatLon | null, opts?: { signal?: AbortSignal; ways?: readonly number[] }): Promise<CrossStreetsResult>;
}

export interface RoadsService {
  /** Roads, buildings, parking and terrain around a point (the proxy's Overpass + terrain routes). */
  load(center: LatLon, radiusM?: number): Promise<RoadNetwork>;
}

export interface VehiclesService {
  makes(): Promise<string[]>;
  models(make: string, year: number): Promise<VehicleModelResult[]>;
}

export interface PhysicsService {
  toLocal(frame: LocalFrame, p: LatLon): Vec2;
  toLatLon(frame: LocalFrame, v: Vec2): LatLon;
  streetsAtPin(net: RoadNetwork, pin: Vec2): StreetsAtPin;
  placeVehicles(scene: Scene, roads: RoadNetwork | null, pin: Vec2): PlacementOutcome;
  simulate(scene: Scene, roads: RoadNetwork | null): SimulationOutcome;
  poseAt(sim: SimulationResult, vehicle: VehicleResult, tS: number): Pose;
  checkScene(scene: Scene, roads: RoadNetwork | null): readonly PlainMessage[];
  /** When the picture can't be drawn: why, and up to three small changes that do draw (DESIGN.md section 18). */
  suggestFixes(scene: Scene, roads: RoadNetwork | null): FixSuggestions;
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
  readonly physics: PhysicsService;
  readonly exports: ExportsService;
  readonly pdf: PdfPreviewService;
  readonly examples: ExamplesService;
}
