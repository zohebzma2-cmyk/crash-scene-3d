// The road-type matrix (roads and paths, 2026-10-11): on every kind of place (synthetic-osm.ts), every pair of directions the
// Vehicles step offers draws along the roads. For each site, each pair of choices for A and B (going straight, turning, out of
// a driveway or parking lot), with the hit sides another vehicle could reach there:
//  - every choice offered has a path on the roads (the physics never refuses a choice it offered as "follows no road");
//  - where the pair can crash, the picture is drawn, and before the impact every corner of each body is on a road (its
//    width plus ROAD_EDGE_TOL_M, as the off-road test has it), in a junction's inside corner or in a parking lot; a vehicle
//    out of a driveway is never further off its road than the driveway reaches;
//  - at the impact the two bodies touch: neither inside the other nor apart by more than a few centimetres;
//  - no warning says the picture differs from the roads ("off-road", "drawn straight", "draws it anyway").
import { describe, expect, it } from "vitest";
import {
  DRIVEWAY_M, ROAD_EDGE_TOL_M, directionChoices, drawsAsEntered, onRoadArea, simulate, toLocal,
  type Action, type DirectionChoice, type RoadNetwork, type Scene, type SceneVehicle, type SimulationResult, type Vec2, type Zone,
} from "@csd/core";
import { boxCorners, makePoly, project, satDepth } from "../../core/src/physics/geo";
import { zonesFacing } from "../../core/src/physics/placement";
import { SITE_CENTERS, SITE_NAMES, type SiteName, siteNet } from "./synthetic-osm";

/** Overlap or gap allowed between the two bodies at the impact, m ("a few centimetres"). */
const CONTACT_TOL_M = 0.03;
const PICTURE_WRONG = /draws it anyway|drawn straight|path runs past/;

const vehicle = (id: "A" | "B", action: Action, travel: DirectionChoice["travel"], mph: number, zone: Zone): SceneVehicle => ({
  id, role: id === "A" ? "claimant" : "other", year: null, make: "", model: "", type: id === "A" ? "car" : "suv", typeSource: "manual", action,
  travel: { ...travel, lane: null }, speed: { kind: "known", mph }, braking: false, zone,
});

function sceneAt(site: SiteName, a: SceneVehicle, b: SceneVehicle): Scene {
  const c = SITE_CENTERS[site];
  return {
    schemaVersion: 4, claim: { number: "CLM-MATRIX", vehicle: { year: null, make: "", model: "" } },
    location: { lat: c.lat, lon: c.lon, label: "", nearLabel: "", source: "pin", place: site === "parking-lot" ? "parking" : "road" },
    occurred: { date: "2026-10-02", time: "17:15" }, road: { condition: "dry" }, vehicles: [a, b],
  };
}

/**
 * Is the body at this pose on the drivable area: every corner within a road's half width plus 30 cm, in a lot, or in a
 * junction's inside corner (core's onRoadArea, the same test the "off-road" warning uses)?
 */
function onRoad(net: RoadNetwork, x: number, y: number, h: number, L: number, W: number): boolean {
  const on = onRoadArea(net);
  return boxCorners(x, y, h, L, W).every((c) => on(c));
}

interface Tally { offered: number; pairs: number; drawn: number; refused: Map<string, number>; failures: string[] }

/** Every check for one drawn picture; failures are collected as sentences. */
function checkDrawn(site: SiteName, net: RoadNetwork, scene: Scene, sim: SimulationResult, label: string, out: string[]): void {
  for (const w of sim.warnings) {
    if (w.code === "off-road" || PICTURE_WRONG.test(w.text)) out.push(`${label}: warning "${w.text}"`);
  }
  const i0 = Math.round(-sim.startTimeS / sim.dtS);
  const extent = net.radiusM - 10;
  for (const v of sim.vehicles) {
    const sv = scene.vehicles.find((x) => x.id === v.id)!;
    const road = sv.travel.roadId ? net.ways.find((w) => w.id === sv.travel.roadId) : undefined;
    for (let i = 0; i < i0; i++) {
      const p = v.track[i]!;
      if (Math.abs(p.xM) > extent || Math.abs(p.yM) > extent) continue;
      if (sv.travel.fromDriveway && road) {
        const half = ((road.oneway ? road.lanesForward : road.lanesForward + road.lanesBackward) * road.laneWidthM) / 2;
        const off = project(makePoly(road.centerline), { x: p.xM, y: p.yM }).dist;
        if (off > half + DRIVEWAY_M + ROAD_EDGE_TOL_M) { out.push(`${label}: ${v.id} is ${off.toFixed(1)} m off its road out of a driveway at sample ${i}`); break; }
        continue;
      }
      if (net.ways.length > 0 && !onRoad(net, p.xM, p.yM, p.headingRad, v.lengthM, v.widthM)) { out.push(`${label}: ${v.id} leaves the road at sample ${i} (${p.xM.toFixed(1)}, ${p.yM.toFixed(1)})`); break; }
    }
  }
  const [a, b] = sim.vehicles as [SimulationResult["vehicles"][number], SimulationResult["vehicles"][number]];
  const pa = a.track[i0]!, pb = b.track[i0]!;
  const d = satDepth(boxCorners(pa.xM, pa.yM, pa.headingRad, a.lengthM, a.widthM), boxCorners(pb.xM, pb.yM, pb.headingRad, b.lengthM, b.widthM)).depth;
  if (d > CONTACT_TOL_M) out.push(`${label}: bodies overlap ${(d * 100).toFixed(1)} cm at the impact`);
  if (d < -CONTACT_TOL_M) out.push(`${label}: bodies ${(-d * 100).toFixed(1)} cm apart at the impact`);
  void site;
}

