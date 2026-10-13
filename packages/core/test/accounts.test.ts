import { describe, expect, it } from "vitest";
import { accountItems, parseScene, parseSceneFile, SCHEMA_VERSION } from "../src";
import { estimateSun } from "../src/sun";
import { sampleScene } from "./fixtures";
describe("optional claimant answers and migration", () => {
  it("opens v3 scenes and saved files without changing physics inputs or inventing answers", () => {
    const old = { ...sampleScene(), schemaVersion: 3 };
    const before = JSON.stringify(old);
    const r = parseScene(old);
    expect(r.ok && r.value).toEqual({ ...old, schemaVersion: SCHEMA_VERSION });
    expect(JSON.stringify(old)).toBe(before);
    const f = parseSceneFile(new TextEncoder().encode(JSON.stringify({ ...old, createdAt: "2026-10-10T00:00:00Z", disclaimer: "Illustration only" })));
    expect(f.ok && f.value.schemaVersion).toBe(SCHEMA_VERSION);
    expect(r.ok && r.value.conditions).toBeUndefined();
  });
  it("round trips all optional answers and not-sure without treating them as facts", () => {
    const s = sampleScene();
    s.conditions = { lighting: "dark-lit", weather: "fog", visibility: ["sun-glare", "hedges", "parked-cars"] };
    s.vehicles[0]!.account = { control: "flashing", signaled: "no", braking: "not-sure", swerving: "yes", airbags: "yes", towed: "no", lane: "entered" };
    s.vehicles[0]!.travel.lane = 1;
    const p = parseScene(s); expect(p.ok && p.value).toEqual(s);
    const notes = accountItems(s);
    expect(notes).toHaveLength(10);
    expect(notes.every((n) => n.text.startsWith("Claimant said"))).toBe(true);
    expect(notes.map((n) => n.key)).toContain("A-lane");
  });
  it("works with all answers skipped and rejects arbitrary control text", () => {
    expect(accountItems(sampleScene())).toEqual([]);
    const s = sampleScene();
    expect(parseScene({ ...s, conditions: { lighting: "<img src=x>" } }).ok).toBe(false);
  });
  it("retains lane answers across the full count range supported by OSM parsing", () => {
    const s = sampleScene();
    s.vehicles[0]!.account = { lane: "entered" };
    for (const lane of [0, 8, 19]) {
      s.vehicles[0]!.travel.lane = lane;
      expect(parseScene(s).ok).toBe(true);
      expect(accountItems(s)[0]!.text).toContain(`lane ${lane + 1} from the right`);
    }
    s.vehicles[0]!.travel.lane = 20;
    expect(parseScene(s).ok).toBe(false);
  });
  it("migrates the newer main branch's v3 paints without losing paint, answers or identity", () => {
    const s = sampleScene(); s.vehicles[0]!.color = { name: "Blue", hex: "#123456" };
    const old = { ...s, schemaVersion: 3 };
    const loaded = parseSceneFile(new TextEncoder().encode(JSON.stringify({ ...old, createdAt: "2026-10-10T00:00:00Z", disclaimer: "Illustration only" })));
    expect(loaded.ok && loaded.value.vehicles).toEqual(s.vehicles);
    expect(loaded.ok && loaded.value.schemaVersion).toBe(4);
    expect(loaded.ok && loaded.value.conditions).toBeUndefined();
  });
  it("keeps yes, no and not-sure visible on compact icons, with distinct visibility glyphs", () => {
    const s = sampleScene();
    s.conditions = { visibility: ["sun-glare", "parked-cars", "hedges"] };
    expect(accountItems(s)[0]!.icons).toEqual(["visibility-glare", "visibility-parked", "visibility-hedges"]);
    for (const value of ["yes", "no", "not-sure"] as const) {
      s.vehicles[0]!.account = { braking: value, airbags: value, towed: value };
      expect(accountItems(s).slice(1).every((x) => x.short === `A: ${value === "not-sure" ? "Not sure" : value === "yes" ? "Yes" : "No"}`)).toBe(true);
    }
  });
});
describe("offline solar prefill", () => {
  it("uses the pin's zone, with daylight and night and sunrise/sunset", () => {
    const s = sampleScene(); s.occurred = { date: "2026-06-21", time: "12:00" };
    const noon = estimateSun(s)!;
    expect(noon.zone).toBe("America/New_York"); expect(noon.lighting).toBe("daylight");
    expect(noon.elevationDeg).toBeGreaterThan(60); expect(noon.sunrise).toMatch(/AM/); expect(noon.sunset).toMatch(/PM/);
    s.occurred.time = "00:00"; expect(estimateSun(s)?.lighting).toBe("dark");
  });
  it("leaves unknown, invalid and DST-ambiguous times unanswered", () => {
    const s = sampleScene(); s.occurred.time = null; expect(estimateSun(s)).toBeNull();
    s.occurred = { date: "2026-03-08", time: "02:30" }; expect(estimateSun(s)).toBeNull();
    s.occurred = { date: "2026-11-01", time: "01:30" }; expect(estimateSun(s)).toBeNull();
    s.occurred.time = "99:99"; expect(estimateSun(s)).toBeNull();
    s.occurred = { date: "2026-02-30", time: "12:00" }; expect(estimateSun(s)).toBeNull();
  });
  it("handles polar day and night without invented sunrise or sunset times", () => {
    const s = sampleScene(); s.location = { ...s.location, lat: 78.22, lon: 15.65 };
    s.occurred = { date: "2026-06-21", time: "00:00" };
    expect(estimateSun(s)).toMatchObject({ lighting: "daylight", sunrise: null, sunset: null });
    s.occurred = { date: "2026-12-21", time: "12:00" };
    expect(estimateSun(s)).toMatchObject({ lighting: "dark", sunrise: null, sunset: null });
  });
  it("uses the local date on both sides of the date line and non-hour offsets", () => {
    const s = sampleScene(); s.occurred = { date: "2026-06-21", time: "12:00" };
    for (const [lat, lon] of [[1.87, -157.43], [-13.83, -171.75], [27.7, 85.3]]) {
      s.location = { ...s.location, lat: lat!, lon: lon! };
      const sun = estimateSun(s)!;
      expect(sun.lighting).toBe("daylight"); expect(sun.sunrise).toMatch(/AM/); expect(sun.sunset).toMatch(/PM/);
      expect(sun.elevationDeg).toBeGreaterThan(35);
    }
  });
  it("does not choose an instant for a half-hour DST fold", () => {
    const s = sampleScene(); s.location = { ...s.location, lat: -31.55, lon: 159.08 };
    s.occurred = { date: "2026-04-05", time: "01:45" };
    expect(estimateSun(s)).toBeNull();
  });
  it("keeps equinox sunrise and sunset within ten minutes of the solar-clock reference at Greenwich longitude", () => {
    const s = sampleScene(); s.location = { ...s.location, lat: 0, lon: 0 };
    s.occurred = { date: "2026-03-20", time: "12:00" };
    const sun = estimateSun(s)!;
    const minutes = (clock: string) => {
      const [, h, m, meridian] = /^(\d+):(\d+) (AM|PM)$/.exec(clock)!;
      return (Number(h) % 12 + (meridian === "PM" ? 12 : 0)) * 60 + Number(m);
    };
    // Equinox at latitude/longitude zero: ~12h daylight, equation of time ~8 min,
    // standard refraction moves rise/set about 3 min either side of geometric sunrise/sunset.
    expect(Math.abs(minutes(sun.sunrise!) - (6 * 60 + 5))).toBeLessThan(10);
    expect(Math.abs(minutes(sun.sunset!) - (18 * 60 + 11))).toBeLessThan(10);
  });
});
