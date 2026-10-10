// Shared geometry. All lengths in meters, angles in radians unless the name
// says Deg. Local frame is East-North-Up around the scene origin:
// x = meters east, y = meters north. Compass bearing: 0 = north, clockwise.

/** A point or vector in the local ENU frame, meters. */
export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

/** Where a vehicle is and which way it points at one instant. */
export interface Pose {
  /** Meters east of the scene origin. */
  readonly xM: number;
  /** Meters north of the scene origin. */
  readonly yM: number;
  /** Compass bearing of the vehicle's front, radians (0 = north, clockwise). */
  readonly headingRad: number;
  /** Speed along the ground, m/s. */
  readonly speedMps: number;
}

/** WGS84 position. */
export interface LatLon {
  readonly lat: number;
  readonly lon: number;
}

/** Origin of the local ENU frame for one scene. */
export interface LocalFrame {
  readonly origin: LatLon;
}

/** A low–middle–high result for "not sure" speeds; lo = mid = hi when the speed is known. */
export interface Range {
  readonly lo: number;
  readonly mid: number;
  readonly hi: number;
}
