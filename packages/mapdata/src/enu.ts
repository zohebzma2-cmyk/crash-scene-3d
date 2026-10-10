// Local East-North-Up projection used inside mapdata.
//
// Equirectangular approximation about the frame origin: metres per degree of
// latitude/longitude are the WGS84 series values at the origin latitude, then
// x = Δlon·mPerDegLon, y = Δlat·mPerDegLat. Measured against exact ellipsoidal ENU
// (WGS84 via ECEF) at 42.76°N: about 1 cm at 400 m east or 283 m diagonal, 4 cm at the
// corner of a 500 m square. Physics uses the identical formula for its projection, so the
// two agree exactly; at integration mapdata will import core's projection instead and this
// local copy goes away. Both are plain metres, x = east, y = north.
import type { LatLon, Vec2 } from "@csd/core";

const RAD = Math.PI / 180;

/** Metres per degree of latitude and longitude at a latitude (WGS84 series). */
export function metersPerDegree(latDeg: number): { lat: number; lon: number } {
  const p = latDeg * RAD;
  return {
    lat: 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p) - 0.0023 * Math.cos(6 * p),
    lon: 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p) + 0.118 * Math.cos(5 * p),
  };
}

export interface Enu {
  toLocal(p: LatLon): Vec2;
  toLatLon(v: Vec2): LatLon;
}

/** Projection about `origin`. */
export function enuAbout(origin: LatLon): Enu {
  const m = metersPerDegree(origin.lat);
  return {
    toLocal: (p) => ({ x: (p.lon - origin.lon) * m.lon, y: (p.lat - origin.lat) * m.lat }),
    toLatLon: (v) => ({ lat: origin.lat + v.y / m.lat, lon: origin.lon + v.x / m.lon }),
  };
}

/** Signed polygon area (positive = counter-clockwise), m². */
export function signedArea(ring: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i] as Vec2;
    const q = ring[(i + 1) % ring.length] as Vec2;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}
