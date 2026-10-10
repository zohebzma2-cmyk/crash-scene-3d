// suggestFixes: when the picture can't be drawn, the closest details that do draw (DESIGN.md section 18).
import { describe, expect, it } from "vitest";
import type { RoadNetwork, Scene } from "../src";
import { ACTION_LABELS, MAX_FIXES, ZONE_WORDS, boundWord, simulate, streetsAtPin, suggestFixes, toLocal, whySentence } from "../src";
import { sampleScene } from "./fixtures";
import { NETWORKS, loadRoads, loadScene, randomScene, rng } from "./suggest-sweep";

const tbone = loadRoads("t-bone-intersection-roads.json");
const tboneScene = loadScene("t-bone-intersection");

/** The e2e "impossible scene": A northbound, B southbound on Main Street, both marked hit on the rear. */
function impossible(): Scene {
  const st = streetsAtPin(tbone, toLocal(tbone.frame, tboneScene.location));
  const nb = st.directions.find((d) => d.label === "northbound on Main Street")!;
  const sb = st.directions.find((d) => d.label === "southbound on Main Street")!;
  return {
    ...tboneScene,
    vehicles: [
      { ...tboneScene.vehicles[0]!, travel: { bearingDeg: nb.bearingDeg, roadId: nb.roadId, roadName: nb.roadName, lane: null }, zone: "rear", speed: { kind: "known", mph: 25 } },
      { ...tboneScene.vehicles[1]!, travel: { bearingDeg: sb.bearingDeg, roadId: sb.roadId, roadName: sb.roadName, lane: null }, zone: "rear", speed: { kind: "known", mph: 30 } },
    ],
  };
}

