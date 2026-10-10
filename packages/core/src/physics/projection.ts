// WGS84 <-> local East-North meters about a frame origin.
//
// One formula for the whole app (mapdata uses the same one): an equirectangular
// projection about the origin, with the WGS84 series for the length of a degree
// at the origin latitude:
//   mPerDegLat = 111132.92 - 559.82 cos(2 phi) + 1.175 cos(4 phi) - 0.0023 cos(6 phi)
//   mPerDegLon = 111412.84 cos(phi) - 93.5 cos(3 phi) + 0.118 cos(5 phi)
//   x = dLon * mPerDegLon (east), y = dLat * mPerDegLat (north)
// The error is about 2 cm at 400 m, against a full ellipsoidal projection.
// Do not swap in a spherical radius: its 0.09% scale difference would move
// roads about 23 cm against the pin at 250 m.
import type { LatLon, LocalFrame, Vec2 } from "../contracts/geometry";

const RAD = Math.PI / 180;

/** Meters per degree of latitude and of longitude at a latitude in degrees. */
export function metersPerDegree(latDeg: number): { readonly lat: number; readonly lon: number } {
  const p = latDeg * RAD;
  return {
    lat: 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p) - 0.0023 * Math.cos(6 * p),
    lon: 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p) + 0.118 * Math.cos(5 * p),
  };
}

/** WGS84 -> local East-North meters around frame.origin. */
export function toLocal(frame: LocalFrame, p: LatLon): Vec2 {
  const m = metersPerDegree(frame.origin.lat);
  return { x: (p.lon - frame.origin.lon) * m.lon, y: (p.lat - frame.origin.lat) * m.lat };
}

/** Local East-North meters -> WGS84. Exact inverse of toLocal. */
export function toLatLon(frame: LocalFrame, v: Vec2): LatLon {
  const m = metersPerDegree(frame.origin.lat);
  return { lat: frame.origin.lat + v.y / m.lat, lon: frame.origin.lon + v.x / m.lon };
}
