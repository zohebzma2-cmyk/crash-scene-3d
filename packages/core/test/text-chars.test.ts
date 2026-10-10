// Every sentence the physics produces ends up in the PDF, whose brand font has a small Latin subset.
// Allowed: printable ASCII, the middle dot, the multiplication and division signs, the superscript two,
// the plus-minus sign, curly quotes and the en dash. Anything else (for example the approx sign) prints as "?".
//
// Two guards so coverage can't silently drop:
//  1. Every message path is actually triggered here, and the set of codes, assumption ids and message templates seen
//     must equal the full expected lists below.
//  2. Every string and template literal in the physics sources that build messages is scanned for disallowed characters.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { PRESETS, checkScene, parseScene, placeVehicles, simulate } from "../src";
import { cutSentence } from "../src/physics/ranges";
import { placeDetailed } from "../src/physics/placement";
import { tooLongMessage } from "../src/physics/validate";
import { sampleScene } from "./fixtures";
import type { PlainMessage, RoadNetwork, Scene, SimulationOutcome } from "../src";
import {
  HWY, MAIN, PARK, flatRearEndScene, holeScene, flatTBoneScene, highwayRearEndScene, known, parkingBackingScene, sceneOf, tBoneScene, unsure, veh,
} from "./physics-helpers";
import { highwayNet, intersectionNet, makeBuilding, makeWay, parkingLotNet, rect } from "./roads-fixtures";

const ALLOWED = /^[\x20-\x7E·×÷²±’“”–]*$/;
/** The deepest nesting of round brackets in a text. */
function parenDepth(text: string): number {
  let depth = 0, max = 0;
  for (const c of text) {
    if (c === "(") max = Math.max(max, ++depth);
    else if (c === ")") depth = Math.max(0, depth - 1);
  }
  return max;
}
const bad = (s: string) => [...s].filter((c) => !ALLOWED.test(c)).join("");

const seen = { texts: [] as string[], codes: new Set<string>(), ids: new Set<string>() };
function take(ms: readonly PlainMessage[]): void {
  for (const m of ms) { seen.texts.push(m.text); seen.codes.add(m.code); }
}
function see(o: SimulationOutcome): SimulationOutcome {
  if (!o.ok) take(o.errors);
  else {
    take(o.result.warnings);
    for (const a of o.result.assumptions) { seen.ids.add(a.id.replace(/^mass-.*/, "mass-*")); seen.texts.push(a.text); if (a.source) seen.texts.push(a.source); if (a.unit) seen.texts.push(a.unit); }
  }
  return o;
}
function seeP(o: ReturnType<typeof placeVehicles>): void { if (!o.ok) take(o.errors); }

const example = (name: string): Scene => {
  const r = parseScene(JSON.parse(readFileSync(new URL(`../../../examples/${name}/scene.json`, import.meta.url), "utf8")));
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.value;
};
const real = JSON.parse(readFileSync(new URL("./data/t-bone-intersection-roads.json", import.meta.url), "utf8")) as RoadNetwork;
const PIN = { x: 0, y: 0 };
const rear = (a: ReturnType<typeof known>, b: ReturnType<typeof known>): Scene => sceneOf([
  veh("A", { type: "suv", bearingDeg: 0, speed: a, zone: "rear" }), veh("B", { type: "pickup", bearingDeg: 0, speed: b, zone: "front" }),
], { place: "road" });