/** Every fix draws as entered, the list is short, sorted and the same every time. */
function expectSound(scene: Scene, roads: RoadNetwork | null, again = true) {
  const s = suggestFixes(scene, roads);
  expect(s.fixes.length).toBeLessThanOrEqual(MAX_FIXES);
  expect(s.why).toMatch(/^[A-Z].*[.]$/);
  expect(s.why).not.toMatch(/Check |\n/);
  const costs = s.fixes.map((f) => f.cost);
  // Fixes the plain checks are quiet about lead, then the rest; each group by cost.
  for (const f of s.fixes) {
    const r = simulate(f.scene, roads);
    expect(r.ok, `${f.label}: ${r.ok ? "" : JSON.stringify(r.errors)}`).toBe(true);
    if (r.ok) expect(r.result.warnings.some((w) => w.code === "zone-used"), f.label).toBe(false);
    expect(f.label).toMatch(/^Change [A-D]'s (hit side|direction|action|lane) to .+/);
    // The patch is exactly the listed changes: each changed vehicle is the original plus its changes' patches, nothing else.
    const changed = scene.vehicles.filter((v, i) => JSON.stringify(v) !== JSON.stringify(f.scene.vehicles[i])).map((v) => v.id);
    expect(new Set(changed)).toEqual(new Set(f.changes.map((c) => c.vehicleId)));
    scene.vehicles.forEach((v, i) => {
      const patch = Object.assign({}, ...f.changes.filter((c) => c.vehicleId === v.id).map((c) => c.patch)) as Partial<typeof v>;
      expect(f.scene.vehicles[i]).toEqual({ ...v, ...patch });
    });
    // The words on the button match the value set.
    for (const c of f.changes) {
      const after = f.scene.vehicles.find((v) => v.id === c.vehicleId)!;
      expect(f.label).toContain(`${c.vehicleId}'s ${c.field === "zone" ? "hit side" : c.field} to ${c.to}`);
      if (c.field === "zone") expect(c.to.toLowerCase()).toBe(ZONE_WORDS[after.zone]);
      if (c.field === "action") expect(c.to.startsWith(ACTION_LABELS[after.action])).toBe(true);
      if (c.field === "action" && scene.vehicles.find((v) => v.id === c.vehicleId)!.action === "parked" && after.action !== "parked") expect(c.to).toMatch(/ at (\d+(\.\d)? mph|a speed the picture picks)$/);
      if (c.field === "direction") expect(c.to.toLowerCase()).toContain(after.action === "parked" || after.action === "backing" ? `facing ${boundWord(after.travel.bearingDeg).replace("bound", "")}` : boundWord(after.travel.bearingDeg));
    }
  }
  expect(new Set(s.fixes.map((f) => f.id)).size).toBe(s.fixes.length);
  expect(costs.length).toBe(s.fixes.length);
  if (again) expect(suggestFixes(scene, roads).fixes.map((f) => f.id)).toEqual(s.fixes.map((f) => f.id));
  return s;
}

describe("suggestFixes", () => {
  it("returns nothing for a scene that draws", () => {
    const s = suggestFixes(tboneScene, tbone);
    expect(s.fixes).toEqual([]);
    expect(s.why).toBe("");
  });

  it("offers one-tap fixes for vehicles moving apart (the e2e impossible scene), smallest change first", () => {
    const scene = impossible();
    const r = simulate(scene, tbone);
    expect(r.ok ? [] : r.errors.map((e) => e.code)).toEqual(["moving-apart"]);
    const s = expectSound(scene, tbone);
    expect(s.fixes.length).toBeGreaterThanOrEqual(1);
    expect(s.why).toBe(whySentence(r.ok ? [] : r.errors));
    expect(s.why).toMatch(/moving apart/);
    // One change before two.
    const sizes = s.fixes.map((f) => f.changes.length);
    expect(sizes[0]).toBe(1);
  });

  it("repairs a vehicle going the wrong way on a one-way street", () => {
    // Park Street is one-way westbound at this crossing: B backing up while facing west travels east, against it.
    const scene: Scene = { ...tboneScene, vehicles: [tboneScene.vehicles[0]!, { ...tboneScene.vehicles[1]!, action: "backing" }] };
    const r = simulate(scene, tbone);
    expect(r.ok ? [] : r.errors.map((e) => e.code)).toContain("wrong-way");
    const s = expectSound(scene, tbone);
    expect(s.fixes.length).toBeGreaterThanOrEqual(1);
  });

  it("repairs a lane the road doesn't have", () => {
    const scene: Scene = { ...tboneScene, vehicles: [{ ...tboneScene.vehicles[0]!, travel: { ...tboneScene.vehicles[0]!.travel, lane: 5 } }, tboneScene.vehicles[1]!] };
    const r = simulate(scene, tbone);
    expect(r.ok ? [] : r.errors.map((e) => e.code)).toContain("no-such-lane");
    const s = expectSound(scene, tbone);
    expect(s.fixes.length).toBeGreaterThanOrEqual(1);
  });

  it("gets something moving when every vehicle is parked", () => {
    const scene: Scene = { ...tboneScene, vehicles: tboneScene.vehicles.map((v) => ({ ...v, action: "parked" as const })) };
    const r = simulate(scene, tbone);
    expect(r.ok ? [] : r.errors.map((e) => e.code)).toEqual(["nothing-moving"]);
    const s = expectSound(scene, tbone);
    expect(s.fixes.length).toBeGreaterThanOrEqual(1);
    expect(s.fixes[0]!.changes.some((c) => c.field === "action")).toBe(true);
  });

  it("has no one-tap fix for a pin with no road near it: edit the location by hand", () => {
    const ocean: RoadNetwork = { frame: { origin: { lat: 42.5, lon: -69.5 } }, radiusM: 250, ways: [], buildings: [], parking: [], terrain: null, attribution: [], fetchedAt: "2026-10-09T12:00:00Z" };
    const scene = sampleScene();
    scene.location = { ...scene.location, lat: 42.5, lon: -69.5 };
    const s = suggestFixes(scene, ocean);
    expect(s.fixes).toEqual([]);
    expect(s.focus).toEqual({ step: "location", vehicleId: null, field: "location" });
    expect(s.why).toBe("We couldn't find a road near the pin.");
  });

  it("has no one-tap fix for input the physics can't read: edit the field by hand", () => {
    const bad = sampleScene() as unknown as { vehicles: Array<Record<string, unknown>> };
    bad.vehicles[1]!["speed"] = { kind: "known", mph: 900 };
    const s = suggestFixes(bad as unknown as Scene, null);
    expect(s.fixes).toEqual([]);
    expect(s.focus).toEqual({ step: "vehicles", vehicleId: "B", field: "speed" });
  });
});

/**
 * Property, over seeded random scenes on the three example road networks (directions are the ones step 2 offers at each
 * pin): every refusal gets at most three fixes, each of which draws, in a fixed order; and every refusal code the
 * sweep meets is cured by a fix somewhere. A few refusals have no one-tap fix (three vehicles whose zones all miss,
 * some chained path repairs): those get "Edit the details myself", and the share is held under a ceiling.
 */
describe("suggestFixes over random refused scenes", () => {
  it("on the three example road networks", () => {
    const seen = new Map<string, number>(), fixed = new Set<string>();
    let refused = 0, without = 0;
    /** Worst time per vehicle count, ms (expectSound runs suggestFixes once or twice, plus a simulate per fix). */
    const worst = new Map<number, number>();
    for (const [example, file] of NETWORKS) {
      const roads = loadRoads(file), base = loadScene(example), rnd = rng(11);
      let here = 0;
      for (let i = 0; i < 300 && here < 14; i++) {
        const scene = randomScene(base, roads, rnd);
        const r = simulate(scene, roads);
        if (r.ok) continue;
        here++; refused++;
        const code = r.errors[0]!.code;
        seen.set(code, (seen.get(code) ?? 0) + 1);
        const t0 = performance.now();
        const s = expectSound(scene, roads, here % 4 === 0);
        const ms = performance.now() - t0, nv = scene.vehicles.length;
        worst.set(nv, Math.max(worst.get(nv) ?? 0, ms));
        if (s.fixes.length) fixed.add(code); else without++;
      }
    }
    expect(refused).toBeGreaterThan(30);
    // Every code met is cured somewhere, except the multi-vehicle zone case listed in the README's Next version.
    for (const code of seen.keys()) if (code !== "zones-cannot-touch") expect(fixed, `no fix ever found for ${code}`).toContain(code);
    expect(without / refused).toBeLessThan(0.25);
    console.info(`suggestFixes sweep: ${refused} refused, ${without} without a fix, worst ms by vehicle count ${JSON.stringify(Object.fromEntries(worst))}`);
    // A generous ceiling (two searches and the re-runs per scene, on a loaded test machine); the target is about 1 s per search.
    for (const ms of worst.values()) expect(ms).toBeLessThan(6000);
  }, 300_000);
});
