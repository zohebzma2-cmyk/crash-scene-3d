// Map data API. Pure TS: fetching is done by the proxy or injected, so this runs in the
// browser, the server and tests. No DOM, no three.
// Note: streetsAtPin and lanePath are pure geometry on a RoadNetwork and live in @csd/core.
export { isDrivableHighway, overpassAroundQuery, overpassBboxQuery, overpassBboxLiveQuery, overpassBboxRoadsQuery, overpassCrossingQuery, DRIVABLE_HIGHWAYS } from "./queries";
export { splitCrossingQuery, mergeSearchResults } from "./search";
export { crossingPoint, findCrossings, type Crossing } from "./crossing";
export { findCrossStreets, matchCrossStreet, overpassCrossStreetsQuery, refMatches, type StreetSelector } from "./cross";
export { parseOverpass, clipPolyline, OSM_ATTRIBUTION } from "./parse";
export { decodeTerrarium, terrainGrid, terrainTilesFor, TERRAIN_ATTRIBUTION, TERRAIN_ZOOM } from "./terrain";
export { nameMatches, nameMatchScore, normalizeStreetName } from "./names";
export { enuAbout, metersPerDegree, type Enu } from "./enu";
export { isStateText, stateAbbreviation, stateOfText } from "./states";
