import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUSY_MESSAGE, PROXY_ROUTES, type CrossStreetsResult, type PlaceResult, type ProxyCapabilities, type ProxyError } from "@csd/core";
import { photonToPlaces, stateAbbreviation } from "../src";
import { loadCassette, replay } from "./cassette";
import { START, config, hang, jsonResponse, settle, setup, type Call, type Upstream } from "./helpers";

beforeEach(() => { vi.useFakeTimers({ now: START }); });
afterEach(() => { vi.useRealTimers(); });

const feature = (props: Record<string, unknown>, lon = -71.4, lat = 42.7) => ({
  type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] },
  properties: { countrycode: "US", state: "New Hampshire", ...props },
});
const photon = (...features: unknown[]) => ({ type: "FeatureCollection", features });
const suggestPath = (q: string, extra = "") => `${PROXY_ROUTES.suggest}?q=${encodeURIComponent(q)}${extra}`;

describe("photonToPlaces", () => {
  it("shows 'Town, ST' on every suggestion, falling back to the county, and keeps the state", () => {
    const places = photonToPlaces(photon(
      feature({ type: "street", osm_key: "highway", osm_value: "residential", osm_type: "W", osm_id: 1, name: "Elm Street", city: "Hudson" }),
      feature({ type: "street", osm_key: "highway", osm_value: "residential", osm_type: "W", osm_id: 2, name: "Oak Lane", county: "Hillsborough County" }),
      feature({ type: "street", osm_key: "highway", osm_value: "residential", osm_type: "W", osm_id: 3, name: "Pine Road", state: "Massachusetts", city: "Fairview" }),
      feature({ type: "city", osm_key: "place", osm_value: "city", name: "Nashua", state: "New Hampshire" }),
    ), 8)!;
    expect(places.map((p) => p.sub)).toEqual(["Hudson, NH", "Hillsborough County, NH", "Fairview, MA", "Nashua, NH"]);
    expect(places.map((p) => p.label)).toEqual(["Elm Street, Hudson, NH", "Oak Lane, Hillsborough County, NH", "Pine Road, Fairview, MA", "Nashua, NH"]);
    expect(places.map((p) => p.category)).toEqual(["street", "street", "street", "place"]);
    expect(places[0]).toMatchObject({ main: "Elm Street", street: "Elm Street", town: "Hudson", state: "NH", osmWayIds: [1] });
    expect(places[1]).toMatchObject({ county: "Hillsborough County", state: "NH" });
    expect(places[1]!.town).toBeUndefined();
  });

  it("keeps United States results only", () => {
    const places = photonToPlaces(photon(
      feature({ type: "street", osm_key: "highway", osm_value: "residential", osm_type: "W", osm_id: 1, name: "Main Street", city: "Windsor", countrycode: "CA", state: "Ontario" }),
      feature({ type: "street", osm_key: "highway", osm_value: "residential", osm_type: "W", osm_id: 2, name: "Main Street", city: "Hudson" }),
    ), 8)!;
    expect(places).toHaveLength(1);
    expect(places[0]!.town).toBe("Hudson");
  });

  it("merges the pieces of one street in one town into a single suggestion with all its way ids", () => {
    const piece = (id: number, lon: number) => feature({ type: "street", osm_key: "highway", osm_value: "secondary", osm_type: "W", osm_id: id, name: "Main Street", city: "Nashua" }, lon);
    const places = photonToPlaces(photon(piece(11, -71.46), piece(12, -71.47), feature({ type: "street", osm_key: "highway", osm_value: "secondary", osm_type: "W", osm_id: 13, name: "Main Street", city: "Hollis" }), piece(14, -71.48)), 8)!;
    expect(places).toHaveLength(2);
    expect(places[0]).toMatchObject({ town: "Nashua", osmWayIds: [11, 12, 14], lon: -71.46 }); // the first piece's position
    expect(places[1]).toMatchObject({ town: "Hollis", osmWayIds: [13] });
  });

  it("drops bus stops, crossings, footpaths and cycleways", () => {
    const places = photonToPlaces(photon(
      feature({ type: "house", osm_key: "highway", osm_value: "bus_stop", osm_type: "N", name: "Main St @ Elm St", city: "Woburn" }),
      feature({ type: "street", osm_key: "highway", osm_value: "cycleway", osm_type: "W", osm_id: 5, name: "Canal Trail", city: "Fairview" }),
      feature({ type: "street", osm_key: "highway", osm_value: "footway", osm_type: "W", osm_id: 6, name: "Park Path", city: "Fairview" }),
      feature({ type: "other", osm_key: "public_transport", osm_value: "stop_position", osm_type: "N", name: "Main St", city: "Fairview" }),
      feature({ type: "street", osm_key: "highway", osm_value: "tertiary", osm_type: "W", osm_id: 7, name: "Real Street", city: "Fairview" }),
    ), 8)!;
    expect(places.map((p) => p.main)).toEqual(["Real Street"]);
  });

  it("maps an address (made-up number) with its street, town and postcode, and ignores features without coordinates", () => {
    const places = photonToPlaces(photon(
      feature({ type: "house", osm_key: "building", osm_value: "yes", osm_type: "W", housenumber: "1", street: "Example Road", city: "Testville", postcode: "03000" }),
      { type: "Feature", geometry: {}, properties: { countrycode: "US", name: "No coordinates" } },
    ), 8)!;
    expect(places).toHaveLength(1);
    expect(places[0]).toMatchObject({ category: "address", main: "1 Example Road", street: "Example Road", town: "Testville", state: "NH", postcode: "03000", label: "1 Example Road, Testville, NH, 03000" });
  });

  it("returns null when the body isn't a Photon response, and cuts to the limit", () => {
    expect(photonToPlaces({ hello: "world" }, 5)).toBeNull();
    expect(photonToPlaces("nope", 5)).toBeNull();
    const many = photon(...Array.from({ length: 20 }, (_, i) => feature({ type: "city", osm_key: "place", osm_value: "town", name: `Town ${i}` })));
    expect(photonToPlaces(many, 3)).toHaveLength(3);
  });

  it("abbreviates US states", () => {
    expect(stateAbbreviation("New Hampshire")).toBe("NH");
    expect(stateAbbreviation("Massachusetts")).toBe("MA");
    expect(stateAbbreviation("district of columbia")).toBe("DC");
    expect(stateAbbreviation("Ontario")).toBe("Ontario");
  });
});

