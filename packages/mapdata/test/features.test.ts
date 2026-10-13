import { describe, expect, it } from "vitest";
import { parseOverpass } from "../src/parse";
import { featureAnchor } from "../src/features";
import { taggedLaneCount, taggedTurnArrows, taggedCrosswalkPaint, toLatLon } from "@csd/core";
import { sampleScene } from "../../core/test/fixtures";
import { loadExample } from "./helpers";
const frame = { origin: { lat: 40, lon: -75 } };
const node = (id: number, tags: Record<string, string>, lon = -75) => ({ type: "node", id, lat: 40, lon, tags });
const way = (tags: Record<string, string>) => ({ type: "way", id: 100, nodes: [1, 2, 3], geometry: [{ lat: 40, lon: -75.001 }, { lat: 40, lon: -75 }, { lat: 40, lon: -74.999 }], tags: { highway: "residential", ...tags } });
const parse = (elements: unknown[]) => parseOverpass({ elements }, frame, 250, "2026-10-11T00:00:00Z");
describe("tagged OSM road features", () => {
  it("places all node types at their coordinates without fabricating a facing", () => {
    const net = parse([node(1, { highway: "traffic_signals" }), node(2, { highway: "stop" }), node(3, { highway: "give_way" }), node(4, { highway: "crossing" }), node(5, { highway: "street_lamp" }), node(6, { traffic_sign: "US:R2-1", maxspeed: "25 mph" })]);
    expect(net.features?.map((f) => f.kind)).toEqual(["signal", "stop", "yield", "crosswalk", "street-light", "speed"]);
    for (const f of net.features ?? []) { expect(f.position).toEqual({ x: 0, y: 0 }); expect(f.facingDeg).toBeNull(); }
  });
  it("uses tagged numeric facing and reverses affected travel direction to face approaching traffic", () => {
    const net = parse([way({}), node(2, { highway: "stop", direction: "forward" }), node(9, { highway: "give_way", direction: "135" })]);
    expect(net.features?.find((f) => f.osmId === 2)?.facingDeg).toBeCloseTo(270);
    expect(net.features?.find((f) => f.osmId === 9)?.facingDeg).toBe(135);
  });
  it("does not make controls or lane facts from drawing defaults, and rejects invalid/outside points", () => {
    const net = parse([way({}), node(1, { highway: "stop" }, NaN), node(2, { highway: "traffic_signals" }, -76), node(3, {})]);
    expect(net.features).toEqual([]);
    expect(net.taggedRoads?.[0]?.lanes).toBeNull();
  });
  it("keeps reverse one-way, lane counts, turns and speed tags as road annotations", () => {
    const net = parse([way({ oneway: "-1", lanes: "2", "turn:lanes": "left|through", maxspeed: "30 mph" })]);
    expect(net.features?.map((f) => f.kind)).toEqual(["oneway", "lanes", "turn-lanes", "speed"]);
    expect(net.features?.[0]?.facingDeg).toBeCloseTo(270);
    expect(net.features?.every((f) => f.source === "way")).toBe(true);
    expect(net.taggedRoads?.[0]?.turnsForward).toEqual(["left", "through"]);
  });
  it("parses way-only crosswalks", () => {
    const net = parse([way({ highway: "footway", footway: "crossing" })]);
    expect(net.features?.[0]?.kind).toBe("crosswalk");
    expect(net.ways).toHaveLength(0);
  });
  it("draws crossing paint only for explicitly marked, mapped paths", () => {
    const unmarked: Record<string, string>[] = [{}, { "crossing:markings": "no" }];
    for (const tags of unmarked) expect(taggedCrosswalkPaint(parse([way({ highway: "footway", footway: "crossing", ...tags })]))).toEqual([]);
    const road = { ...way({ lanes: "2" }), id: 101, geometry: [{ lat: 39.999, lon: -75 }, { lat: 40.001, lon: -75 }] };
    const net = parse([way({ highway: "footway", footway: "crossing", "crossing:markings": "ladder" }), road]);
    const paint = taggedCrosswalkPaint(net);
    expect(paint.length).toBeGreaterThan(4);
    expect(taggedCrosswalkPaint(net)).toBe(paint);
    expect(net.features?.[0]?.crossingPath).toHaveLength(3);
  });
  it("offers only established directional lane counts", () => {
    const v = sampleScene().vehicles[0]!;
    v.travel = { ...v.travel, roadId: "w100", bearingDeg: 90 };
    expect(taggedLaneCount(parse([way({ lanes: "4" })]), v)).toBeNull();
    expect(taggedLaneCount(parse([way({ lanes: "4", "lanes:forward": "3", "lanes:backward": "1" })]), v)).toBe(3);
    v.travel.bearingDeg = 270;
    expect(taggedLaneCount(parse([way({ lanes: "4", "lanes:forward": "3", "lanes:backward": "1" })]), v)).toBe(1);
  });
  it("resolves named roads in older files without changing their missing road id", () => {
    const v = sampleScene().vehicles[0]!;
    v.travel = { ...v.travel, roadId: null, roadName: "Example Road", bearingDeg: 90 };
    const net = parse([way({ name: "Example Road", oneway: "yes", lanes: "3" })]);
    expect(taggedLaneCount(net, v, frame.origin)).toBe(3);
    expect(v.travel.roadId).toBeNull();
    const other = { ...way({ name: "Example Road", oneway: "yes", lanes: "2" }), id: 200 };
    expect(taggedLaneCount(parse([way({ name: "Example Road", oneway: "yes", lanes: "3" }), other]), v, frame.origin)).toBeNull();
    v.travel.roadName = "Different Road";
    expect(taggedLaneCount(net, v, frame.origin)).toBeNull();
    v.travel.roadName = "Example Road"; v.travel.bearingDeg = 270;
    expect(taggedLaneCount(net, v, frame.origin)).toBeNull();
  });
  it("uses the tagged northbound count for the unchanged highway example", () => {
    const { json, frame } = loadExample("highway-rear-end");
    const net = parseOverpass(json, frame, json.radiusM, json.fetchedAt);
    const v = sampleScene().vehicles[0]!;
    v.travel = { ...v.travel, roadId: null, roadName: "Everett Turnpike", bearingDeg: 358 };
    expect(taggedLaneCount(net, v, frame.origin)).toBe(5);
  });
  it("places an annotation at the arc-length midpoint with the local tangent", () => {
    expect(featureAnchor([{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 30, y: 10 }])).toEqual({ position: { x: 10, y: 10 }, bearingDeg: 90 });
  });
  it("offers the count at a moved pin, including curved merged roads and ambiguous lane boundaries", () => {
    const base = parse([way({ lanes: "4", "lanes:forward": "3", "lanes:backward": "1" })]);
    const first = { ...base.taggedRoads![0]!, centerline: [{ x: -100, y: 0 }, { x: 0, y: 0 }] };
    const next = { ...first, osmId: 101, lanes: 3, forward: 2, centerline: [{ x: 0, y: 0 }, { x: 0, y: 100 }] };
    const net = { ...base, ways: [{ ...base.ways[0]!, osmWayIds: [100, 101] }], taggedRoads: [first, next] };
    const v = sampleScene().vehicles[0]!;
    v.travel = { ...v.travel, roadId: "w100", bearingDeg: 90 };
    expect(taggedLaneCount(net, v, toLatLon(frame, { x: -50, y: 0 }))).toBe(3);
    v.travel.bearingDeg = 0;
    expect(taggedLaneCount(net, v, toLatLon(frame, { x: 0, y: 50 }))).toBe(2);
    v.travel.bearingDeg = 180;
    expect(taggedLaneCount(net, v, toLatLon(frame, { x: 0, y: 50 }))).toBe(1);
    const straight = { ...next, centerline: [{ x: 0, y: 0 }, { x: 100, y: 0 }] };
    v.travel.bearingDeg = 90;
    expect(taggedLaneCount({ ...net, taggedRoads: [first, straight] }, v, frame.origin)).toBeNull();
    expect(taggedLaneCount({ ...net, taggedRoads: [first, { ...straight, lanes: null, forward: null, backward: null }] }, v, toLatLon(frame, { x: 50, y: 0 }))).toBeNull();
  });
  it("keeps directional turn paint outside a tagged shared center lane", () => {
    const net = parse([way({ lanes: "3", "lanes:forward": "1", "lanes:backward": "1", "lanes:both_ways": "1", "turn:lanes:forward": "through", "turn:lanes:backward": "left" })]);
    const paint = taggedTurnArrows(net);
    const width = net.ways[0]!.laneWidthM;
    expect(paint[0]!.points[0]!.y).toBeCloseTo(-width);
    expect(paint[2]!.points[0]!.y).toBeCloseTo(width);
    expect(taggedTurnArrows(parse([way({ lanes: "4", "turn:lanes:forward": "left|through" })]))).toEqual([]);
  });
  for (const name of ["t-bone-intersection", "highway-rear-end", "parking-lot-backing"]) it(`${name} has cached feature data and provenance`, () => {
    const { json, frame } = loadExample(name);
    const net = parseOverpass(json, frame, json.radiusM, json.fetchedAt);
    expect(json.query).toContain("traffic_signals");
    expect(net.features!.length).toBeGreaterThan(0);
    for (const f of net.features!) expect(json.elements.some((e) => (e as { id: number }).id === f.osmId)).toBe(true);
  });
});
