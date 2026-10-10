// Seeded random scenes on the example road networks, for the suggestFixes tests. Deterministic: the same seed gives the same scenes.
import { readFileSync } from "node:fs";
import type { RoadNetwork, Scene, SceneVehicle } from "../src";
import { ACTIONS, VEHICLE_IDS, VEHICLE_TYPES, ZONES, streetsAtPin, toLocal } from "../src";

export const NETWORKS = [
  ["t-bone-intersection", "t-bone-intersection-roads.json"],
  ["highway-rear-end", "highway-rear-end-roads.json"],
  ["parking-lot-backing", "parking-lot-backing-roads.json"],
] as const;

export const loadRoads = (f: string): RoadNetwork => JSON.parse(readFileSync(new URL(`./data/${f}`, import.meta.url), "utf8")) as RoadNetwork;
export const loadScene = (n: string): Scene => JSON.parse(readFileSync(new URL(`../../../examples/${n}/scene.json`, import.meta.url), "utf8")) as Scene;

/** A small linear congruential generator: deterministic across runs and platforms. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; };
}

/** A random scene a claimant could enter at the example's pin: directions are the ones step 2 offers there. */
export function randomScene(base: Scene, roads: RoadNetwork, rnd: () => number): Scene {
  const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
  const dirs = streetsAtPin(roads, toLocal(roads.frame, base.location)).directions;
  const n = rnd() < 0.8 ? 2 : rnd() < 0.7 ? 3 : 4;
  const vehicles: SceneVehicle[] = Array.from({ length: n }, (_, i) => {
    const d = dirs.length ? pick(dirs) : null;
    const tmpl = base.vehicles[Math.min(i, base.vehicles.length - 1)]!;
    return {
      ...tmpl, id: VEHICLE_IDS[i]!, role: i === 0 ? "claimant" : "other", type: pick(VEHICLE_TYPES), action: pick(ACTIONS), zone: pick(ZONES), braking: rnd() < 0.2,
      travel: d ? { bearingDeg: d.bearingDeg, roadId: d.roadId, roadName: d.roadName, lane: rnd() < 0.1 ? 3 : null } : { bearingDeg: pick([0, 90, 180, 270]), roadId: null, roadName: null, lane: null },
      speed: rnd() < 0.3 ? { kind: "unsure", limitMph: rnd() < 0.5 ? null : 30 } : { kind: "known", mph: 3 + Math.round(rnd() * 50) },
    };
  });
  return { ...base, vehicles };
}
