// The fixer benchmark: a fixed set of refused scenes (docs/FIXER-BENCHMARK.md).
//
// `generateBench()` builds the set from seeded generators (the suggestFixes sweep's random scenes on the three example road
// networks, the property tests' arbitraries on the example networks, synthetic roads and no roads, and pins with no road
// near them), keeps the scenes simulate() refuses, and fills quotas by vehicle count. The result is written once to
// test/data/fixer-bench.jsonl and committed, so the "before" and "after" numbers are measured on exactly the same scenes
// even when the physics changes later. `loadBench()` reads that file back. Synthetic data only.
import { readFileSync } from "node:fs";
import fc from "fast-check";
import type { LatLon, RoadNetwork, Scene, SceneVehicle, Vec2 } from "../../src";
import { SceneSchema, simulate, toLatLon, toLocal } from "../../src";
import { sceneCaseArb } from "../property/arbitraries";
import { NETWORKS, loadRoads, loadScene, randomScene, rng } from "../suggest-sweep";

export type NetName = "t-bone-intersection" | "highway-rear-end" | "parking-lot-backing" | "none";
/**
 * A named example network, no roads ("none"), a small synthetic network stored inline, or an example network as the app
 * would have loaded it around another pin (`around`: the same roads, with the frame's origin at that point).
 */
export type NetRef = NetName | RoadNetwork | { readonly example: Exclude<NetName, "none">; readonly around: LatLon };

export interface BenchCase {
  readonly id: string;
  /** Which generator made it: "sweep", "prop" or "no-road". */
  readonly src: string;
  readonly net: NetRef;
  readonly scene: Scene;
}

const EXAMPLE_NETS = Object.fromEntries(NETWORKS.map(([name, file]) => [name, loadRoads(file)])) as Record<Exclude<NetName, "none">, RoadNetwork>;

const recentredCache = new Map<string, RoadNetwork>();
/** The same roads with the frame's origin moved to `around` (the app loads roads centred on the pin). */
function recentred(example: Exclude<NetName, "none">, around: LatLon): RoadNetwork {
  const key = `${example}@${around.lat},${around.lon}`;
  const hit = recentredCache.get(key);
  if (hit) return hit;
  const src = EXAMPLE_NETS[example], frame = { origin: { lat: around.lat, lon: around.lon } };
  const move = (p: Vec2): Vec2 => toLocal(frame, toLatLon(src.frame, p));
  const out: RoadNetwork = {
    ...src, frame, terrain: null,
    ways: src.ways.map((w) => ({ ...w, centerline: w.centerline.map(move) })),
    buildings: src.buildings.map((b) => ({ ...b, footprint: b.footprint.map(move) })),
    parking: src.parking.map((l) => ({ ...l, outline: l.outline.map(move) })),
  };
  recentredCache.set(key, out);
  return out;
}

export function roadsOf(net: NetRef): RoadNetwork | null {
  if (net === "none") return null;
  if (typeof net === "string") return EXAMPLE_NETS[net];
  return "example" in net ? recentred(net.example, net.around) : net;
}

/** Quotas of refused scenes by vehicle count, per generator. */
const QUOTA: Readonly<Record<string, Readonly<Record<number, number>>>> = {
  // Per example network (three of them).
  sweep: { 2: 50, 3: 25, 4: 17 },
  prop: { 2: 150, 3: 75, 4: 50 },
  "no-road": { 2: 12, 3: 6, 4: 4 },
};

/** The fields every bench scene shares; only location, road condition and vehicles vary. */
const TEMPLATE = {
  schemaVersion: 4 as const,
  claim: { number: "CLM-BENCH", vehicle: { year: null, make: "", model: "" } },
  occurred: { date: "2026-10-02", time: "17:15" },
};

function normalise(scene: Scene): Scene {
  return {
    ...TEMPLATE,
    location: { ...scene.location, label: "Synthetic test location", nearLabel: "", source: "pin" },
    road: scene.road,
    vehicles: scene.vehicles.map((v): SceneVehicle => ({ ...v, role: v.id === "A" ? "claimant" : "other", year: null, make: "", model: "", typeSource: "manual" })),
  };
}

