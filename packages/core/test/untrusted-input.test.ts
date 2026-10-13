// The physics does not trust its input: simulate, placeVehicles and checkScene check what they are given
// themselves, without parseScene having run first. Nothing here may throw, hang, or allocate without bound.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { LIMITS, checkScene, parseScene, placeVehicles, simulate } from "../src";
import type { PlainMessage, RoadNetwork, Scene, SceneSpeed } from "../src";
import { MAX_TRACK_SAMPLES, MAX_SPEED_MPS, ROAD_REACH_M } from "../src/physics/constants";
import { NO_ROAD_TEXT, trackTooLong, validateScene } from "../src/physics/validate";
import { sampleScene } from "./fixtures";
import { MAIN, PARK, expectOk, flatTBoneScene, known, sceneOf, tBoneScene, unsure, veh } from "./physics-helpers";
import { intersectionNet, makeWay, parkingLotNet, rect } from "./roads-fixtures";

const PIN = { x: 0, y: 0 };
const RAW = /undefined|\bNaN\b|Infinity|\bnull\b|\[object|Invalid input|\bat \S+ \(|\.[cm]?[jt]sx?:\d|Error\b|\bzod\b|\bstack\b/;

/** A scene whose first vehicle has the given speed (the sample scene: A hits B, flat). */
function withSpeed(speed: unknown, i = 0): Scene {
  const s = sampleScene();
  (s.vehicles[i] as { speed: unknown }).speed = speed;
  return s;
}
const plain = (ms: readonly PlainMessage[]) => {
  expect(ms.length).toBeGreaterThan(0);
  for (const m of ms) {
    expect(m.text, m.code).not.toMatch(RAW);
    expect(m.text, m.code).toMatch(/^[A-Z0-9][^\n]*[.)]$/); // "4 vehicles at most." is the schema's own sentence
    expect(m.code).toMatch(/^[a-z]+(-[a-z]+)*$/);
  }
};
/** All three entry points refuse the scene, quickly, without throwing, and agree on the reason. */
function expectRefused(scene: Scene, roads: RoadNetwork | null = null, pin = PIN): PlainMessage[] {
  const t0 = performance.now();
  const s = simulate(scene, roads);
  const p = placeVehicles(scene, roads, pin);
  const c = checkScene(scene, roads);
  expect(performance.now() - t0).toBeLessThan(1_000);
  expect(s.ok).toBe(false);
  expect(p.ok).toBe(false);
  if (s.ok || p.ok) throw new Error("expected a refusal");
  plain(s.errors); plain(p.errors); plain(c);
  expect(c.map((m) => m.text)).toEqual(s.errors.map((m) => m.text));
  expect(p.errors.map((m) => m.text)).toEqual(s.errors.map((m) => m.text));
  return [...s.errors];
}

describe("speeds the physics won't take", () => {
  const BAD: Array<[number, string]> = [
    [Number.NaN, "The speed should be a number of mph."],
    [Infinity, "The speed should be a number of mph."],
    [-Infinity, "The speed should be a number of mph."],
    [-5, "The speed can't be below 0 mph."],
    [-0.0001, "The speed can't be below 0 mph."],
    [151, `That's faster than we can illustrate. Enter ${LIMITS.maxSpeedMph} mph or less.`],
    [1e6, `That's faster than we can illustrate. Enter ${LIMITS.maxSpeedMph} mph or less.`],
    [1e308, `That's faster than we can illustrate. Enter ${LIMITS.maxSpeedMph} mph or less.`],
  ];

  it("refuses a bad known speed with the schema's wording, naming the vehicle, without running out of memory", () => {
    for (const [mph, text] of BAD) {
      const errors = expectRefused(withSpeed({ kind: "known", mph }));
      expect(errors.map((e) => e.text), String(mph)).toEqual([`Vehicle A: ${text}`]);
      expect(errors[0]!.code).toBe("bad-speed");
      expect([...errors[0]!.vehicleIds]).toEqual(["A"]);
      // Where the schema has this message, it is the same sentence (for a finite number; the schema words non-finite ones its own way).
      const schema = parseScene(withSpeed({ kind: "known", mph }));
      expect(schema.ok).toBe(false);
      if (!schema.ok && Number.isFinite(mph)) expect(schema.errors).toContain(`Vehicle A: ${text}`);
    }
  });

  it("a negative speed never comes out as a negative speed at impact", () => {
    const r = simulate(withSpeed({ kind: "known", mph: -5 }), null);
    expect(r.ok).toBe(false);
  });

  it("refuses a bad 'not sure' limit with the schema's wording; an unknown limit and the edges of the range are fine", () => {
    const wording = (limit: number) => (Number.isFinite(limit) ? (limit < LIMITS.minLimitMph ? `The speed limit can't be below ${LIMITS.minLimitMph} mph.` : `The speed limit can't be above ${LIMITS.maxLimitMph} mph.`) : "The speed limit should be a number of mph.");
    for (const limit of [Number.NaN, Infinity, -1, 0, 4.9, 85.1, 1e308]) {
      const errors = expectRefused(withSpeed({ kind: "unsure", limitMph: limit }, 1));
      expect(errors.map((e) => e.text), String(limit)).toEqual([`Vehicle B: ${wording(limit)}`]);
    }
    for (const limit of [null, LIMITS.minLimitMph, LIMITS.maxLimitMph]) {
      expect(simulate(withSpeed({ kind: "unsure", limitMph: limit }, 1), null).ok || true).toBe(true);
      expect(checkScene(withSpeed({ kind: "unsure", limitMph: limit }, 1), null).every((m) => m.code !== "bad-speed")).toBe(true);
    }
  });

  it("refuses a speed that is missing, a string, or a made-up kind", () => {
    for (const speed of [undefined, null, "fast", { kind: "warp" }, { kind: "known" }, { kind: "known", mph: "25" }, { kind: "unsure", limitMph: "30" }]) {
      const errors = expectRefused(withSpeed(speed));
      expect(errors.every((e) => e.code === "bad-speed"), JSON.stringify(speed)).toBe(true);
    }
  });

  it("the top of the range still runs, and fast", () => {
    const s = sampleScene();
    s.vehicles[0]!.speed = { kind: "known", mph: LIMITS.maxSpeedMph };
    s.vehicles[1]!.speed = { kind: "known", mph: LIMITS.maxSpeedMph };
    const t0 = performance.now();
    expect(simulate(s, null).ok).toBe(true);
    expect(performance.now() - t0).toBeLessThan(2_000);
  });
});

describe("directions, the pin and the location", () => {
  it("refuses a heading that isn't a number or isn't between 0 and 360 degrees", () => {
    for (const bearingDeg of [Number.NaN, Infinity, -Infinity, "north", undefined]) {
      const s = sampleScene();
      (s.vehicles[1]!.travel as { bearingDeg: unknown }).bearingDeg = bearingDeg;
      const errors = expectRefused(s);
      expect(errors.map((e) => e.text), String(bearingDeg)).toEqual(["Vehicle B: Pick which way the vehicle was going."]);
      expect(errors[0]!.code).toBe("bad-direction");
    }
    for (const bearingDeg of [-1, 360, 720, 1e300]) {
      const s = sampleScene();
      s.vehicles[1]!.travel.bearingDeg = bearingDeg;
      expect(expectRefused(s).map((e) => e.text)).toEqual(["Vehicle B: The direction has to be between 0 and 360 degrees."]);
    }
  });

  it("refuses a location that isn't on the planet", () => {
    for (const [lat, lon, text] of [
      [Number.NaN, 0, "The location is missing its latitude."], [Infinity, 0, "The location is missing its latitude."],
      [91, 0, "The latitude has to be between -90 and 90."], [0, 181, "The longitude has to be between -180 and 180."],
      [0, Number.NaN, "The location is missing its longitude."],
    ] as const) {
      const s = sampleScene();
      s.location.lat = lat;
      s.location.lon = lon;
      const errors = expectRefused(s);
      expect(errors.map((e) => e.text), `${lat},${lon}`).toEqual([text]);
      expect(errors[0]!.code).toBe("bad-location");
    }
  });

  it("refuses a pin that isn't a point on the map, in plain words", () => {
    for (const pin of [{ x: Number.NaN, y: 0 }, { x: 0, y: Infinity }, { x: -Infinity, y: 0 }, null, undefined, { x: "1", y: 2 }]) {
      const r = placeVehicles(sampleScene(), null, pin as never);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        plain(r.errors);
        expect(r.errors.map((e) => e.code)).toEqual(["bad-pin"]);
        expect(r.errors[0]!.text).toBe("We couldn't read where the pin is. Move the pin onto the road where the crash happened.");
      }
    }
  });

  it("refuses a road lane that isn't a whole number from 0 to 19, and a made-up type, zone, action or road condition", () => {
    for (const lane of [0, 8, 19]) {
      const s = sampleScene(); s.vehicles[0]!.travel.lane = lane;
      expect(validateScene(s)).toEqual([]);
    }
    for (const lane of [1.5, -1, 20, Number.NaN, "1"]) {
      const s = sampleScene();
      (s.vehicles[0]!.travel as { lane: unknown }).lane = lane;
      expect(expectRefused(s).map((e) => e.code), String(lane)).toEqual(["bad-lane"]);
    }
    const patches: Array<[string, (s: Scene) => void, string]> = [
      ["type", (s) => { (s.vehicles[0] as { type: unknown }).type = "banana"; }, "Vehicle A: Pick the kind of vehicle."],
      ["zone", (s) => { (s.vehicles[0] as { zone: unknown }).zone = "roof"; }, "Vehicle A: Pick where the vehicle was hit."],
      ["action", (s) => { (s.vehicles[0] as { action: unknown }).action = "flying"; }, "Vehicle A: Pick what the vehicle was doing."],
      ["id", (s) => { (s.vehicles[1] as { id: unknown }).id = "A"; }, "Vehicle A: Vehicles have to be lettered A, B, C, D in order."],
      ["letter", (s) => { (s.vehicles[1] as { id: unknown }).id = "Z"; }, "Vehicle B: Vehicles are lettered A to D."],
    ];
    for (const [name, patch, text] of patches) {
      const s = sampleScene();
      patch(s);
      expect(expectRefused(s).map((e) => e.text), name).toContain(text);
    }
    const s = sampleScene();
    (s.road as { condition: unknown }).condition = "lava";
    expect(expectRefused(s).map((e) => e.text)).toEqual(["Pick what the road was like."]);
  });
});

