// Roads, lots and paint are sampled from the ground MESH, so the coarse ground triangles can't poke through them.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { buildRoadArt, type RoadNetwork } from "@csd/core";
import { decodeTerrarium, parseOverpass, terrainGrid } from "@csd/mapdata";
import { LAYER, LIFT, groundSurface, lotsGeometry, paintGeometry, ribbonsGeometry } from "../../src/viewer/scene-geometry";

const NAMES = ["highway-rear-end", "t-bone-intersection", "parking-lot-backing"] as const;
const TERRAIN_CELL_M = 10; // what the app asks of the terrain service

function exampleNet(name: string): RoadNetwork {
  const dir = fileURLToPath(new URL(`../../../../examples/${name}/`, import.meta.url));
  const osm = JSON.parse(readFileSync(`${dir}osm.json`, "utf8"));
  const frame = { origin: osm.center };
  const tiles = readdirSync(`${dir}terrain/`).filter((f) => f.endsWith(".png")).map((f) => {
    const [z, x, y] = f.replace(".png", "").split("-").map(Number) as [number, number, number];
    const png = PNG.sync.read(readFileSync(`${dir}terrain/${f}`));
    return { z, x, y, size: png.width, heights: decodeTerrarium(new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength), png.width, png.height) };
  });
  const net = parseOverpass(osm, frame, osm.radiusM, osm.fetchedAt);
  return { ...net, terrain: terrainGrid(tiles, frame, osm.radiusM, TERRAIN_CELL_M) };
}

/** Height of the mesh under (x, north), found by brute force over its triangles. */
function meshHeight(pos: ArrayLike<number>, index: ArrayLike<number>, x: number, north: number): number | null {
  for (let i = 0; i < index.length; i += 3) {
    const a = index[i]! * 3, b = index[i + 1]! * 3, c = index[i + 2]! * 3;
    const ax = pos[a]!, az = pos[a + 2]!, bx = pos[b]!, bz = pos[b + 2]!, cx = pos[c]!, cz = pos[c + 2]!;
    const z = -north;
    const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(d) < 1e-12) continue;
    const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d, l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d, l3 = 1 - l1 - l2;
    if (l1 >= -1e-9 && l2 >= -1e-9 && l3 >= -1e-9) return l1 * pos[a + 1]! + l2 * pos[b + 1]! + l3 * pos[c + 1]!;
  }
  return null;
}

describe("ground surface", () => {
  const net = exampleNet("highway-rear-end");
  const size = net.radiusM * 2.4;
  const ground = groundSurface(net.terrain, size);
  it("heightAt is the height of the triangle that is drawn", () => {
    const pos = ground.geometry.getAttribute("position").array, index = ground.geometry.getIndex()!.array;
    for (const [x, y] of [[0, 0], [3.3, -17.2], [-41.7, 88.1], [120.5, -203.9], [-250, 249.9], [17, 17]] as const) {
      expect(meshHeight(pos, index, x, y)).not.toBeNull();
      expect(ground.heightAt({ x, y })).toBeCloseTo(meshHeight(pos, index, x, y)!, 3);
    }
  });
  it("is as fine as the terrain data, not coarser", () => {
    expect(net.terrain).not.toBeNull();
    const cols = Math.sqrt(ground.geometry.getAttribute("position").count) - 1;
    expect(size / cols).toBeLessThanOrEqual(net.terrain!.cellM + 1e-9);
  });
});

describe("nothing on the ground is below the ground", () => {
  for (const name of NAMES) {
    it(name, () => {
      const net = exampleNet(name);
      const ground = groundSurface(net.terrain, net.radiusM * 2.4);
      const art = buildRoadArt(net);
      const check = (label: string, g: ReturnType<typeof ribbonsGeometry>, lift: number) => {
        const pos = g.getAttribute("position").array;
        expect(g.getAttribute("position").count, label).toBeGreaterThan(0);
        for (let i = 0; i < pos.length; i += 3) {
          const x = pos[i]!, y = pos[i + 1]!, north = -pos[i + 2]!;
          expect(y, `${label} vertex at ${x.toFixed(1)},${north.toFixed(1)}`).toBeGreaterThanOrEqual(ground.heightAt({ x, y: north }) + lift - 1e-4);
        }
      };
      check("road", ribbonsGeometry(art.ribbons, ground), LIFT.road);
      check("paint", paintGeometry(art.paint, ground), LIFT.paint);
      if (net.parking.length) check("lot", lotsGeometry(net.parking, ground), LIFT.lot);
    });
  }
  it("the ground layers draw in order: ground, lot, road, paint, all before the default order 0 of vehicles and buildings", () => {
    expect([LAYER.ground, LAYER.lot, LAYER.road, LAYER.paint]).toEqual([...[LAYER.ground, LAYER.lot, LAYER.road, LAYER.paint]].sort((a, b) => a - b));
    expect(LAYER.paint).toBeLessThan(0);
  });
  it("the paths sit above the road and the paint", () => {
    expect(LIFT.path).toBeGreaterThan(LIFT.paint);
    expect(LIFT.paint).toBeGreaterThan(LIFT.road);
    expect(LIFT.road).toBeGreaterThan(LIFT.lot);
  });
});