/** Run every scene that triggers a message path. */
function triggerEverything(): void {
  // ---- assumptions: a spread of runs
  [
    simulate(flatTBoneScene(), null),
    simulate(flatTBoneScene({ bSpeed: unsure(null), condition: "ice" }), null),
    simulate(flatTBoneScene({ bSpeed: unsure(30), condition: "snow" }), null),
    simulate(flatRearEndScene({ braking: true, condition: "wet" }), null),
    simulate(tBoneScene(), intersectionNet({ mainLanes: 2 })),
    simulate(highwayRearEndScene({ braking: true }), highwayNet()),
    simulate(parkingBackingScene(), parkingLotNet()),
    simulate(example("t-bone-intersection"), real),
    simulate(example("t-bone-intersection"), null),
    simulate(example("highway-rear-end"), null),
    simulate(example("parking-lot-backing"), null),
    // a left turn and a right turn (turn radii), and one with every vehicle type's mass sentence
    simulate(sceneOf([
      veh("A", { type: "car", action: "turn-left", bearingDeg: 0, ...MAIN, speed: known(15), zone: "right" }),
      veh("B", { type: "suv", bearingDeg: 270, ...PARK, speed: known(25), zone: "front" }),
    ]), intersectionNet({ parkLanes: 2 })),
    simulate(sceneOf([
      veh("A", { type: "car", action: "turn-right", bearingDeg: 0, speed: known(8), zone: "left" }),
      veh("B", { type: "suv", bearingDeg: 90, speed: known(25), zone: "front" }),
    ]), null),
    // three vehicles (multi-impact)
    simulate(sceneOf([
      veh("A", { type: "suv", bearingDeg: 0, ...HWY, lane: 1, speed: known(20), zone: "rear" }),
      veh("B", { type: "car", bearingDeg: 0, ...HWY, lane: 1, speed: known(35), zone: "rear" }),
      veh("C", { type: "pickup", bearingDeg: 0, ...HWY, lane: 1, speed: known(50), zone: "front" }),
    ], { place: "road" }), highwayNet()),
    ...(["truck", "motorcycle", "van"] as const).map((type) => simulate(sceneOf([
      veh("A", { type, bearingDeg: 0, speed: known(25), zone: "left" }), veh("B", { type: "car", bearingDeg: 90, speed: known(25), zone: "front" }),
    ]), null)),
  ].forEach(see);

  // ---- refusals from placement and the checks
  const oneWay = intersectionNet({ parkOneWay: true });
  const half = { ...intersectionNet(), ways: [...intersectionNet().ways, makeWay({ id: "half", name: "Half Road", lanesForward: 1, lanesBackward: 0, centerline: [{ x: 300, y: -100 }, { x: 300, y: 100 }] })] };
  const refused: Array<[Scene, RoadNetwork | null]> = [
    [sceneOf([veh("A", { bearingDeg: 0, zone: "rear" }), veh("B", { bearingDeg: 180, zone: "rear" })]), null], // moving apart (head-on, both rear)
    [flatTBoneScene({ aMph: 25, bSpeed: known(0) }), null], // B isn't moving toward A
    [flatTBoneScene({ aMph: 25, bSpeed: known(0.05) }), null], // B too slow
    [sceneOf([veh("A", { bearingDeg: 0, zone: "right", speed: known(25) }), veh("B", { bearingDeg: 90, zone: "front", speed: known(25) })]), null], // zones can't touch
    [sceneOf([veh("A", { bearingDeg: 0, ...MAIN, zone: "left" }), veh("B", { bearingDeg: 90, ...PARK, zone: "front" })]), oneWay], // wrong way on a one-way
    [sceneOf([veh("A", { bearingDeg: 180, roadId: "half", roadName: "Half Road", zone: "left" }), veh("B", { bearingDeg: 90, ...PARK, zone: "front" })]), half], // no lanes that way
    [sceneOf([veh("A", { action: "turn-left", bearingDeg: 90, ...PARK, zone: "right" }), veh("B", { bearingDeg: 0, ...MAIN, zone: "front" })]), oneWay], // turn: wrong way
    [sceneOf([veh("A", { bearingDeg: 0, ...MAIN, lane: 5, zone: "left" }), veh("B", { bearingDeg: 90, ...PARK, zone: "front" })]), intersectionNet()], // no such lane
    [sceneOf([veh("A", { action: "turn-left", bearingDeg: 0, ...MAIN, lane: 7, zone: "right" }), veh("B", { bearingDeg: 270, ...PARK, zone: "front" })]), intersectionNet({ parkLanes: 2 })], // turn: no such lane
    [sceneOf([veh("A", { action: "parked", speed: known(0), zone: "front" }), veh("B", { action: "parked", speed: known(0), zone: "rear" })]), null], // nothing moving
    [flatTBoneScene({ aMph: 0.05, bSpeed: known(0.05) }), null], // too slow
    [sceneOf([
      veh("A", { type: "car", bearingDeg: 0, ...MAIN, zone: "left" }), veh("B", { type: "suv", bearingDeg: 90, ...PARK, zone: "front" }),
      veh("C", { type: "car", bearingDeg: 180, ...MAIN, zone: "rear" }),
    ]), intersectionNet()], // a vehicle nobody could hit
    [rear(known(40), known(20)), null], // moving apart (leader faster)
    [rear(known(35), unsure(25)), null], // no workable speed
    [tBoneScene(), intersectionNet({ mainLanes: 2, extraBuildings: [makeBuilding("wall", rect(0, -32, 8, -18))] })], // through a building
    // three turning vehicles whose paths run through each other
    [sceneOf([
      veh("A", { type: "suv", action: "turn-left", bearingDeg: 0, zone: "right", speed: known(58.6), braking: true }),
      veh("B", { type: "car", action: "turn-right", bearingDeg: 150, zone: "front-left", speed: known(40.9) }),
      veh("C", { type: "truck", action: "turn-right", bearingDeg: 0, zone: "front-left", speed: known(59.6) }),
    ]), null],
  ];
  // The public calls now place the nearest zone that touches; the strict calls (what the checks use) still say why the entered zones cannot.
  for (const [s, n] of refused) { see(simulate(s, n)); seeP(placeVehicles(s, n, PIN)); const strict = placeDetailed(s, n, PIN, { exactZones: true }); if (!strict.ok) take(strict.errors); }
  // Four vehicles where backing a new vehicle off to touch its partner pushes it into a third: refused honestly, not by trying other zones.
  see(simulate(sceneOf([
    veh("A", { type: "pickup", bearingDeg: 80, speed: known(34), zone: "front-right" }),
    veh("B", { type: "truck", bearingDeg: 135, speed: known(40), zone: "rear-right" }),
    veh("C", { type: "van", bearingDeg: 315, speed: known(49), zone: "rear-left" }),
    veh("D", { type: "suv", bearingDeg: 180, speed: known(23), zone: "front-right" }),
  ]), null));
  // The app's default claim: A northbound hit on its left by B westbound, which can only have hit its right side.
  see(simulate(sceneOf([
    veh("A", { type: "car", bearingDeg: 0, ...MAIN, speed: known(25), zone: "left" }),
    veh("B", { type: "suv", bearingDeg: 270, ...PARK, speed: known(25), zone: "front" }),
  ]), intersectionNet()));
  const braking: Scene = { ...flatTBoneScene({ aMph: 25, bSpeed: known(0.105) }) };
  const brakingB: Scene = { ...braking, vehicles: braking.vehicles.map((v) => (v.id === "B" ? { ...v, braking: true } : v)) };
  see(simulate(brakingB, null)); seeP(placeVehicles(brakingB, null, PIN)); // a braking crawl is just too slow
  // A path that runs back past the end of its street (Park Street starts 20 m west of the junction).
  const base0 = intersectionNet({ corners: false });
  const shortPark = { ...base0, ways: base0.ways.map((w) => (w.id === "park" ? makeWay({ ...w, centerline: [{ x: -20, y: 0 }, { x: 0, y: 0 }, { x: 150, y: 0 }] }) : w)) };
  see(simulate(sceneOf([
    veh("A", { type: "car", bearingDeg: 0, ...MAIN, speed: known(25), zone: "left" }), veh("B", { type: "suv", bearingDeg: 90, ...PARK, speed: known(25), zone: "front" }),
  ]), shortPark));
  // A real hole in the working speeds (a timing window: A would pass through C at the middle speeds only).
  const hole = holeScene(unsure(30));
  see(simulate(hole.scene, hole.net));
  // Each cause at each end of a cut: not every one is reachable by an ordinary scene, so the sentence builder is called directly.
  for (const side of ["start", "end"] as const) for (const kind of ["closing", "pass", "building"] as const) seen.texts.push(cutSentence(side, kind, "B", "A", "22 mph", "22.5 mph"));
  seeP(placeVehicles({ ...flatTBoneScene(), vehicles: [flatTBoneScene().vehicles[0]!] }, null, PIN)); // too few vehicles

  // a backing vehicle entered facing the way the other one comes from: the mismatch sentence says it was backing up
  take(checkScene(sceneOf([
    veh("A", { type: "car", bearingDeg: 80, speed: known(8), zone: "front" }),
    veh("B", { type: "van", action: "backing", bearingDeg: 270, speed: known(3), zone: "rear" }),
  ], { place: "parking" }), null));

  // ---- warnings
  const base = intersectionNet({ mainLanes: 2, corners: false });
  const tb = tBoneScene({ bSpeed: unsure(30) });
  const free = expectOkResult(simulate(tb, base));
  const a = free.vehicles.find((v) => v.id === "A")!;
  const frontMid = a.restPose.yM + 2.4;
  const wall = (edge: number) => intersectionNet({ mainLanes: 2, corners: false, extraBuildings: [makeBuilding("wall", rect(-20, edge, 60, edge + 10))] });
  see(simulate(tb, wall(frontMid - 0.5))); // stopped at a building (the picture)
  see(simulate(sceneOf([
    veh("A", { type: "car", bearingDeg: 0, speed: known(25), zone: "front-left" }), veh("B", { type: "car", bearingDeg: 90, speed: known(25), zone: "front-right" }),
  ]), null)); // stopped at a vehicle
  see(simulate(sceneOf([
    veh("A", { type: "car", bearingDeg: 45, speed: known(25), zone: "left" }), veh("B", { type: "suv", bearingDeg: 135, speed: known(25), zone: "front" }),
  ]), intersectionNet({ corners: false }))); // path-not-on-road and off-road
  see(simulate(rear(known(22), unsure(25)), null)); // range-start
  see(simulate(rear(known(27), unsure(25)), null)); // picture-speed
  see(simulate(rear(unsure(25), known(27)), null)); // range-end
  // a wall across A's approach that only its higher speeds reach: range-end through a building
  see(simulate(tBoneScene({ aMph: 25, bSpeed: known(20) }), base)); // (quiet baseline)
  const unsureA = sceneOf([
    veh("A", { type: "car", bearingDeg: 0, ...MAIN, speed: unsure(30), zone: "left" }), veh("B", { type: "suv", bearingDeg: 90, ...PARK, speed: known(20), zone: "front" }),
  ]);
  see(simulate(unsureA, intersectionNet({ mainLanes: 2, corners: false, extraBuildings: [makeBuilding("far-wall", rect(-20, -75, 30, -66))] }))); // range-end (building) and picture-speed

  // ---- input the physics won't take (it does not trust its caller)
  const at = (patch: (s: Scene) => void): Scene => { const s = sampleScene(); patch(s); return s; };
  for (const bad of [
    at((s) => { (s.vehicles[0] as { speed: unknown }).speed = { kind: "known", mph: -5 }; }), // bad-speed
    at((s) => { (s.vehicles[1]!.travel as { bearingDeg: unknown }).bearingDeg = Number.NaN; }), // bad-direction
    at((s) => { (s.vehicles[0]!.travel as { lane: unknown }).lane = 1.5; }), // bad-lane
    at((s) => { s.location.lat = Number.NaN; }), // bad-location
    at((s) => { (s.vehicles[0] as { type: unknown }).type = "banana"; }), // bad-vehicle
    at((s) => { (s.road as { condition: unknown }).condition = "lava"; }), // bad-road-condition
    at((s) => { s.vehicles = [...s.vehicles, ...s.vehicles, ...s.vehicles]; }), // too-many-vehicles
  ]) { see(simulate(bad, null)); take(checkScene(bad, null)); seeP(placeVehicles(bad, null, PIN)); }
  seeP(placeVehicles(sampleScene(), null, { x: Number.NaN, y: 0 })); // bad-pin
  see(simulate(sampleScene(), { ...intersectionNet(), ways: null } as unknown as RoadNetwork)); // cannot-work-out
  take([tooLongMessage(["A", "B"])]); // too-long: no valid input reaches the cap, so the message is built directly
  see(simulate(sampleScene(), { frame: { origin: { lat: 42.7654, lon: -71.4676 } }, radiusM: 250, ways: [], buildings: [], parking: [], terrain: null, attribution: [], fetchedAt: "2026-10-09T12:00:00Z" } as RoadNetwork)); // no-road

  // ---- checkScene
  [
    sceneOf([veh("A", { speed: known(0) }), veh("B", { action: "parked", speed: known(0) })]),
    sceneOf([veh("A", { speed: known(30), zone: "front" }), veh("B", { speed: known(40), zone: "left" })]),
    sceneOf([veh("A", { speed: known(30), zone: "rear" }), veh("B", { bearingDeg: 180, speed: known(30), zone: "front" })]),
    sceneOf([veh("A", { speed: known(30), zone: "rear" }), veh("B", { speed: known(30), zone: "front" })]),
  ].forEach((s) => take(checkScene(s, null)));
}