function refused(scene: Scene, roads: RoadNetwork | null): boolean {
  if (!SceneSchema.safeParse(scene).success) return false;
  return !simulate(scene, roads).ok;
}

/** Build the benchmark from the seeded generators. Deterministic; slow (thousands of simulations). */
export function generateBench(): BenchCase[] {
  const out: BenchCase[] = [];
  const counts = new Map<string, number>();
  /** The sweep fills its quota on each example network; the other generators fill theirs overall. */
  const bucket = (src: string, net: NetRef, n: number): string => `${src}:${src === "sweep" ? String(net) : ""}:${n}`;
  const want = (src: string, n: number, net: NetRef = "none"): boolean => (counts.get(bucket(src, net, n)) ?? 0) < (QUOTA[src]?.[n] ?? 0);
  const take = (src: string, net: NetRef, scene: Scene): void => {
    const s = normalise(scene), key = bucket(src, net, s.vehicles.length);
    if (!want(src, s.vehicles.length, net) || !refused(s, roadsOf(net))) return;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    out.push({ id: `${src}-${String(out.filter((c) => c.src === src).length + 1).padStart(3, "0")}`, src, net, scene: s });
  };

  // 1. The suggestFixes sweep's scenes: directions are the ones step 2 offers at each example pin. Three and four vehicles
  //    are rarer there, so a second pass forces the vehicle count.
  for (const [example] of NETWORKS) {
    const base = loadScene(example), roads = EXAMPLE_NETS[example], rnd = rng(20261010 + example.length);
    for (let i = 0; i < 4000; i++) {
      const scene = randomScene(base, roads, rnd);
      take("sweep", example, scene);
      if (!want("sweep", 2, example) && !want("sweep", 3, example) && !want("sweep", 4, example)) break;
    }
  }

  // 2. The property tests' arbitraries: example networks with the pin up to 15 m off, synthetic straight and crossing roads,
  //    and no road data at all; random speeds (up to 150 mph), bearings, braking and road conditions.
  const samples = fc.sample(sceneCaseArb, { seed: 20261011, numRuns: 6000 });
  for (const { env, scene } of samples) {
    const net: NetRef = env.roads === null ? "none" : env.name in EXAMPLE_NETS ? (env.name as NetName) : env.roads;
    take("prop", net, scene);
  }

  // 3. No road near the pin: the example scenes with the pin moved 50 to 200 m into a spot with no road or parking lot within
  //    reach, on the example's roads as the app would load them around that pin (the frame's origin at the pin), with the
  //    compass directions step 2 offers there.
  const rnd = rng(7);
  for (let i = 0; i < 3000 && (want("no-road", 2) || want("no-road", 3) || want("no-road", 4)); i++) {
    const [example] = NETWORKS[i % NETWORKS.length]!;
    const roads = EXAMPLE_NETS[example];
    const base = randomScene(loadScene(example), roads, rnd);
    const at = toLatLon(roads.frame, { x: (rnd() * 2 - 1) * 200, y: (rnd() * 2 - 1) * 200 });
    // With no street at the pin, step 2 offers north, east, south and west only: no road ids or names.
    const vehicles = base.vehicles.map((v) => ({ ...v, travel: { bearingDeg: [0, 90, 180, 270][Math.floor(rnd() * 4)]!, roadId: null, roadName: null, lane: null } }));
    const scene: Scene = { ...base, vehicles, location: { ...base.location, lat: Math.round(at.lat * 1e7) / 1e7, lon: Math.round(at.lon * 1e7) / 1e7 } };
    const net: NetRef = { example, around: { lat: scene.location.lat, lon: scene.location.lon } };
    const r = simulate(normalise(scene), roadsOf(net));
    if (!r.ok && r.errors[0]?.code === "no-road") take("no-road", net, scene);
  }
  return out;
}

const BENCH_FILE = new URL("../data/fixer-bench.jsonl", import.meta.url);

/** One JSON object per line, in a fixed key order. */
export const toJsonl = (cases: readonly BenchCase[]): string => cases.map((c) => JSON.stringify(c)).join("\n") + "\n";

export function loadBench(): BenchCase[] {
  return readFileSync(BENCH_FILE, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as BenchCase);
}
export const BENCH_PATH = BENCH_FILE;