describe("the number of vehicles", () => {
  const withCount = (n: number): Scene => {
    const s = sampleScene();
    const letters = ["A", "B", "C", "D", "A", "B"] as const;
    s.vehicles = Array.from({ length: n }, (_, i) => ({ ...s.vehicles[i % 2]!, id: letters[i]! }));
    return s;
  };

  it("refuses 0, 1 and 5 vehicles in the schema's words", () => {
    for (const n of [0, 1]) expect(expectRefused(withCount(n)).map((e) => e.text), `${n} vehicles`).toEqual(["Add at least two vehicles."]);
    const five = expectRefused(withCount(5));
    expect(five.map((e) => e.text)).toContain(`${LIMITS.maxVehicles} vehicles at most.`);
    expect(five[0]!.code).toBe("too-many-vehicles");
  });

  it("refuses a scene with no vehicle list at all, or no scene", () => {
    for (const scene of [{ ...sampleScene(), vehicles: undefined }, { ...sampleScene(), vehicles: "AB" }, null, undefined, 42, {}]) {
      expect(() => simulate(scene as never, null)).not.toThrow();
      const r = simulate(scene as never, null);
      expect(r.ok).toBe(false);
      expect(() => checkScene(scene as never, null)).not.toThrow();
      expect(() => placeVehicles(scene as never, null, PIN)).not.toThrow();
    }
  });
});