function expectOkResult(o: SimulationOutcome) {
  if (!o.ok) throw new Error(JSON.stringify(o.errors));
  return o.result;
}

const EXPECTED_CODES = [
  "bad-direction", "bad-lane", "bad-location", "bad-pin", "bad-road-condition", "bad-speed", "bad-vehicle", "cannot-work-out", "no-road", "too-long", "too-many-vehicles",
  "cannot-meet", "moving-apart", "no-such-lane", "no-workable-speed", "not-moving-toward", "nothing-moving", "off-road", "on-building", "passes-through",
  "path-not-on-road", "path-past-street-end", "picture-speed", "range-end", "range-gap", "range-start", "same-direction", "stopped-at-building", "stopped-at-vehicle",
  "too-few-vehicles", "too-slow", "wrong-way", "zone-mismatch", "zone-used", "zones-cannot-touch", "bodies-overlap",
].sort();
const EXPECTED_IDS = [
  "braking-deceleration", "damage-illustrated", "entered-speed", "flat-ground", "friction", "inertia", "mass-*", "multi-impact", "no-braking-default", "post-impact-slide",
  "restitution", "rigid-bodies", "speed-range", "time-step", "turn-radius-left", "turn-radius-right", "yaw",
];
const TEMPLATES: Array<[string, RegExp]> = [
  ["wrong way, one-way", /is going the wrong way on .*, which is one-way/],
  ["no lanes that way", /has no lanes for/],
  ["turn, wrong way", /ends its turn going the wrong way/],
  ["no such lane", /counting from the right\), but .* only has \d+ lanes? that way/],
  ["zones can't touch", /can't be touching at the same spot/],
  ["nobody could hit it", /none of the other vehicles was going the right way/],
  ["too few vehicles", /^Add at least two vehicles/],
  ["too many vehicles", /^4 vehicles at most\.$/],
  ["bad speed", /^Vehicle A: The speed can't be below 0 mph\.$/],
  ["bad direction", /^Vehicle B: Pick which way the vehicle was going\.$/],
  ["bad lane", /^Vehicle A: The lane has to be a whole number, counting from the right\.$/],
  ["bad location", /^The location is missing its latitude\.$/],
  ["bad vehicle", /^Vehicle A: Pick the kind of vehicle\.$/],
  ["bad road condition", /^Pick what the road was like\.$/],
  ["bad pin", /^We couldn't read where the pin is\. Move the pin onto the road where the crash happened\.$/],
  ["no road", /^We couldn't find a road near the pin\. Move the pin onto the road where the crash happened\.$/],
  ["cannot work out", /^We couldn't work this crash out from the details given\. Check them and try again\.$/],
  ["too long", /^This crash would take too long to play out\./],
  ["not moving toward", /isn't moving toward vehicle . at 0 mph\. Check .'s speed or what it was doing/],
  ["too slow", /is moving too slowly to reach vehicle .\./],
  ["past the end of the street", /path runs past where its street ends, so part of it is drawn straight/],
  ["a hole in the speeds", /would also work, but speeds that don't work lie between them and the ones shown, so they are left out/],
  ["moving apart", /would already have been moving apart before they touched/],
  ["nothing moving", /^None of the vehicles is moving/],
  ["passes through", /would have passed through vehicle/],
  ["on a building", /would have driven through a building before the crash\. Check/],
  ["no workable speed", /^At no speed in the range entered would the crash work\./],
  ["stopped at a building", /would have slid into a building after the crash/],
  ["stopped at a vehicle", /would have slid into vehicle . after the crash\. The picture stops it where they touch\./],
  ["not on a road", /doesn't line up with a road near the pin/],
  ["off the road", /off the road and any parking lot/],
  ["range start", /^At .* and below, vehicle . wouldn't have reached vehicle ., so the numbers shown start at/],
  ["range end, not closing", /^At .* and above, vehicle . and vehicle . wouldn't have been closing in on each other, so the numbers shown end at/],
  ["range end, building", /^At .* and above, vehicle . would have driven through a building before the crash, so the numbers shown end at/],
  ["range start, building", /^At .* and below, vehicle . would have driven through a building before the crash, so the numbers shown start at/],
  ["range start, pass through", /^At .* and below, vehicle . would have passed through vehicle . before the crash, so the numbers shown start at/],
  ["range end, pass through", /^At .* and above, vehicle . would have passed through vehicle . before the crash, so the numbers shown end at/],
  ["picture speed", /middle speed \(.*\) doesn't work here, so the picture uses/],
  ["same direction", /were both going/],
  ["rigid bodies", /^For the motion, vehicles are rigid bodies of typical weight for their type that don't tip over or break apart\.$/],
  ["damage illustrated", /^The dents show roughly where and how hard each vehicle was hit\. They are drawn for illustration only and don't change the motion\.$/],
  ["zone mismatch", /would have come at/],
  ["bodies overlap", /would be inside each other at the moment of the crash, so the picture can't be drawn\. Check the directions or where each vehicle was hit\./],
  ["zone used", /is marked hit on the left side, but that did not fit with the way each vehicle was going, so the picture uses the right side instead\./],
  ["zone mismatch, backing", /Vehicle B was backing up, so its front is the way it was facing\. Check the direction/],
  ["cannot meet", /nothing would have reached/],
  ["turn radius, left", /turning left follows a circular arc/],
  ["turn radius, right", /turning right follows a circular arc/],
  ["multi-impact", /^With 3 vehicles, each touching pair/],
  ["braking", /^A vehicle marked as braking slows down into the crash over the last 1\.5 seconds, at 0\.7 × the road friction × gravity, .*\. It is never shown stopping before the crash\.$/],
  ["no braking default", /^No braking or steering unless entered: a vehicle not marked as braking keeps the same speed for the whole 5 seconds\.$/],
  ["speeds", /^Speed at impact, as entered, and directions as entered\. The picture works backwards from the impact for the 5 seconds before it\.$/],
  ["spin", /Any spin slows at a steady rate set by the road friction and the vehicle's size, and can carry on briefly after it stops sliding\./],
  ["slide direction", /is treated as skidding: it moves in the direction the hit sent it, slowing at the road friction × gravity \(.*\) until it stops, even where a vehicle rolling free would slow less\./],
  ["yaw", /^A push that lands away from a vehicle's middle, or the vehicles dragging on each other where they touch, starts it spinning\. The spin slows at a steady rate set by the road friction and the vehicle's size, and the vehicle turns as it spins while it slides the way the hit sent it\.$/],
  ["collision", /^Simplified collision: the vehicles push apart along the line of the hit with a restitution of 0\.2, and grip each other where they touch with a friction of 0\.5, which can slow a vehicle hit on its side and turn both vehicles\. Total momentum is conserved\.$/],
  ["class average", /of 1,610 kg \(3,550 lb\), a class average\. Source: /],
  ["loaded truck", /a typical truck of 8,845 kg \(19,500 lb\), a loaded single-unit truck\. Source: FHWA vehicle weight class 6/],
  ["no published source", /a typical motorcycle of 230 kg \(510 lb\), a typical value without a published source\.$/],
];

describe("PDF-safe text", () => {
  it("measures nested brackets", () => {
    expect(parenDepth("a (b) c (d)")).toBe(1);
    expect(parenDepth("a (b (c))")).toBe(2);
    expect(parenDepth("at x (1.7 m/s² (5.6 ft/s²))")).toBe(2);
  });

  it("the braking sentence has one level of brackets", () => {
    const sim = simulate(flatRearEndScene({ braking: true, condition: "wet" }), null);
    if (!sim.ok) throw new Error("expected ok");
    const t = sim.result.assumptions.find((a) => a.id === "braking-deceleration")!.text;
    expect(t).toMatch(/× the road friction × gravity, \d+\.\d m\/s² \(\d+\.\d ft\/s²\)\. It is never shown stopping before the crash\.$/);
    expect(parenDepth(t)).toBe(1);
  });

  it("accepts what it should and rejects the approx sign", () => {
    expect(bad("friction 0.7 · wet 0.5, mass × (length² + width²) ÷ 12, ±100 lb, “quoted” – dash, it's")).toBe("");
    expect(bad("about ≈ 3,550")).toBe("≈");
  });

  it("every message path is triggered, and every sentence it makes uses only allowed characters", () => {
    triggerEverything();
    for (const t of seen.texts) expect(bad(t), t).toBe("");
    // Never a bracket inside a bracket: "(1.7 m/s² (5.6 ft/s²))" reads badly in the PDF.
    for (const t of seen.texts) expect(parenDepth(t), t).toBeLessThanOrEqual(1);
    for (const t of seen.texts) expect(t, t).not.toContain("((");
    expect([...seen.codes].sort()).toEqual(EXPECTED_CODES);
    expect([...seen.ids].sort()).toEqual(EXPECTED_IDS);
    for (const [name, re] of TEMPLATES) expect(seen.texts.some((t) => re.test(t)), `message template: ${name}`).toBe(true);
  });

  it("every message code written in the sources is in the expected list (so a new one can't be added unnoticed)", () => {
    const found = new Set<string>();
    for (const f of ["check.ts", "placement.ts", "simulate.ts", "model.ts", "lanes.ts", "ranges.ts", "validate.ts"]) {
      const sf = ts.createSourceFile(f, readFileSync(new URL(`../src/physics/${f}`, import.meta.url), "utf8"), ts.ScriptTarget.ES2022, true);
      const visit = (n: ts.Node): void => {
        // code: "x"  and  msg("x", ...)
        if (ts.isPropertyAssignment(n) && n.name.getText(sf) === "code" && ts.isStringLiteral(n.initializer)) found.add(n.initializer.text);
        if (ts.isCallExpression(n) && ["msg", "bad"].includes(n.expression.getText(sf)) && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) found.add(n.arguments[0].text);
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    expect([...found].sort()).toEqual(EXPECTED_CODES);
  });

  it("the mass sentence says what each preset's number is, and the motorcycle plainly has no published source", () => {
    expect(PRESETS.motorcycle.mass.unsourced).toBe(true);
    const sims = (["truck", "motorcycle", "car"] as const).map((type) => expectOkResult(simulate(sceneOf([
      veh("A", { type, bearingDeg: 0, speed: known(25), zone: "left" }), veh("B", { type: "car", bearingDeg: 90, speed: known(25), zone: "front" }),
    ]), null)));
    const text = (i: number) => sims[i]!.assumptions.find((a) => a.id === "mass-A")!;
    expect(text(0).text).toContain("a loaded single-unit truck");
    expect(text(0).text).not.toContain("class average");
    expect(text(1).text).toBe("Vehicle A is treated as a typical motorcycle of 230 kg (510 lb), a typical value without a published source.");
    expect(text(1).source).toBeUndefined();
    expect(text(2).text).toContain("a class average");
  });

  it("every string and template literal in the message-building sources uses only allowed characters", () => {
    const files = ["check.ts", "placement.ts", "simulate.ts", "model.ts", "lanes.ts", "impact.ts", "slide.ts", "validate.ts", "ranges.ts", "../format.ts"];
    let checked = 0;
    for (const f of files) {
      const text = readFileSync(new URL(`../src/physics/${f}`, import.meta.url), "utf8");
      const sf = ts.createSourceFile(f, text, ts.ScriptTarget.ES2022, true);
      const visit = (n: ts.Node): void => {
        if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
          checked++;
          expect(bad(n.text), `${f}: ${JSON.stringify(n.text.slice(0, 60))}`).toBe("");
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    expect(checked).toBeGreaterThan(80);
  });
});
