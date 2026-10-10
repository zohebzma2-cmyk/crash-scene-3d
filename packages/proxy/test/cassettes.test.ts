import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaceResult } from "@csd/core";
import { cassetteNames, loadCassette, recordedNodes, replay } from "./cassette";
import { START, settle, setup } from "./helpers";

// Real exchanges recorded on 2026-10-10 through the proxy (see fixtures/cassettes/ATTRIBUTION.md): the proxy must ask
// upstream for exactly what was recorded and answer exactly what it answered. No live service is contacted.
beforeEach(() => { vi.useFakeTimers({ now: START }); });
afterEach(() => { vi.useRealTimers(); });

describe.each(cassetteNames())("cassette %s", (name) => {
  const c = loadCassette(name);

  it("replays: same upstream requests, same answer", async () => {
    const r = replay(c);
    const t = setup(r.upstream);
    const res = await settle(t.get(c.request));
    expect(res.status).toBe(c.response.status);
    const got = JSON.parse(await res.text()) as unknown;
    const recorded = JSON.parse(c.response.body) as unknown;
    if (name.startsWith("suggest-")) {
      // House-number results were removed from the recordings, which can let one more result in at the end.
      expect(got).toEqual(expect.arrayContaining([]));
      expect((got as unknown[]).slice(0, (recorded as unknown[]).length)).toEqual(recorded);
    } else {
      expect(got).toEqual(recorded);
    }
    expect(r.unrecorded).toEqual([]); // the proxy asked for nothing that wasn't recorded
    expect(r.used.size).toBe(c.upstream.length); // and for everything that was
  });
});

describe("the real intersections resolve to the OSM node the two streets share", () => {
  const cases: [string, string, string, string][] = [
    ["crossing-nashua-main-amherst", "Main Street", "Amherst Street", "Nashua NH (typed 'Main St and Amherst St')"],
    ["crossing-nashua-no-town", "Main Street", "Amherst Street", "Nashua, no town typed, found from the map position"],
    ["crossing-manchester-elm-hanover", "Elm Street", "Hanover Street", "Manchester NH"],
    ["crossing-concord-no-town", "North Main Street", "Pleasant Street", "Concord, no town typed"],
    ["crossing-boston-boylston-tremont", "Boylston Street", "Tremont Street", "Boston MA"],
  ];
  it.each(cases)("%s", async (name, a, b) => {
    const c = loadCassette(name);
    const t = setup(replay(c).upstream);
    const places = (await (await settle(t.get(c.request))).json()) as PlaceResult[];
    expect(places.length).toBeGreaterThanOrEqual(1);
    const hit = places[0]!;
    expect(hit).toMatchObject({ kind: "crossing", category: "crossing", streets: [a, b] });
    expect(hit.approximate).toBeUndefined();
    expect(hit.main).toBe(`${a} & ${b}`);
    // The point is a node that both streets' ways contain in the recorded OSM data.
    const nodes = recordedNodes(c, [a, b]);
    const onA = new Map([...nodes.get(a)!].map(([id, p]) => [`${p.lat},${p.lon}`, id]));
    const shared = [...nodes.get(b)!].filter(([id, p]) => onA.get(`${p.lat},${p.lon}`) === id && p.lat === hit.lat && p.lon === hit.lon);
    expect(shared, "the answer must be a node both streets share").toHaveLength(1);
  });

  it("'Main St and Amherst St, Nashua NH' puts the pin where Zoheb's trial expected: downtown Nashua, node 41353060", async () => {
    const c = loadCassette("crossing-nashua-main-amherst");
    const t = setup(replay(c).upstream);
    const [hit] = (await (await settle(t.get(c.request))).json()) as PlaceResult[];
    expect(hit!.lat).toBeCloseTo(42.7654445, 6);
    expect(hit!.lon).toBeCloseTo(-71.4675501, 6);
    expect(hit!.sub).toBe("Nashua NH");
  });

  it("the same crossing is found with or without the town typed", async () => {
    const withTown = (await (await settle(setup(replay(loadCassette("crossing-nashua-main-amherst")).upstream).get(loadCassette("crossing-nashua-main-amherst").request))).json()) as PlaceResult[];
    const noTown = (await (await settle(setup(replay(loadCassette("crossing-nashua-no-town")).upstream).get(loadCassette("crossing-nashua-no-town").request))).json()) as PlaceResult[];
    expect([noTown[0]!.lat, noTown[0]!.lon]).toEqual([withTown[0]!.lat, withTown[0]!.lon]);
    expect(noTown[0]!.sub).toBe("Nashua, NH"); // "Town, ST" from Photon
  });
});

