// The fixer's regression corpus (docs/FIXER-BENCHMARK.md, "The corpus"): refused scenes, each with the best fix the fixer
// found for it when it was added. The fixer is re-checked against all of them on every test run and can only get better:
// a case that loses its fix, or whose best fix gets bigger, fails the test. Adding a case is one command:
//
//   npm run fixer:corpus -- --add path/to/scene.json [--roads t-bone-intersection|path/to/roads.json] [--src visibility] [--note "…"]
//
// Cases from the benchmark are stored by reference ("ref": the benchmark id), the rest inline. Synthetic data only.
import { readFileSync, writeFileSync } from "node:fs";
import type { Fix, RoadNetwork, Scene } from "../../src";
import { parseScene, simulate, streetsAtPin, suggestFixes, toLocal } from "../../src";
import { type BenchCase, type NetRef, loadBench, roadsOf } from "./bench";
import { loadRoads, loadScene } from "../suggest-sweep";

export interface BestFix {
  readonly id: string;
  /** How many details it changes. */
  readonly size: number;
  readonly cost: number;
  readonly label: string;
}

export interface CorpusCase {
  readonly id: string;
  /** Where it came from: "bench", "red-team", "e2e", "visibility", or anything a later agent uses. */
  readonly src: string;
  /** A benchmark id: the scene and roads are the benchmark's. */
  readonly ref?: string;
  readonly net?: NetRef;
  readonly scene?: Scene;
  /** The fixer's best fix when the case was added or last improved; null when it had none (the case may only gain one). */
  readonly best: BestFix | null;
  readonly note?: string;
}

export const CORPUS_PATH = new URL("../data/fixer-corpus.jsonl", import.meta.url);

export function loadCorpus(): CorpusCase[] {
  return readFileSync(CORPUS_PATH, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as CorpusCase);
}

export function saveCorpus(cases: readonly CorpusCase[]): void {
  writeFileSync(CORPUS_PATH, cases.map((c) => JSON.stringify(c)).join("\n") + "\n");
}

let benchById: Map<string, BenchCase> | null = null;
/** The scene and roads a case stands for. */
export function resolve(c: CorpusCase): { scene: Scene; roads: RoadNetwork | null } {
  if (c.ref) {
    benchById ??= new Map(loadBench().map((b) => [b.id, b]));
    const b = benchById.get(c.ref);
    if (!b) throw new Error(`${c.id}: no benchmark scene ${c.ref}`);
    return { scene: b.scene, roads: roadsOf(b.net) };
  }
  if (!c.scene || c.net === undefined) throw new Error(`${c.id}: needs a scene and a net, or a ref`);
  return { scene: c.scene, roads: roadsOf(c.net) };
}

/** A fix as the corpus records it. */
export const asBest = (f: Fix | undefined): BestFix | null => (f ? { id: f.id, size: f.size, cost: Math.round(f.cost * 1e6) / 1e6, label: f.label } : null);

/** The fixer's best fix for a scene now (no device preferences). */
export function bestNow(scene: Scene, roads: RoadNetwork | null): BestFix | null {
  return asBest(suggestFixes(scene, roads).fixes[0]);
}

/** "better", "same" or "worse": a smaller best fix is better; no fix is worse than any fix. */
export function compare(now: BestFix | null, was: BestFix | null): "better" | "same" | "worse" {
  if (!was) return now ? "better" : "same";
  if (!now) return "worse";
  if (now.size !== was.size) return now.size < was.size ? "better" : "worse";
  if (Math.abs(now.cost - was.cost) <= 1e-6) return "same";
  return now.cost < was.cost ? "better" : "worse";
}

/** Does the scene draw exactly as the button says? */
export function draws(scene: Scene, roads: RoadNetwork | null): boolean {
  const r = simulate(scene, roads);
  return r.ok && !r.result.warnings.some((w) => w.code === "zone-used");
}

// ---------------------------------------------------------------- seeds

/**
 * Refused scenes from the red team (docs/RED-TEAM.md), the e2e suite and the unit tests, built on the t-bone example. The red
 * team's contradictory scenes that the zone fallback draws (with a note) are not refusals, so they are left out.
 */
export function seedScenes(): Array<{ id: string; src: string; net: NetRef; scene: Scene; note: string }> {
  const roads = loadRoads("t-bone-intersection-roads.json"), base = loadScene("t-bone-intersection");
  const dirs = streetsAtPin(roads, toLocal(roads.frame, base.location)).directions;
  const dir = (label: string) => { const d = dirs.find((x) => x.label === label)!; return { bearingDeg: d.bearingDeg, roadId: d.roadId, roadName: d.roadName, lane: null }; };
  const two = (a: Partial<Scene["vehicles"][number]>, b: Partial<Scene["vehicles"][number]>): Scene => ({ ...base, vehicles: [{ ...base.vehicles[0]!, ...a }, { ...base.vehicles[1]!, ...b }] });
  const out = [
    { id: "e2e-moving-apart", src: "e2e", note: "e2e flow.spec: A northbound, B southbound on Main Street, both hit on the rear", scene: two({ travel: dir("northbound on Main Street"), zone: "rear" }, { travel: dir("southbound on Main Street"), zone: "rear" }) },
    { id: "red-team-same-way-fronts", src: "red-team", note: "RED-TEAM.md: B northbound on Main Street, A and B both hit on the front", scene: two({ zone: "front" }, { travel: dir("northbound on Main Street"), zone: "front" }) },
    { id: "red-team-head-on-rear", src: "red-team", note: "RED-TEAM.md: head-on on Main Street with one hit on the rear", scene: two({ travel: dir("northbound on Main Street"), zone: "rear" }, { travel: dir("southbound on Main Street"), zone: "front" }) },
    { id: "unit-wrong-way", src: "unit-test", note: "suggest.test: B backing up on one-way Park Street", scene: two({}, { action: "backing" }) },
    { id: "unit-no-such-lane", src: "unit-test", note: "suggest.test: A in lane 6 of a road with fewer lanes", scene: two({ travel: { ...base.vehicles[0]!.travel, lane: 5 } }, {}) },
  ];
  return out.filter((c) => parseScene(c.scene).ok && !simulate(c.scene, roads).ok).map((c) => ({ ...c, net: "t-bone-intersection" as const }));
}
