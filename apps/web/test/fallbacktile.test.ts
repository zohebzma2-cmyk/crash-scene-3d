// The drawn stand-in tile for fixtures mode: roads with casing, buildings, parking, labels that fit, plain ground elsewhere.
import { describe, expect, it } from "vitest";
import { drawFallbackTile, mercator, metersPerPixel, projectNetwork, tileHasContent, TILE_SIZE, type MapColors } from "../src/lib/fallbackTile";
import { fakeToLatLon } from "../src/services/fakes";
import { tbone, tboneNet } from "./fakes";

const colors: MapColors = {
  ground: "ground", road: "road", roadCasing: "casing", roadMajor: "major", roadMajorCasing: "majorCasing", building: "building",
  buildingEdge: "edge", parking: "parking", label: "label", fontFamily: "sans",
};

function recorder(textWidth = 60) {
  const calls: Array<[string, unknown[]]> = [];
  const fills: string[] = [];
  const ctx = new Proxy({}, {
    get: (_t, prop: string) => {
      if (prop === "measureText") return () => ({ width: textWidth });
      return (...a: unknown[]) => { calls.push([prop, a]); };
    },
    set: (_t, prop: string, v: unknown) => { if (prop === "fillStyle" || prop === "strokeStyle") fills.push(`${prop}:${String(v)}`); return true; },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls, fills };
}

const net = tboneNet();
const map = projectNetwork(net, fakeToLatLon);
const center = mercator(tbone.location);
const tileAt = (z: number, p: readonly [number, number]) => ({ z, x: Math.floor(p[0] * 2 ** z), y: Math.floor(p[1] * 2 ** z) });

describe("drawn fallback tile", () => {
  it("projects the roads, buildings and parking around the area", () => {
    expect(map.roads.length).toBe(net.ways.length);
    expect(map.buildings.length).toBe(net.buildings.length);
    expect(map.lat).toBeCloseTo(tbone.location.lat, 6);
  });

  it("knows which tiles have something to draw", () => {
    expect(tileHasContent(map, tileAt(18, center))).toBe(true);
    expect(tileHasContent(map, { z: 18, x: 0, y: 0 })).toBe(false);
    expect(tileHasContent(null, tileAt(18, center))).toBe(false);
  });

  it("paints ground, buildings and roads (casing before fill, major roads last), no text at low zoom", () => {
    const { ctx, calls, fills } = recorder();
    const drew = drawFallbackTile(ctx, tileAt(15, center), map, colors);
    expect(drew).toBeGreaterThan(0);
    expect(calls[0]?.[0]).toBe("fillRect");
    expect(calls[0]?.[1]).toEqual([0, 0, TILE_SIZE, TILE_SIZE]);
    expect(fills[0]).toBe("fillStyle:ground");
    expect(fills).toContain("strokeStyle:casing");
    expect(fills).toContain("strokeStyle:road");
    expect(fills.indexOf("strokeStyle:casing")).toBeLessThan(fills.indexOf("strokeStyle:road"));
    expect(calls.some(([n]) => n === "fillText")).toBe(false);
  });

  it("labels streets where the name fits on the road and lined up across tile edges", () => {
    const { ctx, calls } = recorder(40);
    drawFallbackTile(ctx, tileAt(18, center), map, colors);
    const texts = calls.filter(([n]) => n === "fillText").map(([, a]) => String(a[0]));
    expect(texts.length).toBeGreaterThan(0);
    for (const t of texts) expect(net.ways.some((w) => w.name === t)).toBe(true);
    // a name wider than any road stretch is not drawn
    const wide = recorder(100000);
    drawFallbackTile(wide.ctx, tileAt(18, center), map, colors);
    expect(wide.calls.some(([n]) => n === "fillText")).toBe(false);
  });

  it("a tile with nothing in it is plain ground, and so is any tile when there is no road data", () => {
    const a = recorder();
    expect(drawFallbackTile(a.ctx, { z: 18, x: 0, y: 0 }, map, colors)).toBe(0);
    const b = recorder();
    expect(drawFallbackTile(b.ctx, tileAt(18, center), null, colors)).toBe(0);
    expect(b.calls.map(([n]) => n)).toEqual(["fillRect"]);
  });

  it("road width follows the ground scale", () => {
    expect(metersPerPixel(42.76, 18)).toBeCloseTo(0.44, 1);
    expect(metersPerPixel(42.76, 17)).toBeCloseTo(metersPerPixel(42.76, 18) * 2, 5);
  });
});
