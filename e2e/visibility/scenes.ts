// The scenes the visibility sweep runs: the three examples, then random VALID scenes on the three example road
// networks. The random ones come from the physics property tests' fast-check arbitraries (seeded, so a run is
// repeatable) and are kept only when simulate() accepts them on the same road network the fixtures build loads
// (the example's cached OSM, parsed around the scene's own pin, as services/fixtures.ts does).
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { simulate, type RoadNetwork, type Scene } from "../../packages/core/src";
import { parseOverpass } from "../../packages/mapdata/src";
import { sceneCaseArb } from "../../packages/core/test/property/arbitraries";
import { EXAMPLES, LONG_DISCLAIMER, type ExampleName } from "../helpers";

/** The seed for the random scenes (SWEEP_SEED replays another). */
export const SWEEP_SEED = Number(process.env["SWEEP_SEED"] ?? 20261010);
/** How many random valid scenes run besides the examples. Small by default (check.sh); SWEEP_N=300 for a deep run. */
export const SWEEP_N = Number(process.env["SWEEP_N"] ?? 6);

export interface SweepScene {
  /** "example:<name>" or "random:<seed>#<index>". */
  readonly id: string;
  readonly network: ExampleName;
  readonly scene: Scene;
}

const osm = (name: ExampleName): unknown => JSON.parse(readFileSync(new URL(`../../examples/${name}/osm.json`, import.meta.url), "utf8"));
const exampleScene = (name: ExampleName): Scene => JSON.parse(readFileSync(new URL(`../../examples/${name}/scene.json`, import.meta.url), "utf8")) as Scene;

/** The road network the fixtures build loads for a scene on an example's map (services/fixtures.ts createFixtureRoads, default radius). */
export function appNetwork(name: ExampleName, scene: Scene): RoadNetwork {
  return parseOverpass(osm(name), { origin: { lat: scene.location.lat, lon: scene.location.lon } }, 250, "2026-10-09T12:00:00Z");
}

/** A scene file the app's "Open a saved scene file" accepts. */
export const sceneFile = (scene: Scene): string => JSON.stringify({ ...scene, createdAt: "2026-10-01T12:00:00Z", disclaimer: LONG_DISCLAIMER });

let cache: SweepScene[] | null = null;

export function sweepScenes(): SweepScene[] {
  if (cache) return cache;
  const out: SweepScene[] = EXAMPLES.map((name) => ({ id: `example:${name}`, network: name, scene: exampleScene(name) }));
  const real = new Set<string>(EXAMPLES);
  // Draw candidates in batches until enough are accepted; the order (and so each index) is fixed by the seed.
  const candidates = fc.sample(sceneCaseArb.filter((c) => real.has(c.env.name)), { seed: SWEEP_SEED, numRuns: Math.max(SWEEP_N * 8, 40) });
  let i = 0;
  for (const c of candidates) {
    if (out.length - EXAMPLES.length >= SWEEP_N) break;
    const idx = i++;
    const name = c.env.name as ExampleName;
    let ok = false;
    try { ok = simulate(c.scene, appNetwork(name, c.scene)).ok; } catch { ok = false; }
    if (ok) out.push({ id: `random:${SWEEP_SEED}#${idx}`, network: name, scene: c.scene });
  }
  cache = out;
  return out;
}
