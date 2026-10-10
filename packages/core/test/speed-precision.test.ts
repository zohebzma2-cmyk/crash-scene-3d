// Speeds are whole or tenths of a mile per hour, so every printed bound is exact and the saved file matches what was entered.
import { describe, expect, it } from "vitest";
import { MPH_TO_MPS, parseScene, simulate } from "../src";
import type { Scene, SceneSpeed } from "../src";
import { sampleScene } from "./fixtures";
import { known, sceneOf, unsure, veh } from "./physics-helpers";

const MESSAGE = "Use whole or tenths of a mile per hour, like 25 or 25.5.";

const withSpeeds = (a: SceneSpeed, b: SceneSpeed): unknown => {
  const s = JSON.parse(JSON.stringify(sampleScene()));
  s.vehicles[0].speed = a;
  s.vehicles[1].speed = b;
  return s;
};

describe("speeds in tenths of a mile per hour", () => {
  it("rejects a 2-decimal limit and a 2-decimal known speed in plain words, naming the vehicle", () => {
    const limit = parseScene(withSpeeds({ kind: "known", mph: 25 }, { kind: "unsure", limitMph: 26.35 }));
    expect(limit.ok).toBe(false);
    if (!limit.ok) expect(limit.errors).toEqual([`Vehicle B: ${MESSAGE}`]);
    const speed = parseScene(withSpeeds({ kind: "known", mph: 25.05 }, { kind: "unsure", limitMph: 30 }));
    expect(speed.ok).toBe(false);
    if (!speed.ok) expect(speed.errors).toEqual([`Vehicle A: ${MESSAGE}`]);
    const both = parseScene(withSpeeds({ kind: "known", mph: 29.95 }, { kind: "unsure", limitMph: 26.85 }));
    if (!both.ok) expect(both.errors).toEqual([`Vehicle A: ${MESSAGE}`, `Vehicle B: ${MESSAGE}`]);
    expect(both.ok).toBe(false);
  });

  it("still accepts whole numbers, tenths such as 25.3, an unknown limit, and the limits of the range", () => {
    for (const [a, b] of [
      [{ kind: "known", mph: 25 }, { kind: "unsure", limitMph: 25.3 }],
      [{ kind: "known", mph: 25.5 }, { kind: "unsure", limitMph: null }],
      [{ kind: "known", mph: 0.1 }, { kind: "unsure", limitMph: 5 }],
      [{ kind: "known", mph: 150 }, { kind: "unsure", limitMph: 85 }],
      [{ kind: "known", mph: 29.9 }, { kind: "unsure", limitMph: 26.7 }],
      [{ kind: "known", mph: 0 }, { kind: "unsure", limitMph: 30 }],
    ] as Array<[SceneSpeed, SceneSpeed]>) {
      expect(parseScene(withSpeeds(a, b)).ok, JSON.stringify([a, b])).toBe(true);
    }
  });

  it("keeps the other speed messages as they were", () => {
    const r = parseScene(withSpeeds({ kind: "known", mph: 300 }, { kind: "unsure", limitMph: 30 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContain("Vehicle A: That's faster than we can illustrate. Enter 150 mph or less.");
  });
});

// ---------------------------------------------------------------- every printed bound re-runs exactly

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rear = (a: SceneSpeed, b: SceneSpeed): Scene => sceneOf([
  veh("A", { type: "suv", bearingDeg: 0, speed: a, zone: "rear" }),
  veh("B", { type: "pickup", bearingDeg: 0, speed: b, zone: "front" }),
], { place: "road" });

describe("printed bounds are exact (random 0.1-step limits)", () => {
  it("the start, end and fail speeds in the warnings re-run exactly: shown bounds work, the printed failing speed does not", () => {
    const rnd = mulberry32(20261010);
    const tenths = (lo: number, hi: number) => Math.round((lo + rnd() * (hi - lo)) * 10) / 10;
    const mph = (mps: number) => mps / MPH_TO_MPS;
    let starts = 0, ends = 0;
    for (let i = 0; i < 160; i++) {
      const leaderFirst = i % 2 === 0; // 'not sure' follower, or 'not sure' leader
      const fixed = tenths(15, 45);
      const limit = tenths(Math.max(5.1, fixed - 6), fixed + 6);
      const make = (s: SceneSpeed): Scene => (leaderFirst ? rear(known(fixed), s) : rear(s, known(fixed)));
      const out = simulate(make(unsure(limit)), null);
      if (!out.ok) continue;
      const mine = out.result.vehicles.find((v) => v.id === (leaderFirst ? "B" : "A"))!.speedAtImpactMps;
      for (const code of ["range-start", "range-end"] as const) {
        const w = out.result.warnings.find((x) => x.code === code);
        if (!w) continue;
        const m = /^At ([\d.]+) mph and (?:below|above), .*(?:start|end) at ([\d.]+) mph\.$/.exec(w.text);
        expect(m, w.text).not.toBeNull();
        const fail = Number(m![1]), shown = Number(m![2]);
        // The printed shown bound is exactly the bound in the result, and runs as a valid crash.
        expect(Math.abs(mph(code === "range-start" ? mine.lo : mine.hi) - shown), `${code} ${w.text}`).toBeLessThan(1e-9);
        expect(simulate(make(known(shown)), null).ok, `shown ${shown} (limit ${limit}, fixed ${fixed})`).toBe(true);
        // The printed failing speed next to it does not.
        expect(simulate(make(known(fail)), null).ok, `fail ${fail} (limit ${limit}, fixed ${fixed})`).toBe(false);
        if (code === "range-start") starts++; else ends++;
      }
    }
    expect(starts).toBeGreaterThanOrEqual(15);
    expect(ends).toBeGreaterThanOrEqual(15);
  });
});
