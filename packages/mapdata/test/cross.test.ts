import { describe, expect, it } from "vitest";
import { enuAbout, findCrossStreets, matchCrossStreet, overpassCrossStreetsQuery, refMatches } from "../src";

const O = { lat: 42.7, lon: -71.4 };
const enu = enuAbout(O);
const g = (x: number, y: number) => enu.toLatLon({ x, y });
const way = (id: number, tags: Record<string, string>, pts: [number, number][], nodes: number[]) =>
  ({ type: "way", id, tags: { highway: "residential", ...tags }, nodes, geometry: pts.map(([x, y]) => g(x, y)) });

// Birch Hill Road runs west-east in two pieces. North Maple Road crosses it at node 500; Derry Road
// crosses it twice (nodes 600 and 700); a driveway, an unnamed lane and another piece of Birch Hill
// itself also touch it and must not count.
const DATA = { elements: [
  way(1, { name: "Birch Hill Road" }, [[-400, 0], [0, 0]], [10, 11, 500]),
  way(2, { name: "Birch Hill Road" }, [[0, 0], [300, 0], [600, 0]], [500, 600, 700]),
  way(3, { name: "North Maple Road", highway: "secondary", ref: "NH 128" }, [[0, -300], [0, 0]], [20, 500]),
  way(4, { name: "North Maple Road", highway: "secondary", ref: "NH 128" }, [[0, 0], [0, 300]], [500, 21]),
  way(5, { name: "Derry Road" }, [[300, -200], [300, 0]], [30, 600]),
  way(6, { name: "Derry Road" }, [[300, 0], [600, 100], [600, 0]], [600, 31, 700]),
  way(7, { name: "Hidden Driveway", highway: "service", service: "driveway" }, [[100, 0], [100, 30]], [40, 41]),
  way(8, { highway: "service" }, [[200, 0], [200, 30]], [50, 51]),
  way(9, { name: "Birch Hill Road" }, [[300, 0], [300, 40]], [600, 61]),
  way(10, { name: "Unrelated Street" }, [[1000, 1000], [1100, 1000]], [90, 91]),
] };

describe("findCrossStreets", () => {
  it("lists each crossing street once, with every place it crosses, nearest the given point first", () => {
    const r = findCrossStreets(DATA, { name: "Birch Hill Rd" }, g(0, 0));
    expect(r.street).toBe("Birch Hill Road");
    expect(r.crossings.map((c) => c.name)).toEqual(["North Maple Road", "Derry Road"]);
    const maple = r.crossings[0]!;
    expect(maple).toMatchObject({ ref: "NH 128", osmWayIds: [3, 4] });
    expect(maple.points).toHaveLength(1); // both pieces end at node 500: one junction
    expect(enu.toLocal({ lat: maple.lat, lon: maple.lon }).x).toBeCloseTo(0, 3);
    const derry = r.crossings[1]!;
    expect(derry.points).toHaveLength(2); // crosses twice, at x = 300 and x = 600
    expect(derry.points.map((p) => Math.round(enu.toLocal(p).x))).toEqual([300, 600]);
    expect(derry.osmWayIds).toEqual([5, 6]);
  });

  it("orders crossings by distance from the near point", () => {
    const r = findCrossStreets(DATA, { name: "Birch Hill Road" }, g(600, 0));
    expect(r.crossings.map((c) => c.name)).toEqual(["Derry Road", "North Maple Road"]);
    expect(Math.round(enu.toLocal(r.crossings[0]!).x)).toBe(600);
  });

  it("leaves out driveways, unnamed lanes and other pieces of the same street", () => {
    const names = findCrossStreets(DATA, { name: "Birch Hill Road" }).crossings.map((c) => c.name);
    expect(names).not.toContain("Hidden Driveway");
    expect(names).not.toContain("Birch Hill Road");
    expect(names).not.toContain("Unrelated Street");
  });

  it("keeps only drivable roads: a named footway or cycleway that touches the street is not a cross street", () => {
    const data = { elements: [
      way(1, { name: "Main Street" }, [[-100, 0], [0, 0], [100, 0]], [1, 2, 3]),
      way(2, { name: "River Trail", highway: "footway" }, [[0, -100], [0, 0]], [4, 2]),
      way(3, { name: "Bike Path", highway: "cycleway" }, [[0, 0], [0, 100]], [2, 5]),
      way(4, { name: "Elm Street", highway: "tertiary" }, [[50, -100], [50, 0]], [6, 7]),
    ] };
    expect(findCrossStreets(data, { name: "Main Street" }).crossings).toEqual([]);
  });

  it("finds the street by way ids alone", () => {
    const r = findCrossStreets(DATA, { wayIds: [1, 2] }, g(0, 0));
    expect(r.street).toBe("Birch Hill Road");
    expect(r.crossings.map((c) => c.name)).toEqual(["North Maple Road", "Derry Road"]);
  });

  it("merges abbreviated spellings of one street into one entry", () => {
    const data = { elements: [
      way(1, { name: "Main Street" }, [[-100, 0], [0, 0], [100, 0]], [1, 2, 3]),
      way(2, { name: "N Elm St" }, [[0, -100], [0, 0]], [4, 2]),
      way(3, { name: "North Elm Street" }, [[0, 0], [0, 100]], [2, 5]),
    ] };
    const r = findCrossStreets(data, { name: "Main St" });
    expect(r.crossings).toHaveLength(1);
    expect(r.crossings[0]!.osmWayIds).toEqual([2, 3]);
  });

  it("returns nothing for a street that isn't in the data, and for one nothing crosses", () => {
    expect(findCrossStreets(DATA, { name: "Nowhere Lane" })).toEqual({ street: "Nowhere Lane", crossings: [] });
    expect(findCrossStreets(DATA, { name: "Unrelated Street" }).crossings).toEqual([]);
  });

  it("prefers exact-name ways to street-type-less ones", () => {
    const data = { elements: [
      way(1, { name: "Pine" }, [[-100, 0], [0, 0], [100, 0]], [1, 2, 3]),
      way(2, { name: "Cross Street" }, [[0, -100], [0, 0]], [4, 2]),
      way(3, { name: "Pine Street" }, [[500, 500], [700, 500]], [7, 8]),
      way(4, { name: "Other Street" }, [[600, 400], [600, 500]], [9, 7]),
    ] };
    expect(findCrossStreets(data, { name: "Pine Street" }).crossings.map((c) => c.name)).toEqual(["Other Street"]);
  });
});