describe("/api/geo/suggest", () => {
  const goodPhoton = (c: Call) => (c.url.includes("photon") ? jsonResponse(photon(feature({ type: "street", osm_key: "highway", osm_value: "residential", osm_type: "W", osm_id: 9, name: "Elm Street", city: "Hudson" }))) : new Response("x", { status: 500 }));

  it("asks Photon for only q, the limit, the language, a rounded bias and the street/town layers", async () => {
    const t = setup(goodPhoton);
    const res = await settle(t.get(suggestPath("elm st", "&lat=42.764812&lon=-71.468813&limit=4")));
    expect(res.status).toBe(200);
    const url = new URL(t.calls[0]!.url);
    expect(url.origin + url.pathname).toBe("https://photon.komoot.io/api");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ q: "elm st", lang: "en", lat: "42.76", lon: "-71.47", limit: "8" });
    expect(url.searchParams.getAll("layer")).toEqual(["street", "city", "locality", "district"]);
    expect([...new Set(url.searchParams.keys())].sort()).toEqual(["lang", "lat", "layer", "limit", "lon", "q"]);
    expect(t.calls[0]!.headers.get("user-agent")).toBe(config.userAgent);
    expect(t.calls).toHaveLength(1); // Nominatim is not involved
    const places = (await res.json()) as PlaceResult[];
    expect(places[0]).toMatchObject({ main: "Elm Street", sub: "Hudson, NH", category: "street" });
  });

  it("adds the address layer only when a number is typed", async () => {
    const t = setup(goodPhoton);
    await settle(t.get(suggestPath("12 elm st")));
    expect(new URL(t.calls[0]!.url).searchParams.getAll("layer")).toContain("house");
  });

  it("takes its bias from the map view when no point is given, and sets the zoom from its width", async () => {
    const t = setup(goodPhoton);
    await settle(t.get(suggestPath("elm st", "&bbox=-71.46,42.74,-71.42,42.78")));
    const url = new URL(t.calls[0]!.url);
    expect(url.searchParams.get("lat")).toBe("42.76");
    expect(url.searchParams.get("lon")).toBe("-71.44");
    expect(Number(url.searchParams.get("zoom"))).toBeGreaterThanOrEqual(10);
    expect(Number(url.searchParams.get("zoom"))).toBeLessThanOrEqual(14);
  });

  it("works without any bias", async () => {
    const t = setup(goodPhoton);
    expect((await settle(t.get(suggestPath("elm street")))).status).toBe(200);
    const url = new URL(t.calls[0]!.url);
    expect(url.searchParams.has("lat")).toBe(false);
  });

  it("is cached in the dated geo store: a repeat (any user, nearby bias) makes no upstream call and takes no token", async () => {
    const t = setup(goodPhoton);
    await settle(t.get(suggestPath("Elm  St", "&lat=42.7641&lon=-71.4681"), "u1"));
    expect(t.setKeys.every((k) => k.startsWith("geo/suggest"))).toBe(true);
    const tokens = t.tokenCalls.length;
    const again = await settle(t.get(suggestPath("elm st", "&lat=42.7649&lon=-71.4672"), "u2"));
    expect(again.headers.get("x-proxy-cache")).toBe("hit");
    expect(t.calls).toHaveLength(1);
    expect(t.tokenCalls).toHaveLength(tokens);
  });

  it.each([
    ["too short", suggestPath("ab")],
    ["missing q", PROXY_ROUTES.suggest],
    ["too long", suggestPath("x".repeat(121))],
    ["lat without lon", suggestPath("elm st", "&lat=42.7")],
    ["bad limit", suggestPath("elm st", "&limit=9")],
    ["bad bbox", suggestPath("elm st", "&bbox=1,2,3")],
    ["unknown parameter", suggestPath("elm st", "&filter=all")],
    ["control character", `${PROXY_ROUTES.suggest}?q=el%00m`],
  ])("rejects %s without calling upstream", async (_name, path) => {
    const t = setup(goodPhoton);
    const res = await settle(t.get(path));
    expect(res.status).toBe(400);
    expect(((await res.json()) as ProxyError).code).toBe("bad-request");
    expect(t.calls).toHaveLength(0);
  });

  it("answers a plain error (never HTML) when Photon fails or sends junk, and does not fall back to Nominatim", async () => {
    for (const bad of [() => new Response("<html>502</html>", { status: 502 }), () => jsonResponse({ not: "photon" }), () => new Response("not json", { status: 200 })]) {
      const t = setup(bad);
      const res = await settle(t.get(suggestPath("elm st")));
      expect(res.status).toBe(502);
      expect(((await res.json()) as ProxyError).code).toBe("upstream");
      expect(t.calls.every((c) => c.url.includes("photon"))).toBe(true);
    }
  });

  it("gives up on a hanging Photon after 4 s with the timeout error", async () => {
    const t = setup(hang);
    const res = await settle(t.get(suggestPath("elm st")));
    expect(res.status).toBe(504);
    expect(Date.now() - START).toBeLessThanOrEqual(4100);
  });

  it("is limited by a token bucket, not 1 req/s: a typing burst of 12 passes, a flood does not", async () => {
    const { capacity, refillPerS } = config.suggestBurst.perUser;
    expect([capacity, refillPerS]).toEqual([12, 3]);
    const t = setup(goodPhoton);
    const burst = await settle(Promise.all(Array.from({ length: capacity }, (_, i) => t.get(suggestPath(`elm ${i}`), "typist"))));
    expect(burst.every((r) => r.status === 200)).toBe(true);
    const flood = await settle(Promise.all(Array.from({ length: 30 }, (_, i) => t.get(suggestPath(`street ${i}`), "flooder"))));
    const ok = flood.filter((r) => r.status === 200).length;
    expect(ok).toBeGreaterThanOrEqual(capacity);
    expect(ok).toBeLessThanOrEqual(capacity + Math.ceil(refillPerS * 1.2)); // burst 12 plus the 3/s refill over the 1.2 s wait
    const refused = flood.find((r) => r.status === 429)!;
    expect(await refused.json()).toMatchObject({ code: "busy", message: BUSY_MESSAGE });
  });

  it("caps all users together at burst 20 refilling 10/s", async () => {
    const t = setup(goodPhoton);
    const users = Array.from({ length: 10 }, (_, u) => u);
    const res = await settle(Promise.all(users.flatMap((u) => Array.from({ length: 5 }, (_, i) => t.get(suggestPath(`q${u}x${i}`), `user-${u}`)))));
    const ok = res.filter((r) => r.status === 200).length;
    expect(ok).toBeGreaterThanOrEqual(20);
    expect(ok).toBeLessThanOrEqual(20 + 10 * 2); // refill 10/s over the wait
    expect(res.some((r) => r.status === 429)).toBe(true);
  });
});

