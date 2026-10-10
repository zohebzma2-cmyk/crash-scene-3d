// A crash that can't happen is refused in plain words; "not sure" speeds are narrowed to where it can.
import { describe, expect, it } from "vitest";
import { checkScene, placeVehicles, simulate } from "../src";
import type { Scene, SceneSpeed, SimulationResult } from "../src";
import { NOTHING_MOVING_TEXT } from "../src/physics/model";
import { cutSentence, excludedRuns, gapSentence, selectRange } from "../src/physics/ranges";
import { MAIN, MPH, PARK, expectOk, flatTBoneScene, holeScene, known, sceneOf, unsure, veh } from "./physics-helpers";
import { formatSpeedExact } from "../src/format";
import { intersectionNet, makeBuilding, makeWay, rect } from "./roads-fixtures";

const PIN = { x: 0, y: 0 };
const run = (s: Scene, net: Parameters<typeof simulate>[1] = null): SimulationResult => expectOk(simulate(s, net)).result;
const B = (r: SimulationResult) => r.vehicles.find((v) => v.id === "B")!;
const A = (r: SimulationResult) => r.vehicles.find((v) => v.id === "A")!;
const mph = (mps: number) => mps / MPH;
const bothWays = (s: Scene, net: Parameters<typeof simulate>[1] = null) => [simulate(s, net), placeVehicles(s, net, PIN)];

/** A leads (zone rear), B follows (zone front), same lane, no braking. */
const rear = (a: SceneSpeed, b: SceneSpeed): Scene => sceneOf([
  veh("A", { type: "suv", bearingDeg: 0, speed: a, zone: "rear" }),
  veh("B", { type: "pickup", bearingDeg: 0, speed: b, zone: "front" }),
], { place: "road" });

describe("a crash where nothing hits is refused in plain words, chosen by the physics", () => {
  it("B typed at 0 mph (not parked) while A hits its side: B isn't moving toward A", () => {
    for (const out of bothWays(flatTBoneScene({ aMph: 25, bSpeed: known(0) }))) {
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.errors[0]!.code).toBe("not-moving-toward");
        expect(out.errors[0]!.text).toBe("Vehicle B isn't moving toward vehicle A at 0 mph. Check B's speed or what it was doing.");
        expect([...out.errors[0]!.vehicleIds]).toEqual(["B", "A"]);
      }
    }
  });

  it("B at 0.05 mph: it does move toward A, but too slowly to reach it", () => {
    for (const out of bothWays(flatTBoneScene({ aMph: 25, bSpeed: known(0.05) }))) {
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.errors[0]!.code).toBe("too-slow");
        expect(out.errors[0]!.text).toBe("Vehicle B is moving too slowly to reach vehicle A. Check B's speed.");
      }
    }
  });

  it("A at 0.105 mph into a parked B: A is the slow one, the parked car isn't blamed", () => {
    const scene = sceneOf([
      veh("A", { bearingDeg: 0, speed: known(0.105), zone: "front" }),
      veh("B", { action: "parked", bearingDeg: 0, speed: known(0), zone: "rear" }),
    ], { place: "road" });
    for (const out of bothWays(scene)) {
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.errors[0]!.code).toBe("too-slow");
        expect(out.errors[0]!.text).toBe("Vehicle A is moving too slowly to reach vehicle B. Check A's speed.");
        expect([...out.errors[0]!.vehicleIds]).toEqual(["A", "B"]);
      }
    }
  });

  it("a braking B at 0.105 mph is just slow: a braking vehicle can't stop before the crash, so nothing says it did", () => {
    const scene = flatTBoneScene({ aMph: 25, bSpeed: known(0.105) });
    const braking: Scene = { ...scene, vehicles: scene.vehicles.map((v) => (v.id === "B" ? { ...v, braking: true } : v)) };
    for (const out of bothWays(braking)) {
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.errors[0]!.code).toBe("too-slow");
        expect(out.errors[0]!.text).toBe("Vehicle B is moving too slowly to reach vehicle A. Check B's speed.");
        expect(out.errors.some((e) => /stopped/.test(e.text) || e.code === "stopped-short")).toBe(false);
      }
    }
  });

  it("says moving-apart ONLY when the vehicles are actually separating along the contact", () => {
    const r = simulate(rear(known(40), known(20)), null);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.errors[0]!.code).toBe("moving-apart"); expect(r.errors[0]!.text).toMatch(/before they touched/); }
    // Same speed in the same lane: not separating, just not closing, so it is not 'moving apart'.
    const same = simulate(rear(known(30), known(30)), null);
    expect(same.ok).toBe(false);
    if (!same.ok) expect(same.errors[0]!.code).not.toBe("moving-apart");
  });

  it("says nobody is moving when everything is parked or at 0 mph, with the checkScene sentence", () => {
    const parked = sceneOf([veh("A", { action: "parked", speed: known(0), zone: "front" }), veh("B", { action: "parked", speed: known(0), zone: "rear" })]);
    const zero = sceneOf([veh("A", { speed: known(0), zone: "rear" }), veh("B", { speed: known(0), zone: "front" })]);
    for (const s of [parked, zero]) {
      for (const out of bothWays(s)) {
        expect(out.ok).toBe(false);
        if (!out.ok) {
          expect(out.errors[0]!.code).toBe("nothing-moving");
          expect(out.errors[0]!.text).toBe(NOTHING_MOVING_TEXT);
          expect(out.errors[0]!.text).toBe(checkScene(s, null)[0]!.text);
          expect([...out.errors[0]!.vehicleIds].sort()).toEqual(["A", "B"]);
        }
      }
    }
  });

  it("both under 0.1 mph: the slower one (the later letter on a tie) is named as too slow", () => {
    const r = simulate(flatTBoneScene({ aMph: 0.05, bSpeed: known(0.05) }), null);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]!.code).toBe("too-slow");
      expect(r.errors[0]!.text).toMatch(/is moving too slowly to reach/);
      expect(r.errors[0]!.text).not.toMatch(/moving apart/);
    }
  });
});