function runSite(site: SiteName): Tally {
  const net = siteNet(site);
  const pin: Vec2 = toLocal(net.frame, SITE_CENTERS[site]);
  const roads = net.ways.length ? net : null;
  const [mphA, mphB] = site === "parking-lot" ? [5, 8] : [25, 30];
  const listA = directionChoices(roads, pin, "straight").map((c) => ({ action: "straight" as Action, c }));
  const listB = [
    ...listA,
    ...(["turn-left", "turn-right", "backing"] as const).flatMap((action) => directionChoices(roads, pin, action).map((c) => ({ action: action as Action, c }))),
  ];
  const tally: Tally = { offered: listB.length, pairs: 0, drawn: 0, refused: new Map(), failures: [] };
  for (const A of listA) {
    for (const B of listB) {
      tally.pairs++;
      const label = `${site}: A ${A.c.label} / B ${B.action} ${B.c.label}`;
      const base = sceneAt(site, vehicle("A", A.action, A.c.travel, mphA, "front"), vehicle("B", B.action, B.c.travel, mphB, "front"));
      const facing = zonesFacing(base, roads, pin);
      if (!facing) {
        const r = drawsAsEntered(base, roads);
        tally.failures.push(`${label}: an offered choice has no path (${r.ok ? "?" : r.errors.map((e) => e.code).join(", ")})`);
        continue;
      }
      let drawn: Scene | null = null;
      let why = "no reachable hit side";
      for (const za of facing[0]!.slice(0, 3).map((z) => z.zone)) {
        for (const zb of facing[1]!.slice(0, 3).map((z) => z.zone)) {
          const s = { ...base, vehicles: [{ ...base.vehicles[0]!, zone: za }, { ...base.vehicles[1]!, zone: zb }] };
          const r = drawsAsEntered(s, roads);
          if (r.ok) { drawn = s; break; }
          why = r.errors[0]!.code;
          if (["off-road-direction", "no-road-to-turn-from"].includes(why)) tally.failures.push(`${label}: an offered choice refused as ${why}`);
        }
        if (drawn) break;
      }
      if (!drawn) { tally.refused.set(why, (tally.refused.get(why) ?? 0) + 1); if (process.env["MATRIX_LOG"] === "2") console.info(`REFUSED ${label}: ${why}`); continue; }
      const sim = simulate(drawn, roads);
      if (!sim.ok) { tally.failures.push(`${label}: drawsAsEntered said yes, simulate said ${sim.errors[0]!.code}`); continue; }
      tally.drawn++;
      checkDrawn(site, net, drawn, sim.result, label, tally.failures);
    }
  }
  return tally;
}

describe("the road-type matrix: every offered direction pair draws along the roads", () => {
  for (const site of SITE_NAMES) {
    it(site, () => {
      const t = runSite(site);
      console.info(`road matrix ${site}: ${t.offered} choices for B, ${t.pairs} pairs, ${t.drawn} drawn, refused ${JSON.stringify(Object.fromEntries(t.refused))}`);
      if (process.env["MATRIX_LOG"]) console.info(t.failures.join("\n"));
      expect(t.failures.slice(0, 20)).toEqual([]);
      // Every kind of place has crashes that draw.
      expect(t.drawn).toBeGreaterThan(0);
    }, 120_000);
  }

  it("offers the road's own directions at a single road, and a compass only where there are no mapped roads (said to be a fallback)", () => {
    const curved = directionChoices(siteNet("curved"), { x: 0, y: 0 }, "straight");
    expect(curved.filter((c) => c.kind === "road").map((c) => c.label)).toEqual(["Heading southeast on Willow Bend Road", "Heading northwest on Willow Bend Road"]);
    expect(curved.filter((c) => c.kind === "driveway").map((c) => c.label)).toEqual([
      "Out of a driveway or parking lot on the southwest side of Willow Bend Road", "Out of a driveway or parking lot on the northeast side of Willow Bend Road",
    ]);
    expect(curved.some((c) => c.kind === "compass")).toBe(false);
    const none = directionChoices(null, { x: 0, y: 0 }, "straight");
    expect(none.map((c) => [c.kind, c.label])).toEqual([["compass", "North"], ["compass", "East"], ["compass", "South"], ["compass", "West"]]);
    // Turning at a crossing names the road it turns from; at a single road only a driveway can lead into a turn.
    expect(directionChoices(siteNet("four-way"), { x: 0, y: 0 }, "turn-left").filter((c) => c.kind === "turn").map((c) => c.label)).toEqual(expect.arrayContaining([expect.stringMatching(/^From (Maple Avenue|Cedar Street) onto (Cedar Street|Maple Avenue), /)]));
    expect(directionChoices(siteNet("curved"), { x: 0, y: 0 }, "turn-right").every((c) => c.kind === "driveway")).toBe(true);
  });
});