/**
 * The cross-streets request the proxy itself made (inside the no-town crossing) in a recording: the street, the
 * way ids, the rounded position and the radius, taken straight from the recorded Overpass query.
 */
function recordedCrossStreetsRequest(c: ReturnType<typeof loadCassette>): { path: string; street: string; ways: string; near: string } {
  const call = c.upstream.find((u) => u.url.includes("overpass"))!;
  const ways = /way\(id:([\d,]+)\)/.exec(call.body!)![1]!;
  const [, radius, lat, lon] = /around:(\d+),(-?[\d.]+),(-?[\d.]+)/.exec(call.body!)!;
  const street = "North Main Street";
  return { path: `${PROXY_ROUTES.crossStreets}?${new URLSearchParams({ street, near: `${lat},${lon}`, radius: radius!, ways })}`, street, ways, near: `${lat},${lon}` };
}

describe("/api/geo/cross-streets", () => {
  const c = loadCassette("crossing-concord-no-town"); // its Overpass call is a recorded cross-streets lookup
  const req = recordedCrossStreetsRequest(c);
  const overpassOnly = (): Upstream => {
    const recorded = replay(c).upstream;
    return (call, signal) => (call.method === "POST" ? recorded(call, signal) : new Response("not part of this lookup", { status: 500 }));
  };
  const empty = () => setup(() => jsonResponse({ elements: [] }));
  const get = (t: ReturnType<typeof setup>, qs: string) => settle(t.get(`${PROXY_ROUTES.crossStreets}?${qs}`));
  const dataOf = (t: ReturnType<typeof setup>) => new URLSearchParams(t.calls[0]!.body).get("data")!;

  it("answers the real lookup: the street, and Pleasant Street among what crosses it", async () => {
    const t = setup(overpassOnly());
    const body = (await (await settle(t.get(req.path))).json()) as CrossStreetsResult;
    expect(body.street).toBe("North Main Street");
    const pleasant = body.crossings.find((x) => x.name === "Pleasant Street")!;
    expect(pleasant.points.length).toBeGreaterThanOrEqual(1);
    expect([pleasant.lat, pleasant.lon]).toEqual([pleasant.points[0]!.lat, pleasant.points[0]!.lon]);
    expect(pleasant.osmWayIds.length).toBeGreaterThanOrEqual(1);
    expect(t.calls).toHaveLength(1);
  });

  it("with way ids the position goes upstream rounded to 0.001 degrees (about 100 m)", async () => {
    const t = empty();
    await get(t, "street=North+Main+Street&near=43.208149,-71.537649&ways=11,12&radius=2000");
    expect(dataOf(t)).toContain("around:2000,43.208,-71.538");
    expect(dataOf(t)).toContain("way(id:11,12);");
  });

  it("with only a name, the position goes upstream rounded to 0.01 degrees (about 1 km), like Photon's bias", async () => {
    const t = empty();
    await get(t, "street=North+Main+Street&near=43.208149,-71.537649&radius=1500");
    expect(dataOf(t)).toContain("around:1500,43.21,-71.54");
    expect(dataOf(t)).not.toMatch(/43\.208|71\.537/);
  });

  it("needs only way ids when the client has no position, and then searches by id alone", async () => {
    const t = empty();
    const res = await get(t, "street=North+Main+Street&ways=11,12");
    expect(res.status).toBe(200);
    expect(dataOf(t)).toContain("way(id:11,12);");
    expect(dataOf(t)).not.toContain("around");
  });

  it("answers 400 with neither a position nor way ids", async () => {
    const t = empty();
    for (const qs of ["street=North+Main+Street", "street=North+Main+Street&radius=500"]) {
      const res = await get(t, qs);
      expect(res.status, qs).toBe(400);
      expect(((await res.json()) as ProxyError).code).toBe("bad-request");
    }
    expect(t.calls).toHaveLength(0);
  });

  it.each(["Ave", "St St", "Rd.", "山田通り", "!!!", "N"])("answers 400, not 500, for the unsearchable street %j", async (street) => {
    const t = empty();
    const res = await get(t, `street=${encodeURIComponent(street)}&near=43.2,-71.5`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as ProxyError).message).toContain("street");
    expect(t.calls).toHaveLength(0);
  });

  it("still lets a name through when way ids identify the street (nothing to search by name)", async () => {
    const t = empty();
    expect((await get(t, `street=${encodeURIComponent("山田通り")}&ways=5`)).status).toBe(200);
  });

  it("caches the (small) result in the dated geo store, so a repeat costs nothing", async () => {
    const t = setup(overpassOnly());
    await settle(t.get(req.path, "u1"));
    expect(t.setKeys.every((k) => k.startsWith("geo/cross-streets"))).toBe(true);
    const again = await settle(t.get(req.path, "u2"));
    expect(again.headers.get("x-proxy-cache")).toBe("hit");
    expect(t.calls).toHaveLength(1);
  });

  it.each([
    ["no street", `${PROXY_ROUTES.crossStreets}?near=42.8,-71.3`],
    ["bad near", `${PROXY_ROUTES.crossStreets}?street=Main+St&near=here`],
    ["radius too big", `${PROXY_ROUTES.crossStreets}?street=Main+St&near=42.8,-71.3&radius=5000`],
    ["radius too small", `${PROXY_ROUTES.crossStreets}?street=Main+St&near=42.8,-71.3&radius=10`],
    ["bad ways", `${PROXY_ROUTES.crossStreets}?street=Main+St&near=42.8,-71.3&ways=1,abc`],
    ["too many ways", `${PROXY_ROUTES.crossStreets}?street=Main+St&near=42.8,-71.3&ways=${Array.from({ length: 41 }, (_, i) => i + 1).join(",")}`],
    ["near out of range", `${PROXY_ROUTES.crossStreets}?street=Main+St&near=142.8,-71.3`],
    ["unknown parameter", `${PROXY_ROUTES.crossStreets}?street=Main+St&near=42.8,-71.3&q=x`],
  ])("rejects %s", async (_n, path) => {
    const t = empty();
    const res = await settle(t.get(path));
    expect(res.status).toBe(400);
    expect(t.calls).toHaveLength(0);
  });

  it("answers an empty list when nothing crosses, and reports Overpass trouble as an error", async () => {
    const t = empty();
    expect(await (await get(t, "street=Nowhere+Lane&near=42.8,-71.3")).json()).toEqual({ street: "Nowhere Lane", crossings: [] });
    const down = setup(() => new Response("down", { status: 500 }));
    expect((await get(down, "street=Nowhere+Lane&near=42.8,-71.3")).status).toBe(502);
  });
});