describe("'not sure' speeds are narrowed to where the crash works", () => {
  it("rear-end, leader known 22 mph, follower 'not sure' 20/25/30: B has to be faster, so the range starts at 22.5", () => {
    const sim = run(rear(known(22), unsure(25)));
    const b = B(sim).speedAtImpactMps;
    expect(mph(b.lo)).toBeCloseTo(22.5, 9);
    expect(mph(b.mid)).toBeCloseTo(25, 9);
    expect(mph(b.hi)).toBeCloseTo(30, 9);
    const w = sim.warnings.filter((x) => x.code.startsWith("range") || x.code === "picture-speed");
    expect(w.map((x) => x.code)).toEqual(["range-start"]);
    expect(w[0]!.text).toBe("At 22 mph and below, vehicle B wouldn't have reached vehicle A, so the numbers shown start at 22.5 mph.");
    expect([...w[0]!.vehicleIds]).toEqual(["B", "A"]);
  });

  it("the reverse: the middle (25) fails but the high end works, so the picture uses the nearest speed that works", () => {
    const sim = run(rear(known(27), unsure(25)));
    const b = B(sim).speedAtImpactMps;
    expect(mph(b.lo)).toBeCloseTo(27.5, 9);
    expect(mph(b.mid)).toBeCloseTo(27.5, 9); // the picture
    expect(mph(b.hi)).toBeCloseTo(30, 9);
    expect(mph(B(sim).impactPose.speedMps)).toBeCloseTo(27.5, 9);
    const pic = sim.warnings.find((x) => x.code === "picture-speed")!;
    expect(pic.text).toBe("Vehicle B's middle speed (25 mph) doesn't work here, so the picture uses 27.5 mph, the nearest speed that does.");
    expect(sim.warnings.some((x) => x.code === "range-start")).toBe(true);
  });

  it("a leader that is 'not sure': the range ends where the leader would stop being caught", () => {
    const sim = run(rear(unsure(25), known(27)));
    const a = A(sim).speedAtImpactMps;
    expect(mph(a.lo)).toBeCloseTo(20, 9);
    expect(mph(a.mid)).toBeCloseTo(25, 9);
    expect(mph(a.hi)).toBeCloseTo(26.5, 9);
    const end = sim.warnings.find((x) => x.code === "range-end")!;
    expect(end.text).toBe("At 27 mph and above, vehicle A and vehicle B wouldn't have been closing in on each other, so the numbers shown end at 26.5 mph.");
    expect(sim.warnings.some((x) => x.code === "range-start" || x.code === "picture-speed")).toBe(false);
  });

  it("every bound of a shown range is a valid crash, and one step outside it is not", () => {
    const cases: Array<{ name: string; make: (s: SceneSpeed) => Scene; vehicle: "A" | "B"; narrowedLow: boolean; narrowedHigh: boolean }> = [
      { name: "follower", make: (s) => rear(known(22), s), vehicle: "B", narrowedLow: true, narrowedHigh: false },
      { name: "follower, picture moved", make: (s) => rear(known(27), s), vehicle: "B", narrowedLow: true, narrowedHigh: false },
      { name: "leader", make: (s) => rear(s, known(27)), vehicle: "A", narrowedLow: false, narrowedHigh: true },
    ];
    for (const c of cases) {
      const sim = run(c.make(unsure(25)));
      const r = (c.vehicle === "A" ? A(sim) : B(sim)).speedAtImpactMps;
      for (const bound of [r.lo, r.mid, r.hi]) expect(simulate(c.make(known(mph(bound))), null).ok, `${c.name}: ${mph(bound)} mph`).toBe(true);
      if (c.narrowedLow) expect(simulate(c.make(known(mph(r.lo) - 0.5)), null).ok, `${c.name}: just under`).toBe(false);
      if (c.narrowedHigh) expect(simulate(c.make(known(mph(r.hi) + 0.5)), null).ok, `${c.name}: just over`).toBe(false);
    }
  });

  it("the cut points the warnings print are exactly the bounds: re-running a printed bound works, and one half-mph step outside it fails", () => {
    const printed = (sim: SimulationResult, code: string) => {
      const w = sim.warnings.find((x) => x.code === code)!;
      const m = /(?:start|end) at ([\d.]+) mph\.$/.exec(w.text)!;
      return Number(m[1]);
    };
    const start = printed(run(rear(known(22), unsure(25))), "range-start");
    expect(start).toBe(22.5);
    expect(simulate(rear(known(22), known(start)), null).ok).toBe(true);
    expect(simulate(rear(known(22), known(start - 0.5)), null).ok).toBe(false);
    const end = printed(run(rear(unsure(25), known(27))), "range-end");
    expect(end).toBe(26.5);
    expect(simulate(rear(known(end), known(27)), null).ok).toBe(true);
    expect(simulate(rear(known(end + 0.5), known(27)), null).ok).toBe(false);
    const moved = run(rear(known(27), unsure(25)));
    const pictureText = moved.warnings.find((x) => x.code === "picture-speed")!.text;
    expect(pictureText).toContain(`uses ${printed(moved, "range-start")} mph`);
  });

  it("blocks with a plain message when no speed in the range works", () => {
    const r = simulate(rear(known(35), unsure(25)), null);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]!.code).toBe("no-workable-speed");
      expect(r.errors[0]!.text).toMatch(/^At no speed in the range entered would the crash work\. /);
      expect([...r.errors[0]!.vehicleIds].sort()).toEqual(["A", "B"]);
    }
  });

  it("keeps the whole range when every speed works, with no range warnings", () => {
    const sim = run(flatTBoneScene({ aMph: 25, bSpeed: unsure(30) }));
    const b = B(sim).speedAtImpactMps;
    expect([mph(b.lo), mph(b.mid), mph(b.hi)].map((x) => Math.round(x * 1e6) / 1e6)).toEqual([25, 30, 35]);
    expect(sim.warnings.filter((x) => x.code.startsWith("range") || x.code === "picture-speed")).toEqual([]);
  });

  it("holds the WORKABLE range and the picture speed in speedAtImpactMps (lo / mid / hi), which the PDF reads", () => {
    const sim = run(rear(known(27), unsure(25)));
    const b = B(sim);
    expect(mph(b.speedAtImpactMps.lo)).toBeCloseTo(27.5, 9);
    expect(mph(b.speedAtImpactMps.hi)).toBeCloseTo(30, 9);
    expect(b.speedAtImpactMps.mid).toBe(b.impactPose.speedMps);
    expect(b.speedAtImpactMps.lo).toBeLessThanOrEqual(b.speedAtImpactMps.mid);
    expect(b.speedAtImpactMps.mid).toBeLessThanOrEqual(b.speedAtImpactMps.hi);
  });

  it("with two 'not sure' vehicles, the warning names the one whose approach hits the wall", () => {
    // A (Main, northbound) and B (Park, eastbound) are both 'not sure' 25..35. Only B's approach, coming from the west, reaches a wall 76 to 85 m out.
    const net = intersectionNet({ mainLanes: 2, corners: false, extraBuildings: [makeBuilding("far-wall", rect(-85, -10, -76, 10))] });
    const scene = sceneOf([
      veh("A", { type: "car", bearingDeg: 0, ...MAIN, speed: unsure(30), zone: "left" }),
      veh("B", { type: "suv", bearingDeg: 90, ...PARK, speed: unsure(30), zone: "front" }),
    ]);
    const sim = run(scene, net);
    const end = sim.warnings.find((x) => x.code === "range-end")!;
    expect(end.text).toBe("At 34.5 mph and above, vehicle B would have driven through a building before the crash, so the numbers shown end at 34 mph.");
    expect([...end.vehicleIds]).toEqual(["B"]);
    expect(end.text).not.toMatch(/vehicle A/);
    expect(mph(B(sim).speedAtImpactMps.hi)).toBeCloseTo(34, 9);
    expect(mph(A(sim).speedAtImpactMps.hi)).toBeCloseTo(34, 9); // the 'not sure' speeds move together
  });

  it("makes the speed-range assumption true when the range is narrowed or the picture speed moved", () => {
    const text = (s: Scene) => run(s).assumptions.find((a) => a.id === "speed-range")!.text;
    expect(text(flatTBoneScene({ bSpeed: unsure(30) }))).not.toMatch(/Here the crash/);
    expect(text(rear(known(22), unsure(25)))).toMatch(/ Here the crash only works for vehicle B at 22\.5 mph to 30 mph, so the numbers shown cover that\.$/);
    expect(text(rear(known(27), unsure(25)))).toMatch(/ Here the crash only works for vehicle B at 27\.5 mph to 30 mph, so the numbers shown cover that, and the picture uses 27\.5 mph\.$/);
  });
});

