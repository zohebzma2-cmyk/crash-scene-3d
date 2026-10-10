// The map's tile layer, shared by the Location map and the vehicles-step mini map.
// Live: the full OSM raster tiles through our proxy (/api/geo/tile/{z}/{x}/{y}.png), so the
// browser only talks to its own origin. Fixtures (test mode): no OSM tiles at all. Every tile is drawn
// locally on a canvas from the example's cached road data (or is plain ground with no text where there is
// none), so the whole view is filled, nothing is bulk-downloaded from OSM, and no request leaves the origin.
import L from "leaflet";
import { useEffect, useMemo } from "react";
import { TileLayer, useMap } from "react-leaflet";
import type { RoadNetwork } from "@csd/core";
import { mapConfig } from "../config/map";
import { resolveColor } from "../lib/dom";
import { drawFallbackTile, projectNetwork, tileHasContent, TILE_SIZE, type DrawnMap, type MapColors } from "../lib/fallbackTile";
import { groundTileUrl } from "../lib/groundTile";
import { useServices } from "../services/context";

/** Marks a tile image that is a drawn stand-in, not an OSM tile, so the PDF thumbnail never copies it. */
export const NEUTRAL_TILE_ATTR = "data-neutral";

function readColors(): MapColors {
  return {
    ground: resolveColor("--color-map-ground"),
    road: resolveColor("--color-map-road"),
    roadCasing: resolveColor("--color-map-road-casing"),
    roadMajor: resolveColor("--color-map-road-major"),
    roadMajorCasing: resolveColor("--color-map-road-major-casing"),
    building: resolveColor("--color-map-building"),
    buildingEdge: resolveColor("--color-map-building-edge"),
    parking: resolveColor("--color-map-parking"),
    label: resolveColor("--color-map-label"),
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-sans").trim() || "sans-serif",
  };
}

class FixtureTileLayer extends L.TileLayer {
  private readonly drawn: DrawnMap | null;
  private colors: MapColors | null = null;
  private readonly made = new Map<string, string>();

  constructor(options: L.TileLayerOptions, drawn: DrawnMap | null) {
    super("", options);
    this.drawn = drawn;
  }

  /** A drawn tile as a data: URL, or the plain ground tile where nothing is there or no canvas can be had. */
  private standIn(z: number, x: number, y: number): string {
    if (!tileHasContent(this.drawn, { z, x, y })) return groundTileUrl();
    const key = `${z}/${x}/${y}`;
    let url = this.made.get(key);
    if (url) return url;
    url = groundTileUrl();
    try {
      const canvas = document.createElement("canvas");
      canvas.width = TILE_SIZE;
      canvas.height = TILE_SIZE;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        this.colors ??= readColors();
        drawFallbackTile(ctx, { z, x, y }, this.drawn, this.colors);
        url = canvas.toDataURL("image/png");
      }
    } catch { /* keep the ground tile */ }
    this.made.set(key, url);
    return url;
  }

  override getTileUrl(coords: L.Coords): string {
    return this.standIn(coords.z, coords.x, coords.y);
  }

  override createTile(coords: L.Coords, done: L.DoneCallback): HTMLElement {
    const tile = super.createTile(coords, done);
    tile.setAttribute(NEUTRAL_TILE_ATTR, "true");
    return tile;
  }
}

function FixtureTiles({ roads }: { roads: RoadNetwork | null }) {
  const map = useMap();
  const { physics } = useServices();
  const drawn = useMemo(() => {
    try { return roads ? projectNetwork(roads, physics.toLatLon) : null; } catch { return null; }
  }, [roads, physics]);
  useEffect(() => {
    const layer = new FixtureTileLayer({ maxZoom: mapConfig.maxZoom }, drawn);
    layer.addTo(map);
    return () => { layer.remove(); };
  }, [map, drawn]);
  return null;
}

export function MapTiles({ fixtures, roads = null }: { fixtures: boolean; roads?: RoadNetwork | null }) {
  return fixtures ? <FixtureTiles roads={roads} /> : <TileLayer url={mapConfig.tilesUrl} maxZoom={mapConfig.maxZoom} />;
}