describe("/api/geo/crossing without a town (bias)", () => {
  const path = (a: string, b: string, extra = "&lat=43.2081&lon=-71.5376") => `${PROXY_ROUTES.crossing}?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}${extra}`;
  const concord = loadCassette("crossing-concord-no-town");

  it("asks for a bias point as a pair", async () => {
    const t = setup(replay(concord).upstream);
    expect((await settle(t.get(path("north main street", "pleasant street", "&lat=43.2")))).status).toBe(400);
  });

  it("never sends the exact bias upstream: Photon gets 0.01 degrees", async () => {
    const t = setup(replay(concord).upstream);
    await settle(t.get(path("north main street", "pleasant street", "&lat=43.208149&lon=-71.537649")));
    for (const call of t.calls) expect(`${call.url} ${call.body ?? ""}`).not.toMatch(/43\.208149|71\.537649|43\.2081|71\.5376/);
    const photonCall = t.calls.find((c) => c.url.includes("photon"))!;
    expect(new URL(photonCall.url).searchParams.get("lat")).toBe("43.21");
    expect(new URL(photonCall.url).searchParams.get("lon")).toBe("-71.54");
  });

  it("when street A is found but B does not cross it, the plain search runs and the honest answer is an empty list", async () => {
    const recorded = replay(concord).upstream;
    // Photon offers a second "North Main Street" (another town, not recorded): its surroundings are empty here.
    const t = setup(async (c, signal) => {
      if (c.url.includes("nominatim")) return jsonResponse([]);
      const answer = await recorded(c, signal);
      return answer.status === 500 && c.method === "POST" ? jsonResponse({ elements: [] }) : answer;
    });
    const res = await settle(t.get(path("north main street", "south pleasant street")));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("when Photon is down and the plain search finds nothing, the failure is reported, not an empty list", async () => {
    const t = setup((c) => (c.url.includes("nominatim") ? jsonResponse([]) : new Response("x", { status: 503 })));
    const res = await settle(t.get(path("north main street", "pleasant street")));
    expect(res.status).toBe(502);
    // …and that degraded answer isn't remembered.
    expect(t.setKeys.some((k) => k.startsWith("geo/crossing?"))).toBe(false);
  });

  it("a street name with nothing searchable in it is not a server error: the plain search answers", async () => {
    const t = setup((c) => (c.url.includes("nominatim") ? jsonResponse([]) : jsonResponse({ type: "FeatureCollection", features: [] })));
    for (const [i, a] of ["Ave", "山田通り"].entries()) {
      const res = await settle(t.get(path(a, "pleasant street"), `user-${i}`));
      expect(res.status, a).toBe(200);
    }
  });
});

describe("/api/geo/config", () => {
  it("states what the server offers and the credit lines, without calling any provider", async () => {
    const t = setup(() => new Response("x", { status: 500 }));
    const res = await t.get(PROXY_ROUTES.config);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProxyCapabilities;
    expect(body.suggest).toBe(true);
    expect(body.tileMaxZoom).toBe(config.tiles.maxZoom);
    expect(body.attribution.search).toBe("Search by Photon (komoot) · Nominatim · © OpenStreetMap contributors");
    expect(t.calls).toHaveLength(0);
  });
});