describe("a working set with holes is never reported as one range", () => {
  it("keeps the contiguous run that contains the picture speed and lists the rest as excluded", () => {
    expect(selectRange([2, 3, 4, 10, 11, 12, 18], 10)).toEqual({ picK: 10, lowK: 10, highK: 12, excluded: [2, 3, 4, 18] });
    expect(selectRange([0, 1, 2, 14, 15, 16], 10)).toEqual({ picK: 14, lowK: 14, highK: 16, excluded: [0, 1, 2] });
    expect(selectRange([8, 12], 10)).toEqual({ picK: 8, lowK: 8, highK: 8, excluded: [12] }); // a tie takes the lower speed
    expect(selectRange([5, 6, 7, 8, 9, 10, 11], 10)).toEqual({ picK: 10, lowK: 5, highK: 11, excluded: [] });
  });
});

describe("every sentence for a cut", () => {
  it("reads true for each cause at each end", () => {
    expect(cutSentence("start", "closing", "B", "A", "22 mph", "22.5 mph")).toBe("At 22 mph and below, vehicle B wouldn't have reached vehicle A, so the numbers shown start at 22.5 mph.");
    expect(cutSentence("end", "closing", "A", "B", "27 mph", "26.5 mph")).toBe("At 27 mph and above, vehicle A and vehicle B wouldn't have been closing in on each other, so the numbers shown end at 26.5 mph.");
    expect(cutSentence("start", "pass", "C", "A", "29.5 mph", "30 mph")).toBe("At 29.5 mph and below, vehicle C would have passed through vehicle A before the crash, so the numbers shown start at 30 mph.");
    expect(cutSentence("end", "pass", "C", "A", "30.5 mph", "30 mph")).toBe("At 30.5 mph and above, vehicle C would have passed through vehicle A before the crash, so the numbers shown end at 30 mph.");
    expect(cutSentence("start", "building", "B", "B", "17.5 mph", "18 mph")).toBe("At 17.5 mph and below, vehicle B would have driven through a building before the crash, so the numbers shown start at 18 mph.");
    expect(cutSentence("end", "building", "B", "B", "35 mph", "34.5 mph")).toBe("At 35 mph and above, vehicle B would have driven through a building before the crash, so the numbers shown end at 34.5 mph.");
  });
});