describe("matchCrossStreet: the second street as typed", () => {
  const crossings = findCrossStreets(DATA, { name: "Birch Hill Road" }).crossings;
  it.each(["north maple", "N Maple Rd", "North Maple Road", "n. maple road", "NORTH MAPLE"])("%s → North Maple Road", (typed) => {
    expect(matchCrossStreet(crossings, typed)?.name).toBe("North Maple Road");
  });
  it.each(["Derry", "Derry Rd", "derry road"])("%s → Derry Road", (typed) => {
    expect(matchCrossStreet(crossings, typed)?.name).toBe("Derry Road");
  });
  it("matches a route number by its ref", () => {
    for (const typed of ["NH 128", "Route 128", "Rte 128", "nh128", "128"]) expect(matchCrossStreet(crossings, typed)?.name, typed).toBe("North Maple Road");
  });
  it("does not match a street that isn't among them", () => {
    expect(matchCrossStreet(crossings, "South Maple Road")).toBeNull();
    expect(matchCrossStreet(crossings, "Birch Hill")).toBeNull();
  });
});

describe("refMatches", () => {
  it.each([
    ["Route 111", "NH 111", true], ["Rte 111", "NH 111", true], ["NH 111", "NH 111", true], ["111", "NH 111", true],
    ["NH 101A", "NH 101A", true], ["route 101a", "NH 101A", true], ["US 3", "US 3;NH 102", true], ["102", "US 3;NH 102", true],
    ["Route 111", "NH 121", false], ["Route 11", "NH 111", false], ["Route 101", "NH 101A", false], ["Main", "NH 111", false], ["Route 111", undefined, false],
  ])("%s vs %s → %s", (typed, ref, expected) => {
    expect(refMatches(typed, ref)).toBe(expected);
  });
});

describe("overpassCrossStreetsQuery", () => {
  it("finds the street by a tiny name filter and takes every named drivable way that shares a node with it", () => {
    const q = overpassCrossStreetsQuery({ name: "Birch Hill Rd" }, { lat: 42.7656, lon: -71.4677 }, 1500);
    expect(q).toContain("around:1500,42.7656,-71.4677");
    expect(q).toContain("node(w.s)->.n;");
    expect(q).toContain('way(bn.n)["highway"]["name"]->.x;');
    expect(q).not.toContain("motorway"); // no big highway-kind alternation: it made the query many times slower live
    expect(q).toMatch(/out body geom;$/);
    expect(/^[\x20-\x7e]*$/.test(q)).toBe(true);
    expect(q.length).toBeLessThan(700);
    expect(q).toContain('["name"~"(bir|irch)",i]');
  });
  it("adds way ids when given, and works with ids alone", () => {
    const both = overpassCrossStreetsQuery({ name: "Main St", wayIds: [11, 12] }, { lat: 1, lon: 2 }, 500);
    expect(both).toContain("way(id:11,12);");
    const ids = overpassCrossStreetsQuery({ wayIds: [5] }, { lat: 1, lon: 2 }, 500);
    expect(ids).toContain("(way(id:5);)->.s;");
    expect(ids).not.toContain('"name"~');
  });
  it("rejects a request with neither name nor ids, and can't be used to inject QL", () => {
    expect(() => overpassCrossStreetsQuery({}, { lat: 1, lon: 2 }, 500)).toThrow(RangeError);
    const q = overpassCrossStreetsQuery({ name: 'x"]; out; //', wayIds: [1, Number.NaN, -3, 7.5] }, { lat: 1, lon: 2 }, 500);
    expect(q).not.toContain('x"]');
    expect(q).toContain("way(id:1);");
  });
});
