import { describe, expect, it } from "vitest";
import { crossingPoint, findCrossings, mergeSearchResults, nameMatches, overpassCrossingQuery, splitCrossingQuery } from "../src";
import { nameMatchScore } from "../src/names";
import { enuAbout } from "../src";
import { loadExample } from "./helpers";

describe("splitCrossingQuery", () => {
  it("splits the standard form", () => {
    expect(splitCrossingQuery("Main St and Amherst St, Nashua NH")).toEqual({ a: "Main St", b: "Amherst St", near: "Nashua NH" });
  });
  it.each([
    ["Main St & Amherst St, Nashua NH", "Main St", "Amherst St", "Nashua NH"],
    ["main st AND amherst st, nashua nh", "main st", "amherst st", "nashua nh"],
    ["Main St at Amherst St, Nashua", "Main St", "Amherst St", "Nashua"],
    ["Main St / Amherst St, Nashua", "Main St", "Amherst St", "Nashua"],
    ["Main St/Amherst St, Nashua", "Main St", "Amherst St", "Nashua"],
    ["Main St & Amherst St Nashua NH", "Main St", "Amherst St", "Nashua NH"],
    ["Main Street and Amherst Street", "Main Street", "Amherst Street", ""],
  ])("handles %s", (q, a, b, near) => {
    expect(splitCrossingQuery(q)).toEqual({ a, b, near });
  });
  it.each(["123 Main St, Nashua NH", "Nashua NH", "", "Hotel at the Mall, Nashua", "Main St and Main Street, Nashua", "5 & 6"])(
    "returns null for %j", (q) => { expect(splitCrossingQuery(q)).toBeNull(); });
});

describe("name matching", () => {
  it("is tolerant of abbreviations, case and punctuation", () => {
    expect(nameMatches("Main St", { name: "Main Street" })).toBe(true);
    expect(nameMatches("amherst ave.", { name: "Amherst Avenue" })).toBe(true);
    expect(nameMatches("N Main St", { name: "North Main Street" })).toBe(true);
    expect(nameMatches("Main", { name: "Main Street" })).toBe(true);
    expect(nameMatches("St Charles Ave", { name: "Saint Charles Avenue" })).toBe(true);
  });
  it("ignores accents, apostrophes and hyphens on both sides", () => {
    expect(nameMatches("O'Brien St", { name: "O'Brien Street" })).toBe(true);
    expect(nameMatches("OBrien St", { name: "O’Brien Street" })).toBe(true);
    expect(nameMatches("O’Brien Street", { name: "OBrien St" })).toBe(true);
    expect(nameMatches("Wilkes-Barre St", { name: "Wilkes Barre Street" })).toBe(true);
    expect(nameMatches("Wilkes Barre St", { name: "Wilkes-Barre Street" })).toBe(true);
    expect(nameMatches("Cafe St", { name: "Café Street" })).toBe(true);
    expect(nameMatches("Café Street", { name: "Cafe St" })).toBe(true);
  });
  it("scores an exact-words match above a street-type-less one", () => {
    expect(nameMatchScore("Main Street", { name: "Main Street" })).toBe(2);
    expect(nameMatchScore("Main St", { name: "Main Street" })).toBe(2);
    expect(nameMatchScore("Main", { name: "Main Street" })).toBe(1);
    expect(nameMatchScore("Main Street", { name: "Main" })).toBe(1);
    expect(nameMatchScore("Main Street", { name: "Main Avenue" })).toBe(0);
  });
  it("does not match different streets or different street types", () => {
    expect(nameMatches("Main St", { name: "Main Avenue" })).toBe(false);
    expect(nameMatches("Main St", { name: "Mainland Street" })).toBe(false);
    expect(nameMatches("Main St", {})).toBe(false);
  });
});

