// Fake services for component tests, built on the app's own stand-ins and the cached examples.
import { vi } from "vitest";
import { canonicalJson, parseScene, type CrossStreet, type ExportBundle, type PlaceResult, type RoadNetwork, type Scene, type VehicleModelResult } from "@csd/core";
import tboneScene from "../../../examples/t-bone-intersection/scene.json";
import tboneOsm from "../../../examples/t-bone-intersection/osm.json";
import highwayScene from "../../../examples/highway-rear-end/scene.json";
import {
  fakeCheckScene, fakeSuggestFixes, fakeMergeSearchResults, fakeParseOverpass, fakePlaceVehicles, fakePoseAt, fakeSimulate,
  fakeDirectionChoices, fakeRoadFitProblems, fakeStreetsAtPin, fakeToLatLon, fakeToLocal,
} from "../src/services/fakes";
import type { ExportInput, Services, StreetInTown, TownPlace } from "../src/services/types";
import { resolveMake } from "../src/services/vehicles";
import { createFixer } from "../src/fixer/client";
import { createFixMemory } from "../src/fixer/memory";
import { createMediaService } from "../src/services/media";

export const tbone: Scene = (() => {
  const p = parseScene(tboneScene);
  if (!p.ok) throw new Error("example scene is invalid");
  return p.value;
})();

export const highway: Scene = (() => {
  const p = parseScene(highwayScene);
  if (!p.ok) throw new Error("example scene is invalid");
  return p.value;
})();

export const tboneNet = (): RoadNetwork => fakeParseOverpass(tboneOsm, { origin: tbone.location }, 250, "2026-10-09T00:00:00Z");

export const MAIN_PARK: PlaceResult = {
  label: "Main Street & Park Street, Nashua, New Hampshire", main: "Main Street & Park Street", sub: "Nashua, New Hampshire",
  lat: tbone.location.lat, lon: tbone.location.lon, kind: "intersection", streets: ["Main Street", "Park Street"],
};

export const FORD_MODELS: VehicleModelResult[] = [{ name: "Escape", vpicType: "Multipurpose Passenger Vehicle (MPV)", type: "suv" }, { name: "F-150", vpicType: "Truck", type: "pickup" }];

export function makeServices(over: Omit<Partial<Services>, "roads"> & { roads?: Services["roads"] | "none" } = {}) {
  const search = vi.fn(async (_q: string): Promise<PlaceResult[]> => [MAIN_PARK]);
  const load = vi.fn(async () => tboneNet());
  const makes = vi.fn(async () => ["Ford", "Honda", "Toyota"]);
  const models = vi.fn(async (_make: string, _year: number): Promise<VehicleModelResult[]> => FORD_MODELS);
  // A bundle with just the scene file; jsdom has no Web Crypto, so the fingerprint is a stand-in.
  const build = vi.fn(async (req: ExportInput): Promise<ExportBundle> => ({
    stamp: { createdAt: "2026-10-09T19:42:07Z", fingerprintHex: "0".repeat(64), fingerprintShort: "0000 0000 0000 0000" },
    files: [{ name: "crash-scene.json", mime: "application/json", bytes: new TextEncoder().encode(canonicalJson(req.scene)) }],
    skipped: [],
    notes: [],
  }));
  const checkScene = vi.fn(fakeCheckScene);
  const roads: Services["roads"] = over.roads === "none" ? { load: vi.fn(async () => ({ ...tboneNet(), ways: [], buildings: [], parking: [] })) } : (over.roads ?? { load });
  const services: Services = {
    fixer: createFixer({ makeWorker: null, run: (scene, roads, o) => services.physics.suggestFixes(scene, roads, o) }),
    fixMemory: createFixMemory(),
    mode: "fixtures",
    geo: {
      search, suggest: vi.fn(async (_q: string, _o?: unknown) => [] as PlaceResult[]), crossStreets: vi.fn(async (street: string) => ({ street, crossings: [] as CrossStreet[] })),
      town: vi.fn(async (_t: string, _o?: unknown): Promise<TownPlace | null> => null), streetIn: vi.fn(async (_s: string, _t: string, _o?: unknown): Promise<StreetInTown | null> => null),
    },
    vehicles: { makes, models, canonicalMake: (text: string) => resolveMake(text, ["Ford", "Honda", "Toyota"]) },
    // Every media call answers the fallback unless a test passes its own.
    media: createMediaService(async () => new Response(null, { status: 204 })),
    physics: {
      toLocal: fakeToLocal, toLatLon: fakeToLatLon, streetsAtPin: fakeStreetsAtPin, placeVehicles: fakePlaceVehicles, simulate: fakeSimulate, poseAt: fakePoseAt, checkScene, suggestFixes: fakeSuggestFixes,
      directionChoices: fakeDirectionChoices, roadFitProblems: fakeRoadFitProblems,
    },
    exports: { build },
    pdf: { open: vi.fn(async (_bytes: Uint8Array) => ({ numPages: 1, renderPage: vi.fn(async () => undefined), destroy: vi.fn() })) },
    examples: { names: () => ["t-bone-intersection"], load: async (n) => (n === "t-bone-intersection" ? tbone : null) },
    ...over,
    roads,
  };
  return { services, search, load, makes, models, build, checkScene, mergeResults: fakeMergeSearchResults };
}

/**
 * The vehicles answered the way the old default claim prefilled them (a new visitor now starts with nothing answered):
 * A a car going straight at 25 mph, hit on the left; B an SUV going straight at 30 mph, hit in front. Directions are not
 * touched (tests pick or mark them themselves). For tests about a claimant who has answered the vehicle questions.
 */
export function withAnswers<D extends { scene: Scene; unanswered?: unknown }>(doc: D): D {
  const answers: Record<string, Partial<Scene["vehicles"][number]>> = {
    A: { type: "car", action: "straight", speed: { kind: "known", mph: 25 }, zone: "left" },
    B: { type: "suv", action: "straight", speed: { kind: "known", mph: 30 }, zone: "front" },
  };
  return { ...doc, unanswered: doc.scene.vehicles.map(() => []), scene: { ...doc.scene, vehicles: doc.scene.vehicles.map((v) => ({ ...v, ...answers[v.id] })) } };
}

/**
 * Vehicle A entered as a 2021 Honda Accord (what the old default claim prefilled; a new visitor now starts empty).
 * For tests about a card that already has a vehicle in it. The claim's vehicle mirrors A, as the reducer keeps it.
 */
export function withAccordA<D extends { scene: Scene }>(doc: D): D {
  const car = { year: 2021, make: "Honda", model: "Accord" };
  return { ...doc, scene: { ...doc.scene, claim: { ...doc.scene.claim, vehicle: car }, vehicles: doc.scene.vehicles.map((v) => (v.id === "A" ? { ...v, ...car, typeSource: "claim" as const } : v)) } };
}

