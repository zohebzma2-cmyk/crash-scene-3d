// Hand-built RoadNetworks for the physics tests. No live data, no @csd/mapdata.
// Local frame: x = east, y = north, meters. Centerline point order is the
// "forward" direction of the way. Every network's frame origin is ORIGIN, so a
// scene located at ORIGIN has its pin at (0, 0).
import type { Building, LatLon, LocalFrame, ParkingArea, RoadNetwork, RoadWay, Vec2 } from "../src";

export const ORIGIN: LatLon = { lat: 42.7627, lon: -71.4661 };
export const FRAME: LocalFrame = { origin: ORIGIN };
export const LANE_W_M = 3.5;
export const HWY_LANE_W_M = 3.7;
export const AISLE_LANE_W_M = 3.0;
/** The highway centerline sits 10 m west of the pin, so a pin at (0, 0) is not on it. */
export const HWY_X_M = -10;

const ATTRIBUTION = ["© OpenStreetMap contributors (ODbL)"];

export function makeWay(w: Partial<RoadWay> & Pick<RoadWay, "id" | "centerline">): RoadWay {
  return {
    name: null, ref: null, kind: "residential", oneway: false, lanesForward: 1, lanesBackward: 1,
    laneWidthM: LANE_W_M, speedLimitMph: null, osmWayIds: [], ...w,
  };
}

/** Axis-aligned rectangle, counter-clockwise. */
export function rect(x0: number, y0: number, x1: number, y1: number): Vec2[] {
  return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
}

export function makeBuilding(id: string, footprint: Vec2[]): Building {
  return { id, footprint, heightM: 8, heightSource: "default" };
}

function network(ways: RoadWay[], buildings: Building[], parking: ParkingArea[] = [], radiusM = 250): RoadNetwork {
  return { frame: FRAME, radiusM, ways, buildings, parking, terrain: null, attribution: ATTRIBUTION, fetchedAt: "2026-10-09T12:00:00Z" };
}

const pt = (x: number, y: number): Vec2 => ({ x, y });

export interface IntersectionOptions {
  /** Lanes per direction on Main Street (north–south). Default 1. */
  readonly mainLanes?: number;
  /** Lanes per direction on Park Street (east–west), or in its one direction when one-way. Default 1. */
  readonly parkLanes?: number;
  /** Park Street one-way westbound (centerline runs east to west). */
  readonly parkOneWay?: boolean;
  /** Main Street as two separate named ways meeting at the junction (duplicate-segment case). */
  readonly splitMain?: boolean;
  /** Four set-back corner buildings (default true). */
  readonly corners?: boolean;
  readonly extraBuildings?: readonly Building[];
}

/**
 * A 4-way intersection with its junction node at (0, 0).
 * Main Street runs north–south (centerline points south to north), Park Street
 * east–west (west to east, or east to west when one-way). Hill Road is a
 * separate north–south road 60 m east that never meets them.
 */
export function intersectionNet(o: IntersectionOptions = {}): RoadNetwork {
  const mainLanes = o.mainLanes ?? 1;
  const parkLanes = o.parkLanes ?? 1;
  const main = (id: string, line: Vec2[]) => makeWay({
    id, name: "Main Street", kind: "secondary", lanesForward: mainLanes, lanesBackward: mainLanes, speedLimitMph: 30, centerline: line, osmWayIds: [1001],
  });
  const ways: RoadWay[] = o.splitMain
    ? [main("main-s", [pt(0, -150), pt(0, 0)]), main("main-n", [pt(0, 0), pt(0, 150)])]
    : [main("main", [pt(-0, -150), pt(0, 0), pt(0, 150)])];
  ways.push(o.parkOneWay
    ? makeWay({ id: "park", name: "Park Street", kind: "residential", oneway: true, lanesForward: parkLanes, lanesBackward: 0, speedLimitMph: 25, centerline: [pt(150, 0), pt(0, 0), pt(-150, 0)], osmWayIds: [1002] })
    : makeWay({ id: "park", name: "Park Street", kind: "residential", lanesForward: parkLanes, lanesBackward: parkLanes, speedLimitMph: 25, centerline: [pt(-150, 0), pt(0, 0), pt(150, 0)], osmWayIds: [1002] }));
  ways.push(makeWay({ id: "hill", name: "Hill Road", kind: "residential", centerline: [pt(60, 20), pt(60, 150)], osmWayIds: [1003] }));
  const buildings: Building[] = [];
  if (o.corners !== false) {
    buildings.push(
      makeBuilding("ne", rect(15, 15, 45, 45)), makeBuilding("nw", rect(-45, 15, -15, 45)),
      makeBuilding("sw", rect(-45, -45, -15, -15)), makeBuilding("se", rect(15, -45, 45, -15)),
    );
  }
  buildings.push(...(o.extraBuildings ?? []));
  return network(ways, buildings);
}