describe("overpassCrossingQuery", () => {
  const regexOf = (q: string, which = 0) => {
    const found = [...q.matchAll(/\["name"~"([^"]+)",i\]/g)][which]![1]!;
    return new RegExp(found, "i");
  };
  it("builds a short, case-insensitive filter that finds every way that could be the street", () => {
    const q = overpassCrossingQuery("Main St", "Amherst Ave", { lat: 42.76, lon: -71.46 }, 1500);
    expect(q).toContain("around:1500,42.76,-71.46");
    expect(q).toMatch(/out body geom;$/);
    // The live lesson: a 600-character spelled-out regex is not what a busy Overpass wants. Keep it tiny.
    expect(q.length).toBeLessThan(600);
    const patterns = [...q.matchAll(/\["name"~"([^"]+)",i\]/g)].map((m) => m[1]!);
    expect(patterns).toHaveLength(2);
    for (const p of patterns) expect(p.length).toBeLessThan(40);
    const main = regexOf(q, 0);
    for (const ok of ["Main Street", "main st", "MAIN ST.", "Main Str", "North Main Street", "Main"]) expect(main.test(ok), ok).toBe(true);
    for (const no of ["Elm Street", "Amherst Avenue"]) expect(main.test(no), no).toBe(false);
    const amherst = regexOf(q, 1);
    for (const ok of ["Amherst Avenue", "Amherst Street", "AMHERST ST"]) expect(amherst.test(ok), ok).toBe(true);
    expect(amherst.test("Main Street")).toBe(false);
    // Street-type words never become the search word.
    expect(q).not.toMatch(/"name"~"[^"]*(street|avenue)/i);
  });
  it("finds names with apostrophes, hyphens and accents however they are typed", () => {
    const q = overpassCrossingQuery("OBrien St", "Wilkes Barre Ave", { lat: 1, lon: 2 }, 100);
    for (const name of ["O'Brien Street", "O’Brien St", "OBrien Street"]) expect(regexOf(q, 0).test(name), name).toBe(true);
    for (const name of ["Wilkes-Barre Avenue", "Wilkes Barre Ave"]) expect(regexOf(q, 1).test(name), name).toBe(true);
    const q2 = overpassCrossingQuery("Cafe St", "Elm St", { lat: 1, lon: 2 }, 100);
    expect(regexOf(q2, 0).test("Café Street")).toBe(true);
    expect(regexOf(q2, 0).test("Cafe Street")).toBe(true);
    const q3 = overpassCrossingQuery("Café Street", "Elm St", { lat: 1, lon: 2 }, 100);
    expect(regexOf(q3, 0).test("Café Street")).toBe(true);
    expect(regexOf(q3, 0).test("Cafe Street")).toBe(true);
  });
  it("sends plain ASCII only, whatever was typed (Overpass regexes are byte-wise)", () => {
    const q = overpassCrossingQuery("O\u2019Brien Caf\u00e9 St", "Elm Ave", { lat: 1, lon: 2 }, 100);
    expect(/^[\x20-\x7e]*$/.test(q)).toBe(true);
    expect(regexOf(q, 0).test("O'Brien Caf\u00e9 Street")).toBe(true);
  });
  it("matches a very short street name as a whole word, so it doesn't select every street", () => {
    const q = overpassCrossingQuery("A St", "Elm St", { lat: 1, lon: 2 }, 100);
    const a = regexOf(q, 0);
    expect(a.test("A Street")).toBe(true);
    expect(a.test("Main Street")).toBe(false);
  });
  it("lets a street typed without its type find 'Main Street'", () => {
    const q = overpassCrossingQuery("Main", "Elm St", { lat: 1, lon: 2 }, 100);
    expect(regexOf(q, 0).test("Main Street")).toBe(true);
    expect(regexOf(q, 0).test("Main")).toBe(true);
  });
  it("cannot be used to inject QL", () => {
    const q = overpassCrossingQuery('x"]; out; //', "Elm St", { lat: 1, lon: 2 }, 100);
    expect(q).not.toContain('x"]');
  });
});

// A hand-built Overpass-shaped response: Main Street (two ways) crossing Amherst Street at node 500,
// plus a same-named Main Street in another town that touches nothing.
const O = { lat: 42.7, lon: -71.4 };
const enu = enuAbout(O);
const g = (x: number, y: number) => enu.toLatLon({ x, y });
const way = (id: number, tags: Record<string, string>, pts: [number, number][], nodes: number[]) =>
  ({ type: "way", id, tags: { highway: "secondary", ...tags }, nodes, geometry: pts.map(([x, y]) => g(x, y)) });
const FIXTURE = {
  elements: [
    way(1, { name: "Main Street" }, [[-300, 0], [0, 0]], [10, 500]),
    way(2, { name: "Main Street" }, [[0, 0], [300, 0]], [500, 11]),
    way(3, { name: "Amherst Street" }, [[0, -200], [0, 0], [0, 200]], [12, 500, 13]),
    way(4, { name: "Main Street" }, [[9000, 9000], [9100, 9000]], [90, 91]),
  ],
};

describe("crossingPoint", () => {
  it("returns the shared node where the ways meet", () => {
    const p = crossingPoint(FIXTURE, "Main St", "Amherst St")!;
    const local = enu.toLocal(p);
    expect(Math.hypot(local.x, local.y)).toBeLessThan(0.01);
  });
  it("reports both street names as OSM spells them", () => {
    const [c] = findCrossings(FIXTURE, "main st", "amherst ave");
    expect(c).toBeUndefined(); // Avenue ≠ Street
    const [d] = findCrossings(FIXTURE, "main st", "AMHERST STREET");
    expect(d!.streets).toEqual(["Main Street", "Amherst Street"]);
    expect(d!.sharedNode).toBe(true);
  });
  it("falls back to the midpoint of the closest points when no node is shared", () => {
    const apart = { elements: [
      way(1, { name: "Main Street" }, [[-100, 0], [-5, 0]], [1, 2]),
      way(3, { name: "Amherst Street" }, [[5, -100], [5, 100]], [3, 4]),
    ] };
    const c = findCrossings(apart, "Main St", "Amherst St")[0]!;
    expect(c.sharedNode).toBe(false);
    const l = enu.toLocal(c.point);
    expect(l.x).toBeCloseTo(0, 1); // midpoint of (-5,0) and (5,0)
    expect(l.y).toBeCloseTo(0, 1);
  });
  it("prefers exact-name ways over street-type-less matches", () => {
    const json = { elements: [
      way(1, { name: "Main" }, [[-100, 0], [100, 0]], [1, 2]),          // matches "Main Street" only loosely
      way(2, { name: "Main Street" }, [[-100, 300], [100, 300]], [3, 4]),
      way(3, { name: "Amherst Street" }, [[0, -50], [0, 350]], [5, 6]),
    ] };
    const c = findCrossings(json, "Main Street", "Amherst Street")[0]!;
    // The exact "Main Street" (y = 300) wins; the loose "Main" (y = 0) is ignored.
    expect(enu.toLocal(c.point).y).toBeCloseTo(300, 0);
  });
  it("only accepts a closest approach within 30 m", () => {
    const mk = (gap: number) => ({ elements: [
      way(1, { name: "Main Street" }, [[-100, 0], [-gap / 2, 0]], [1, 2]),
      way(3, { name: "Amherst Street" }, [[gap / 2, -100], [gap / 2, 100]], [3, 4]),
    ] });
    expect(findCrossings(mk(20), "Main St", "Amherst St")[0]).toMatchObject({ sharedNode: false });
    expect(findCrossings(mk(50), "Main St", "Amherst St")).toEqual([]);
  });
  it("returns null when the streets are far apart or missing", () => {
    const far = { elements: [
      way(1, { name: "Main Street" }, [[-100, 0], [-50, 0]], [1, 2]),
      way(3, { name: "Amherst Street" }, [[500, -100], [500, 100]], [3, 4]),
    ] };
    expect(crossingPoint(far, "Main St", "Amherst St")).toBeNull();
    expect(crossingPoint(FIXTURE, "Main St", "Nowhere Rd")).toBeNull();
  });
  it("prefers the crossing nearest the given place when the streets cross twice", () => {
    const twice = { elements: [
      way(1, { name: "Main Street" }, [[-300, 0], [-200, 0], [200, 0], [300, 0]], [1, 100, 200, 2]),
      way(3, { name: "Amherst Street" }, [[-200, -100], [-200, 0], [-200, 100]], [3, 100, 5]),
      way(4, { name: "Amherst Street" }, [[200, -100], [200, 0], [200, 100]], [4, 200, 6]),
    ] };
    const east = crossingPoint(twice, "Main St", "Amherst St", g(250, 0))!;
    expect(enu.toLocal(east).x).toBeCloseTo(200, 0);
  });
  it("finds the real Main St / Park St junction in the t-bone example, at the pin", () => {
    const { json, frame } = loadExample("t-bone-intersection");
    const p = crossingPoint(json, "Main St", "Park St")!;
    const local = enuAbout(frame.origin).toLocal(p);
    expect(Math.hypot(local.x, local.y)).toBeLessThan(3);
  });
});

describe("mergeSearchResults", () => {
  const r = (label: string, lat: number, lon: number, kind = "secondary") => ({ label, lat, lon, kind });
  it("collapses segments of the same street within ~300 m, keeping the first", () => {
    const out = mergeSearchResults([
      r("Main Street, Downtown, Nashua", 42.7627, -71.4661),
      r("Main Street, Nashua", 42.7640, -71.4665),
      r("Main St, Nashua", 42.7650, -71.4668),
      r("Main Street, Hudson", 42.80, -71.43),
      r("Elm Street, Nashua", 42.7628, -71.4662),
    ]);
    expect(out.map((x) => x.label)).toEqual(["Main Street, Downtown, Nashua", "Main Street, Hudson", "Elm Street, Nashua"]);
  });
  it("does not merge non-road places that share a name", () => {
    const out = mergeSearchResults([r("Dunkin', Main Street", 10, 10, "cafe"), r("Dunkin', Main Street", 10.001, 10, "cafe")]);
    expect(out).toHaveLength(2);
  });
  it("drops exact duplicates of any kind", () => {
    expect(mergeSearchResults([r("Nashua, NH", 1, 1, "city"), r("Nashua, NH", 1, 1, "city")])).toHaveLength(1);
  });
});