describe("the vehicle that is too slow is the one behind, decided from the geometry", () => {
  const behind = (follower: "A" | "B", fMph: number, lMph: number): Scene => sceneOf([
    veh(follower === "A" ? "B" : "A", { type: "suv", bearingDeg: 0, speed: known(lMph), zone: "rear" }), // the leader is hit in the rear
    veh(follower, { type: "pickup", bearingDeg: 0, speed: known(fMph), zone: "front" }),
  ].sort((x, y) => x.id.localeCompare(y.id)), { place: "road" });

  it("a follower at exactly the leader's speed (27 and 27) is too slow to reach it; the leader isn't blamed", () => {
    for (const follower of ["A", "B"] as const) {
      const leader = follower === "A" ? "B" : "A";
      for (const out of bothWays(behind(follower, 27, 27))) {
        expect(out.ok).toBe(false);
        if (!out.ok) {
          expect(out.errors[0]!.code).toBe("too-slow");
          expect(out.errors[0]!.text).toBe(`Vehicle ${follower} is moving too slowly to reach vehicle ${leader}. Check ${follower}'s speed.`);
          expect([...out.errors[0]!.vehicleIds]).toEqual([follower, leader]);
        }
      }
    }
  });

  it("a follower at 30 mph and a leader at 29.9 mph: the follower is too slow, whichever letter it has", () => {
    for (const follower of ["A", "B"] as const) {
      const leader = follower === "A" ? "B" : "A";
      const out = simulate(behind(follower, 30, 29.9), null);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.errors[0]!.text).toBe(`Vehicle ${follower} is moving too slowly to reach vehicle ${leader}. Check ${follower}'s speed.`);
    }
  });

  it("only a vehicle with no motion toward the other is 'not moving toward' it, and its real speed is printed", () => {
    // A drives north at 29.9 mph; B is parked facing east, so nothing along the contact (east-west) closes.
    const scene = sceneOf([
      veh("A", { type: "car", bearingDeg: 0, speed: known(29.9), zone: "left" }),
      veh("B", { type: "suv", action: "parked", bearingDeg: 90, speed: known(0), zone: "front" }),
    ]);
    for (const out of bothWays(scene)) {
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.errors[0]!.code).toBe("not-moving-toward");
        expect(out.errors[0]!.text).toBe("Vehicle A isn't moving toward vehicle B at 29.9 mph. Check A's speed or what it was doing.");
      }
    }
    expect(formatSpeedExact(29.9 * MPH)).toBe("29.9 mph");
    expect(formatSpeedExact(30 * MPH)).toBe("30 mph");
  });
});

