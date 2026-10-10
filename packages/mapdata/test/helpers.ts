import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import type { LocalFrame } from "@csd/core";

const root = fileURLToPath(new URL("../../../examples/", import.meta.url));

export interface Fixture {
  json: { center: { lat: number; lon: number }; radiusM: number; fetchedAt: string; query: string; elements: unknown[] };
  frame: LocalFrame;
}

export function loadExample(name: string): Fixture {
  const json = JSON.parse(readFileSync(`${root}${name}/osm.json`, "utf8")) as Fixture["json"];
  return { json, frame: { origin: json.center } };
}

export function loadTerrainTile(name: string, z: number, x: number, y: number) {
  const png = PNG.sync.read(readFileSync(`${root}${name}/terrain/${z}-${x}-${y}.png`));
  return { png, rgba: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength), width: png.width, height: png.height };
}
