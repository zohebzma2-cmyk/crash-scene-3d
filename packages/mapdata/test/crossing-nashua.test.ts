import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findCrossings, crossingPoint, overpassCrossingQuery, splitCrossingQuery } from "../src";

// Real Overpass response for Main Street / Amherst Street, Nashua NH (see fixtures/ATTRIBUTION.md).
const dir = fileURLToPath(new URL("./fixtures/", import.meta.url));
const overpass = JSON.parse(readFileSync(`${dir}overpass-main-amherst-nashua.json`, "utf8")) as {
  elements: { id: number; nodes: number[]; geometry: { lat: number; lon: number }[]; tags: Record<string, string> }[];
};
const nominatim = JSON.parse(readFileSync(`${dir}nominatim-nashua-nh.json`, "utf8")) as { lat: string; lon: string }[];

/** Where OSM node 41353060 (the Amherst Street / Main Street junction) is, straight from the recorded data. */
const JUNCTION_NODE = 41353060;
const junction = (() => {
  for (const w of overpass.elements) {
    const i = w.nodes.indexOf(JUNCTION_NODE);
    if (i >= 0) return w.geometry[i]!;
  }
  throw new Error("fixture has no junction node");
})();
const NEAR = { lat: Number(nominatim[0]!.lat), lon: Number(nominatim[0]!.lon) };

describe("recorded Overpass data for Main St / Amherst St, Nashua", () => {
  it("is what the live service returns: both streets, sharing exactly one node", () => {
    const names = new Set(overpass.elements.map((w) => w.tags.name));
    expect(names.has("Main Street")).toBe(true);
    expect(names.has("Amherst Street")).toBe(true);
    const mainNodes = new Set(overpass.elements.filter((w) => w.tags.name === "Main Street").flatMap((w) => w.nodes));
    const shared = overpass.elements.filter((w) => w.tags.name === "Amherst Street").flatMap((w) => w.nodes).filter((n) => mainNodes.has(n));
    expect(shared).toEqual([JUNCTION_NODE]);
  });

  it("resolves 'Main St' + 'Amherst St' to the shared node", () => {
    const [c] = findCrossings(overpass, "Main St", "Amherst St", NEAR);
    expect(c).toBeDefined();
    expect(c!.sharedNode).toBe(true);
    expect(c!.streets).toEqual(["Main Street", "Amherst Street"]);
    expect(c!.point).toEqual(junction);
    expect(crossingPoint(overpass, "Main St", "Amherst St")).toEqual(junction);
  });

  it.each([
    ["Main St", "Amherst St"],
    ["Main Street", "Amherst Street"],
    ["main st", "amherst st"],
    ["MAIN STREET", "AMHERST STREET"],
    ["Amherst St", "Main St"],
    ["Main St.", "Amherst St."],
    ["Main", "Amherst"],
  ])("resolves %s + %s whichever way round and however abbreviated", (a, b) => {
    expect(crossingPoint(overpass, a, b)).toEqual(junction);
  });
});

describe("every way of typing the search splits and resolves to that node", () => {
  const cases: [string, { a: string; b: string; near: string }][] = [
    ["Main St and Amherst St, Nashua NH", { a: "Main St", b: "Amherst St", near: "Nashua NH" }],
    ["Main St & Amherst St, Nashua NH", { a: "Main St", b: "Amherst St", near: "Nashua NH" }],
    ["Main Street and Amherst Street, Nashua NH", { a: "Main Street", b: "Amherst Street", near: "Nashua NH" }],
    ["main st & amherst st, nashua nh", { a: "main st", b: "amherst st", near: "nashua nh" }],
    ["Main St / Amherst St, Nashua NH", { a: "Main St", b: "Amherst St", near: "Nashua NH" }],
    ["Main St at Amherst St, Nashua NH", { a: "Main St", b: "Amherst St", near: "Nashua NH" }],
    ["corner of Main St and Amherst St, Nashua, NH 03060", { a: "Main St", b: "Amherst St", near: "Nashua, NH 03060" }],
    ["the intersection of Main St & Amherst St, Nashua NH", { a: "Main St", b: "Amherst St", near: "Nashua NH" }],
    ["Main Street and Amherst Street", { a: "Main Street", b: "Amherst Street", near: "" }],
    ["main st & amherst st nashua nh", { a: "main st", b: "amherst st", near: "nashua nh" }],
  ];
  it.each(cases)("%s", (typed, expected) => {
    const parts = splitCrossingQuery(typed);
    expect(parts).toEqual(expected);
    expect(crossingPoint(overpass, parts!.a, parts!.b)).toEqual(junction);
  });

  it("the Overpass filter built for each phrasing selects both streets' ways from the real names", () => {
    for (const [typed] of cases) {
      const { a, b } = splitCrossingQuery(typed)!;
      const q = overpassCrossingQuery(a, b, NEAR, 1500);
      const [fa, fb] = [...q.matchAll(/\["name"~"([^"]+)",i\]/g)].map((m) => new RegExp(m[1]!, "i"));
      expect(fa!.test("Main Street"), typed).toBe(true);
      expect(fb!.test("Amherst Street"), typed).toBe(true);
      expect(q.length, typed).toBeLessThan(600);
    }
  });
});
