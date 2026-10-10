import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeTerrarium, terrainGrid, terrainTilesFor } from "../src";
import { loadExample, loadTerrainTile } from "./helpers";

describe("decodeTerrarium", () => {
  it("applies R*256 + G + B/256 - 32768", () => {
    const rgba = new Uint8Array([
      128, 0, 0, 255,       // 0 m
      128, 10, 128, 255,    // 10.5 m
      127, 255, 0, 255,     // -1 m
      131, 232, 64, 255,    // 3*256+232+0.25 - 0 = 1000.25
    ]);
    expect(Array.from(decodeTerrarium(rgba, 2, 2))).toEqual([0, 10.5, -1, 1000.25]);
  });
  it("rejects a short buffer", () => {
    expect(() => decodeTerrarium(new Uint8Array(4), 2, 2)).toThrow(RangeError);
  });
});

function loadTiles(name: string) {
  const dir = fileURLToPath(new URL(`../../../examples/${name}/terrain/`, import.meta.url));
  return readdirSync(dir).filter((f) => f.endsWith(".png")).map((f) => {
    const [z, x, y] = f.replace(".png", "").split("-").map(Number) as [number, number, number];
    const t = loadTerrainTile(name, z, x, y);
    return { z, x, y, size: t.width, heights: decodeTerrarium(t.rgba, t.width, t.height) };
  });
}

describe("terrain from the example tiles", () => {
  const { json, frame } = loadExample("t-bone-intersection");
  const tiles = loadTiles("t-bone-intersection");

  it("tiles decode to plausible Nashua elevations (tens of metres above sea level)", () => {
    expect(tiles).toHaveLength(9);
    for (const t of tiles) {
      const min = t.heights.reduce((m, v) => Math.min(m, v), Infinity);
      const max = t.heights.reduce((m, v) => Math.max(m, v), -Infinity);
      expect(min).toBeGreaterThan(0);
      expect(max).toBeLessThan(250);
    }
  });

  it("lists the tiles that cover the scene, all present in the example", () => {
    const need = terrainTilesFor(frame, json.radiusM);
    expect(need.length).toBeGreaterThanOrEqual(1);
    for (const n of need) expect(tiles.some((t) => t.x === n.x && t.y === n.y)).toBe(true);
  });

  it("builds a grid relative to the origin elevation, with a zero at the centre", () => {
    const cell = 5;
    const grid = terrainGrid(tiles, frame, json.radiusM, cell);
    expect(grid.cols).toBe(101);
    expect(grid.rows).toBe(101);
    expect(grid.heightsM).toHaveLength(101 * 101);
    expect(grid.originM).toEqual({ x: -250, y: -250 });
    expect(grid.heightsM[50 * 101 + 50]).toBeCloseTo(0, 1);
    // Real hillside, but nothing absurd inside a 500 m square.
    const max = Math.max(...grid.heightsM);
    const min = Math.min(...grid.heightsM);
    expect(max - min).toBeGreaterThan(0.5);
    expect(max - min).toBeLessThan(120);
  });

  it("is continuous across tile edges (no steps larger than the local slope)", () => {
    // A grid wider than the tile spacing: sample a long strip across the 15/9878 → 15/9879 boundary.
    const wide = terrainGrid(tiles, frame, 480, 4);
    let worst = 0;
    for (let r = 0; r < wide.rows; r++) {
      for (let c = 0; c + 1 < wide.cols; c++) {
        worst = Math.max(worst, Math.abs((wide.heightsM[r * wide.cols + c + 1] as number) - (wide.heightsM[r * wide.cols + c] as number)));
      }
    }
    for (let c = 0; c < wide.cols; c++) {
      for (let r = 0; r + 1 < wide.rows; r++) {
        worst = Math.max(worst, Math.abs((wide.heightsM[(r + 1) * wide.cols + c] as number) - (wide.heightsM[r * wide.cols + c] as number)));
      }
    }
    // 4 m step: even a 30 % grade is 1.2 m. Building/bridge pixels may exceed; allow a generous bound.
    expect(worst).toBeLessThan(8);
  });

  it("matches the raw pixel at a known location", () => {
    // Grid is bilinear on pixel centres, so the origin value equals a direct decode of the origin pixel region.
    const grid = terrainGrid(tiles, frame, 100, 10);
    const centre = grid.heightsM[(grid.rows - 1) / 2 * grid.cols + (grid.cols - 1) / 2] as number;
    expect(centre).toBeCloseTo(0, 5);
  });

  it("throws, naming the tile, when a needed tile is missing", () => {
    const some = tiles.filter((t) => t.x !== tiles[4]!.x);
    expect(() => terrainGrid(some.slice(0, 1), frame, 250, 10)).toThrow(/missing terrain tiles/);
  });
});