describe("a fractional limit prints and scans the exact speeds", () => {
  it("limit 25.3: the cut points read 21.8 and 22.3 mph, not a rounded grid, and re-running them behaves", () => {
    const sim = run(rear(known(22), unsure(25.3)));
    const w = sim.warnings.find((x) => x.code === "range-start")!;
    expect(w.text).toBe("At 21.8 mph and below, vehicle B wouldn't have reached vehicle A, so the numbers shown start at 22.3 mph.");
    expect(mph(B(sim).speedAtImpactMps.lo)).toBeCloseTo(22.3, 9);
    expect(mph(B(sim).speedAtImpactMps.mid)).toBeCloseTo(25.3, 9);
    expect(mph(B(sim).speedAtImpactMps.hi)).toBeCloseTo(30.3, 9);
    expect(simulate(rear(known(22), known(22.3)), null).ok).toBe(true);
    expect(simulate(rear(known(22), known(21.8)), null).ok).toBe(false);
    const note = sim.assumptions.find((a) => a.id === "speed-range")!.text;
    expect(note).toContain("at 22.3 mph to 30.3 mph");
  });
});

describe("a real hole in the working speeds, through simulate", () => {
  const { scene, net } = holeScene(unsure(30));
  const sim = run(scene, net);
  const a = A(sim);

  it("A passes through C at the middle speeds only, so speeds either side work", () => {
    for (const [speed, ok] of [[25, true], [27, true], [27.5, false], [30, false], [34, false], [34.5, true], [35, true]] as const) {
      const again = simulate(holeScene(known(speed)).scene, net);
      expect(again.ok, `A at ${speed} mph`).toBe(ok);
      if (!again.ok) expect(again.errors[0]!.code).toBe("passes-through");
    }
  });

  it("shows the run that holds the picture, lists the separate run left out, and keeps every sentence literally true", () => {
    expect([mph(a.speedAtImpactMps.lo), mph(a.speedAtImpactMps.mid), mph(a.speedAtImpactMps.hi)].map((x) => Math.round(x * 1e6) / 1e6)).toEqual([25, 27, 27]);
    const gap = sim.warnings.find((x) => x.code === "range-gap")!;
    expect(gap.text).toBe("Speeds of 34.5 to 35 mph for vehicle A would also work, but speeds that don't work lie between them and the ones shown, so they are left out.");
    expect(sim.warnings.find((x) => x.code === "picture-speed")!.text).toBe("Vehicle A's middle speed (30 mph) doesn't work here, so the picture uses 27 mph, the nearest speed that does.");
    // Other speeds above the cut work, so there is no 'At ... and above, ... end at' sentence to be false; the gap warning says it.
    expect(sim.warnings.some((x) => x.code === "range-end" || x.code === "range-start")).toBe(false);
    // The excluded speeds really do work on their own, and the speed in between really doesn't.
    expect(simulate(holeScene(known(34.5)).scene, net).ok).toBe(true);
    expect(simulate(holeScene(known(28)).scene, net).ok).toBe(false);
  });

  it("the speed-range assumption does not say 'only' when speeds are left out", () => {
    const text = sim.assumptions.find((x) => x.id === "speed-range")!.text;
    expect(text).toContain("Here the crash works for vehicle A at 25 mph to 27 mph, and that is what the numbers shown cover; other speeds that work are left out, and the picture uses 27 mph.");
    expect(text).not.toMatch(/only works/);
  });

  it("lists each excluded run separately", () => {
    expect(excludedRuns([2, 3, 4, 18, 19])).toEqual([[2, 4], [18, 19]]);
    expect(excludedRuns([7])).toEqual([[7, 7]]);
    expect(excludedRuns([])).toEqual([]);
    expect(gapSentence("B", ["21 to 22 mph", "28 to 29 mph"])).toBe("Speeds of 21 to 22 mph and 28 to 29 mph for vehicle B would also work, but speeds that don't work lie between them and the ones shown, so they are left out.");
    expect(gapSentence("B", ["20 mph", "24 to 25 mph", "33 mph"])).toBe("Speeds of 20 mph, 24 to 25 mph and 33 mph for vehicle B would also work, but speeds that don't work lie between them and the ones shown, so they are left out.");
  });
});

