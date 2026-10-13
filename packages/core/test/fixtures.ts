import type { Scene } from "../src";

/** A valid two-vehicle scene used by contract tests (made-up claim). */
export function sampleScene(): Scene {
  return {
    schemaVersion: 4,
    claim: { number: "CLM-2419", vehicle: { year: 2021, make: "Honda", model: "Accord" } },
    location: { lat: 42.7654, lon: -71.4676, label: "Main Street & Park Street, Nashua", nearLabel: "", source: "example", place: "intersection" },
    occurred: { date: "2026-10-02", time: "17:15" },
    road: { condition: "wet" },
    vehicles: [
      { id: "A", role: "claimant", year: 2021, make: "Honda", model: "Accord", type: "car", typeSource: "claim", action: "straight",
        travel: { bearingDeg: 0, roadId: null, roadName: "Main Street", lane: null }, speed: { kind: "known", mph: 25 }, braking: false, zone: "left" },
      { id: "B", role: "other", year: null, make: "", model: "", type: "suv", typeSource: "manual", action: "straight",
        travel: { bearingDeg: 90, roadId: null, roadName: "Park Street", lane: null }, speed: { kind: "unsure", limitMph: 30 }, braking: false, zone: "front" },
    ],
  };
}