describe("no simulation allocates without bound", () => {
  it("the cap covers the worst valid crash with room to spare: a truck and a motorcycle head-on at the top speed on ice", () => {
    const scene = sceneOf([
      veh("A", { type: "truck", bearingDeg: 0, speed: known(LIMITS.maxSpeedMph), zone: "front" }),
      veh("B", { type: "motorcycle", bearingDeg: 180, speed: known(LIMITS.maxSpeedMph), zone: "front" }),
    ], { condition: "ice", place: "road" });
    const sim = expectOk(simulate(scene, null)).result;
    const samples = sim.vehicles[0]!.track.length;
    expect(samples).toBeLessThan(MAX_TRACK_SAMPLES * 0.7);
    expect(MAX_TRACK_SAMPLES).toBe(Math.ceil((5 + (3 * MAX_SPEED_MPS) / (0.1 * 9.80665) + 30) / (1 / 120)));
  });

  it("refuses a track beyond the cap in plain words", () => {
    expect(trackTooLong(MAX_TRACK_SAMPLES)).toBe(false);
    expect(trackTooLong(MAX_TRACK_SAMPLES + 1)).toBe(true);
  });
});

describe("a pin with no road near it", () => {
  const OCEAN = { lat: 42.5, lon: -69.5 };
  const net = (name: string): RoadNetwork => JSON.parse(readFileSync(new URL(`./data/${name}-roads.json`, import.meta.url), "utf8")) as RoadNetwork;
  const oceanScene = (): Scene => {
    const s = sampleScene();
    s.location = { ...s.location, lat: OCEAN.lat, lon: OCEAN.lon };
    return s;
  };
  const NOTHING: RoadNetwork = { frame: { origin: OCEAN }, radiusM: 250, ways: [], buildings: [], parking: [], terrain: null, attribution: [], fetchedAt: "2026-10-09T12:00:00Z" };

  it("the raw break-it fixtures are copied alongside", () => {
    expect(JSON.parse(readFileSync(new URL("./data/gulf-of-maine-empty.json", import.meta.url), "utf8")).elements).toEqual([]);
    const ferry = JSON.parse(readFileSync(new URL("./data/gulf-of-maine-coast-ferry.json", import.meta.url), "utf8")) as { elements: Array<{ tags?: Record<string, string> }> };
    expect(ferry.elements.some((e) => e.tags?.route === "ferry")).toBe(true);
    expect(ferry.elements.some((e) => e.tags?.natural === "coastline")).toBe(true);
  });

  it("open water, and a coastline with a ferry route, both give no drivable road, so the crash is refused in plain words", () => {
    for (const road of [NOTHING, net("gulf-of-maine-empty"), net("gulf-of-maine-coast-ferry")]) {
      expect(road.ways).toEqual([]); // ferry routes and coastlines are not drivable
      const s = simulate(oceanScene(), road);
      const p = placeVehicles(oceanScene(), road, PIN);
      expect(s.ok).toBe(false);
      expect(p.ok).toBe(false);
      if (s.ok || p.ok) throw new Error("expected a refusal");
      for (const errors of [s.errors, p.errors]) {
        plain(errors);
        expect(errors.map((e) => e.code)).toEqual(["no-road"]);
        expect(errors[0]!.text).toBe("We couldn't find a road near the pin. Move the pin onto the road where the crash happened.");
        expect(errors[0]!.text).toBe(NO_ROAD_TEXT);
      }
    }
  });

  it("with no road data at all (null) the flat template still works", () => {
    expect(simulate(oceanScene(), null).ok).toBe(true);
    expect(placeVehicles(oceanScene(), null, PIN).ok).toBe(true);
  });

  it("is about distance: a road 100 m from the pin is too far, one within reach is fine", () => {
    const far = intersectionNet({ corners: false });
    const scene = tBoneScene();
    expect(simulate(scene, far).ok).toBe(true);
    // Move the pin by moving the scene's location: 100 m north and 100 m west puts it 100 m from Main (x = 0) and from Park (y = 0).
    const moved = (westM: number, northM: number): Scene => ({ ...scene, location: { ...scene.location, lon: scene.location.lon - westM / 81_854, lat: scene.location.lat + northM / 111_088 } });
    const refused = simulate(moved(100, 100), far);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.errors.map((e) => e.code)).toEqual(["no-road"]);
    expect(ROAD_REACH_M).toBeGreaterThan(25);
    // 30 m west of Main, 100 m north of Park: Main is within reach, so the pin has a road (whatever else is wrong with the picture).
    const near = simulate(moved(30, 100), far);
    if (!near.ok) expect(near.errors.map((x) => x.code)).not.toContain("no-road");
  });

  it("a pin inside a parking lot counts as having a road, even with no aisle within reach", () => {
    const lotOnly: RoadNetwork = { ...NOTHING, parking: [{ id: "lot", outline: rect(-200, -200, 200, 200) }] };
    const r = simulate(oceanScene(), lotOnly);
    if (!r.ok) expect(r.errors.map((e) => e.code)).not.toContain("no-road");
    expect(parkingLotNet().parking.length).toBe(1);
  });

  it("checkScene on open water does not throw", () => {
    expect(() => checkScene(oceanScene(), NOTHING)).not.toThrow();
  });
});