describe("the map's edge and the end of a street", () => {
  const flatDiagonal = sceneOf([
    veh("A", { type: "car", bearingDeg: 45, speed: known(25), zone: "left" }),
    veh("B", { type: "suv", bearingDeg: 135, speed: known(25), zone: "front" }),
  ]);

  it("never warns 'off-road' where there is no road data: samples beyond the data's edge are skipped", () => {
    const full = intersectionNet({ corners: false });
    expect(run(flatDiagonal, full).warnings.map((w) => w.code)).toContain("off-road");
    const tiny = { ...full, radiusM: 12 }; // data covers 12 m; nothing beyond 2 m is judged
    const codes = run(flatDiagonal, tiny).warnings.map((w) => w.code);
    expect(codes).not.toContain("off-road");
    expect(codes).toContain("path-not-on-road"); // that one is about matching a road, not about data
  });

  it("when a path runs back past the end of its street it says so, not 'check its direction and lane'", () => {
    // Park Street starts 20 m west of the junction; B comes from the west at 25 mph, so its path is 56 m long.
    const base = intersectionNet({ corners: false });
    const net = { ...base, ways: base.ways.map((w) => (w.id === "park" ? makeWay({ ...w, centerline: [{ x: -20, y: 0 }, { x: 0, y: 0 }, { x: 150, y: 0 }] }) : w)) };
    const scene = sceneOf([
      veh("A", { type: "car", bearingDeg: 0, ...MAIN, speed: known(25), zone: "left" }),
      veh("B", { type: "suv", bearingDeg: 90, ...PARK, speed: known(25), zone: "front" }),
    ]);
    const sim = run(scene, net);
    const w = sim.warnings.filter((x) => x.code === "path-past-street-end");
    expect(w.map((x) => [...x.vehicleIds])).toEqual([["B"]]);
    expect(w[0]!.text).toBe("Vehicle B's path runs past where its street ends, so part of it is drawn straight.");
    expect(sim.warnings.some((x) => x.code === "off-road")).toBe(false);
    // The full street, no warning at all.
    expect(run(scene, base).warnings.some((x) => x.code === "path-past-street-end" || x.code === "off-road")).toBe(false);
  });
});