/** Straight one-way northbound highway, 3 lanes, centerline x = HWY_X_M. Lane 1 (middle) is on the centerline. */
export function highwayNet(): RoadNetwork {
  return network([
    makeWay({
      id: "hwy", name: "Everett Turnpike", ref: "US 3", kind: "trunk", oneway: true, lanesForward: 3, lanesBackward: 0,
      laneWidthM: HWY_LANE_W_M, speedLimitMph: 55, centerline: [pt(HWY_X_M, -500), pt(HWY_X_M, 500)], osmWayIds: [2001],
    }),
  ], [makeBuilding("depot", rect(60, 0, 100, 50))]);
}

/** A parking lot: one two-way aisle running west to east at y = 0, the lot outline, and stores north and south. */
export function parkingLotNet(): RoadNetwork {
  return network([
    makeWay({
      id: "aisle", name: null, kind: "parking_aisle", lanesForward: 1, lanesBackward: 1, laneWidthM: AISLE_LANE_W_M,
      centerline: [pt(-60, 0), pt(60, 0)], osmWayIds: [3001],
    }),
  ], [makeBuilding("store-n", rect(-60, 32, 60, 60)), makeBuilding("store-s", rect(-60, -60, 60, -32))],
  [{ id: "lot", outline: rect(-60, -25, 60, 25) }]);
}

/**
 * Main Street (straight, north–south) and a bent "Arch Road" that crosses Main's northbound lane TWICE:
 * eastbound along y = -40, round the end at x = 100, back westbound along y = +40. Its point order runs
 * overall northbound, so the road is two-way with forward lanes on the right of that order.
 * Lane paths cross at (1.75, -41.75) [eastbound leg, right lane is south] and (1.75, +41.75) [westbound leg].
 */
export function archNet(): RoadNetwork {
  return network([
    makeWay({ id: "main", name: "Main Street", lanesForward: 1, lanesBackward: 1, centerline: [pt(0, -150), pt(0, 150)] }),
    makeWay({ id: "arch", name: "Arch Road", lanesForward: 1, lanesBackward: 1, centerline: [pt(-100, -40), pt(100, -40), pt(100, 40), pt(-100, 40)] }),
  ], []);
}

/**
 * Main Street as two pieces that differ in lanes, split at (0, -20): the south piece has 2 lanes each way,
 * the north piece 3. A cross street (Park) meets the north piece at (0, 0). Used for lane tapers.
 */
export function splitMainNet(): RoadNetwork {
  return network([
    makeWay({ id: "main-s", name: "Main Street", lanesForward: 2, lanesBackward: 2, centerline: [pt(0, -250), pt(0, -20)] }),
    makeWay({ id: "main-m", name: "Main Street", lanesForward: 3, lanesBackward: 3, centerline: [pt(0, -20), pt(0, 0), pt(0, 250)] }),
    makeWay({ id: "park", name: "Park Street", lanesForward: 1, lanesBackward: 1, centerline: [pt(-150, 0), pt(0, 0), pt(150, 0)] }),
  ], []);
}

/**
 * Oak Street as pieces meeting at (0, 0): two arrive (U1 straight from the south, U2 from the west)
 * and two leave (D straight north, E to the east). Every pair is a fork; the straightest one must be chosen.
 */
export function forkNet(): RoadNetwork {
  const oak = (id: string, centerline: Vec2[]) => makeWay({ id, name: "Oak Street", lanesForward: 1, lanesBackward: 1, centerline });
  return network([
    oak("U1", [pt(0, -100), pt(0, 0)]), oak("U2", [pt(-100, -10), pt(0, 0)]),
    oak("D", [pt(0, 0), pt(0, 100)]), oak("E", [pt(0, 0), pt(100, 10)]),
  ], []);
}

/** Meters to the right of the travel direction's centerline for lane `i` of a two-way road with `lanes` per direction (0 = rightmost = farthest from the line). */
export const twoWayLaneOffsetM = (lanes: number, laneWidthM: number, i: number): number => (lanes - 0.5 - i) * laneWidthM;

/** Lane-geometry lab: asymmetric lanes, a diagonal road, and an east–west road. All straight. */
export function lanesLabNet(): RoadNetwork {
  return network([
    makeWay({ id: "elm", name: "Elm Street", lanesForward: 2, lanesBackward: 1, laneWidthM: 3.2, centerline: [pt(0, -100), pt(0, 100)] }),
    makeWay({ id: "diag", name: "Diagonal Avenue", lanesForward: 1, lanesBackward: 1, laneWidthM: 3.5, centerline: [pt(200, 0), pt(300, 100)] }),
    makeWay({ id: "ew", name: "Oak Street", lanesForward: 1, lanesBackward: 1, laneWidthM: 3.5, centerline: [pt(-100, -300), pt(100, -300)] }),
  ], []);
}
