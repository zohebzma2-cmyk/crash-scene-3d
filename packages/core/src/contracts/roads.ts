// The real road layout around the pin, built from OSM (Overpass) and the
// free Terrarium terrain tiles. Produced by @csd/mapdata, consumed by the
// physics placement, the mini map and the 3D viewer. Meters, local ENU frame.
import type { LocalFrame, Vec2 } from "./geometry";

export type RoadKind =
  | "motorway" | "trunk" | "primary" | "secondary" | "tertiary"
  | "residential" | "unclassified" | "service" | "parking_aisle" | "other";

/** One drivable road after merging duplicate OSM segments that share a name and connect. */
export interface RoadWay {
  /** Stable id within this network (not an OSM id). */
  readonly id: string;
  /** Street name ("Main Street"), or null for unnamed service roads and aisles. */
  readonly name: string | null;
  /** Route number ("US 3"), or null. */
  readonly ref: string | null;
  readonly kind: RoadKind;
  /** One-way in the direction of `centerline` point order. */
  readonly oneway: boolean;
  /** Lanes travelling along the centerline direction. One-way roads put all lanes here. */
  readonly lanesForward: number;
  /** Lanes travelling against the centerline direction (0 for one-way). */
  readonly lanesBackward: number;
  /** Width of one lane, meters (tagged width ÷ lanes, else 3.5). */
  readonly laneWidthM: number;
  /** Polyline in the local frame, meters, at least 2 points. */
  readonly centerline: readonly Vec2[];
  /** Posted limit from the OSM maxspeed tag, mph, when present. Display unit by design: it's what signs say. */
  readonly speedLimitMph: number | null;
  /** OSM way ids merged into this road (for attribution and debugging). */
  readonly osmWayIds: readonly number[];
}

export interface Building {
  readonly id: string;
  /** Closed outline, counter-clockwise, meters. */
  readonly footprint: readonly Vec2[];
  readonly heightM: number;
  readonly heightSource: "height-tag" | "levels-tag" | "default";
}

/** A parking lot outline (amenity=parking). Aisles are RoadWays of kind parking_aisle. */
export interface ParkingArea {
  readonly id: string;
  readonly outline: readonly Vec2[];
}

/** Ground heights from Terrarium tiles, relative to the elevation at the frame origin, meters. */
export interface TerrainGrid {
  /** South-west corner of the grid in the local frame. */
  readonly originM: Vec2;
  readonly cellM: number;
  readonly cols: number;
  readonly rows: number;
  /** Row-major, row 0 at the south edge, length cols × rows. */
  readonly heightsM: readonly number[];
  readonly source: string;
}

export interface RoadNetwork {
  /** Only explicitly tagged OSM objects; absent on older cached networks. */
  readonly features?: readonly RoadFeature[];
  /** Original way tags, kept apart from the lane defaults used by placement. */
  readonly taggedRoads?: readonly TaggedRoad[];
  readonly frame: LocalFrame;
  /** Half-size of the square area fetched around the origin, meters. */
  readonly radiusM: number;
  readonly ways: readonly RoadWay[];
  readonly buildings: readonly Building[];
  readonly parking: readonly ParkingArea[];
  readonly terrain: TerrainGrid | null;
  /** e.g. "© OpenStreetMap contributors (ODbL)". Shown wherever the data is. */
  readonly attribution: readonly string[];
  /** ISO time the source data was fetched (fixtures keep theirs). */
  readonly fetchedAt: string;
}

export type RoadFeatureKind = "signal" | "stop" | "yield" | "crosswalk" | "street-light" | "speed" | "oneway" | "turn-lanes" | "lanes";
export interface RoadFeature {
  readonly id: string;
  readonly kind: RoadFeatureKind;
  readonly position: Vec2;
  /** Compass direction the sign faces; null means OSM did not say. */
  readonly facingDeg: number | null;
  readonly label: string;
  /** Way annotations describe a road, not a surveyed sign/paint location. */
  readonly source: "node" | "way";
  readonly osmId: number;
  /** Explicitly mapped crossing path and markings; absent means no paint is rendered. */
  readonly crossingPath?: readonly Vec2[];
  readonly crossingMarkings?: "yes" | "zebra" | "ladder";
}
export interface TaggedRoad {
  readonly osmId: number;
  readonly centerline: readonly Vec2[];
  readonly lanes: number | null;
  readonly forward: number | null;
  readonly backward: number | null;
  readonly bothWays: number | null;
  readonly oneway: boolean;
  readonly turnsForward: readonly string[];
  readonly turnsBackward: readonly string[];
}

/** One arm of a junction: a road leaving the junction in one direction. */
export interface Leg {
  readonly roadId: string;
  readonly name: string | null;
  /** Compass bearing pointing away from the junction along the road, degrees. */
  readonly outwardBearingDeg: number;
  /** Junction point in the local frame. */
  readonly junction: Vec2;
}

/** What's at the pin: the nearby roads, their legs, and the direction choices offered to the claimant. */
export interface StreetsAtPin {
  readonly pin: Vec2;
  readonly roads: ReadonlyArray<{ readonly roadId: string; readonly name: string | null; readonly distanceM: number }>;
  readonly legs: readonly Leg[];
  /** Road-relative travel choices, e.g. "northbound on Main Street". */
  readonly directions: readonly TravelChoice[];
}

export interface TravelChoice {
  readonly roadId: string;
  readonly roadName: string | null;
  /** Compass bearing of travel along the road at the pin, degrees. */
  readonly bearingDeg: number;
  /** "northbound", "southbound", "eastbound", "westbound" (nearest of the four). */
  readonly bound: "northbound" | "southbound" | "eastbound" | "westbound";
  /**
   * An unnamed road told apart from what we know of it, never a name: its kind, and where it sits among the
   * unnamed roads of that kind at the pin ("the parking aisle (west one)", "the unnamed service road"). Null
   * when the road has a name.
   */
  readonly roadDesc: string | null;
  /** Plain label: "northbound on Main Street", "northbound on the parking aisle (west one)". */
  readonly label: string;
}

/** A lane's center line for one travel direction, in travel order, meters. */
export interface LanePath {
  readonly roadId: string;
  /** 0 = rightmost lane for that direction. */
  readonly laneIndex: number;
  readonly points: readonly Vec2[];
}