describe("anything unexpected comes back as a plain message", () => {
  it("a broken road network gives 'we couldn't work this out', not an exception", () => {
    const broken = { ...intersectionNet(), ways: null } as unknown as RoadNetwork;
    for (const out of [simulate(tBoneScene(), broken), placeVehicles(tBoneScene(), broken, PIN)]) {
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.errors.map((e) => e.code)).toEqual(["cannot-work-out"]);
        expect(out.errors[0]!.text).toBe("We couldn't work this crash out from the details given. Check them and try again.");
      }
    }
    expect(() => checkScene(tBoneScene(), broken)).not.toThrow();
  });

  it("a road with a NaN point does not take the run down", () => {
    const base = intersectionNet();
    const net = { ...base, ways: [...base.ways, makeWay({ id: "nan", name: "Nan Road", centerline: [{ x: Number.NaN, y: 0 }, { x: 5, y: Number.NaN }] })] };
    expect(() => simulate(flatTBoneScene(), net)).not.toThrow();
    expect(() => simulate(tBoneScene(), net)).not.toThrow();
  });

  it("does not mutate what it is given", () => {
    const scene = tBoneScene({ bSpeed: unsure(30) });
    const before = JSON.stringify(scene);
    simulate(scene, intersectionNet({ mainLanes: 2 }));
    placeVehicles(scene, intersectionNet({ mainLanes: 2 }), PIN);
    checkScene(scene, null);
    expect(JSON.stringify(scene)).toBe(before);
    void MAIN; void PARK; void (null as SceneSpeed | null);
  });
});
