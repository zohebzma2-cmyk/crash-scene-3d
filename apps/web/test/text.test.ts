import { describe, expect, it } from "vitest";
import { DEFAULT_LIMIT_MPH, type Scene, type SceneVehicle } from "@csd/core";
import { sceneSummary, vehicleClause, whereClause } from "../src/lib/text";
import { fakeSimulate } from "../src/services/fakes";
import { tbone } from "./fakes";

const sim = (s: Scene) => {
  const o = fakeSimulate(s, null);
  if (!o.ok) throw new Error("sim failed");
  return o.result;
};
const withV = (i: number, patch: Partial<SceneVehicle>): Scene => ({ ...tbone, vehicles: tbone.vehicles.map((v, k) => (k === i ? { ...v, ...patch } : v)) });

const hasRepeatedWord = (s: string) => /\b(\w+)\s+\1\b/i.test(s);

describe("summary text", () => {
  it("keeps street names as written and never lowercases them", () => {
    const text = sceneSummary(tbone, sim(tbone), "us");
    expect(text).toContain("Main Street");
    expect(text).toContain("Park Street");
    expect(text).not.toMatch(/main street|park street/);
    expect(text.startsWith("Vehicle A, your car, northbound on Main Street at about 25 mph when it was hit on the right side")).toBe(true);
  });

  it("has no repeated words, for every action", () => {
    for (const action of ["straight", "turn-left", "turn-right", "backing", "parked"] as const) {
      const s = withV(1, { action, travel: { ...tbone.vehicles[1]!.travel } });
      const text = sceneSummary(s, sim(s), "us");
      expect(hasRepeatedWord(text), text).toBe(false);
      expect(text).not.toMatch(/\s{2,}/);
    }
  });

  it("does not say 'parked' twice for a parked vehicle, and leaves its speed out", () => {
    const s = withV(1, { action: "parked" });
    const clause = vehicleClause(s.vehicles[1]!, sim(s), "us");
    expect(clause.match(/parked/g)).toHaveLength(1);
    expect(clause).not.toMatch(/ mph/);
  });

  it("splits the caption without the action so it is not said twice", () => {
    const v = withV(0, { action: "turn-left" }).vehicles[0]!;
    expect(whereClause(v)).toBe("ending northbound on Main Street");
    expect(vehicleClause(v, null, "us").match(/turning left/g)).toHaveLength(1);
  });

  it("takes speeds from the simulation result through the formatter, as the speed at impact", () => {
    const text = sceneSummary(tbone, sim(tbone), "us");
    expect(text).toMatch(/at about 25 mph when it was hit/);
    expect(text).toMatch(/at about 20–30 mph \(not sure; around 25 mph, a typical city limit; the picture uses 25 mph\) when it was hit/);
    expect(sceneSummary(tbone, sim(tbone), "metric")).toMatch(/km\/h/);
  });

  it("says the limit that was given, and the typical city limit from the constant when it wasn't known", () => {
    const known = withV(1, { speed: { kind: "unsure", limitMph: 30 } });
    expect(sceneSummary(known, sim(known), "us")).toContain("not sure; around the 30 mph limit; the picture uses 30 mph");
    expect(sceneSummary(tbone, sim(tbone), "us")).toContain(`around ${DEFAULT_LIMIT_MPH} mph, a typical city limit`);
  });

  it("says when a vehicle was braking, and never for a parked one", () => {
    const braking = withV(0, { braking: true });
    expect(sceneSummary(braking, sim(braking), "us")).toContain("northbound on Main Street and braking at about 25 mph when it was hit on the right side");
    expect(sceneSummary(tbone, sim(tbone), "us")).not.toContain("braking");
    const parked = withV(1, { action: "parked", braking: true });
    expect(sceneSummary(parked, sim(parked), "us")).not.toContain("braking");
  });

  it("keeps repeated words inside a street name", () => {
    const s = withV(0, { travel: { ...tbone.vehicles[0]!.travel, roadName: "Walla Walla Road" } });
    const text = sceneSummary(s, sim(s), "us");
    expect(text).toContain("northbound on Walla Walla Road");
    expect(text.match(/Walla Walla Road/g)).toHaveLength(1);
    expect(text).not.toMatch(/Walla Walla Walla/);
  });
});
