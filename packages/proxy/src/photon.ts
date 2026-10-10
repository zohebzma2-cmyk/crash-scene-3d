// Photon (komoot, OSM data) results → PlaceResult. Pure; no fetching.
import type { PlaceResult } from "@csd/core";
import { normalizeStreetName } from "@csd/mapdata";

const STATES: Readonly<Record<string, string>> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT",
  delaware: "DE", "district of columbia": "DC", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL",
  indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT",
  nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA",
  "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT",
  vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
};

/** "New Hampshire" → "NH"; anything unknown comes back as given. */
export function stateAbbreviation(state: string): string {
  return STATES[state.trim().toLowerCase()] ?? state.trim();
}

interface PhotonProps {
  osm_id?: number; osm_type?: string; osm_key?: string; osm_value?: string; type?: string;
  name?: string; street?: string; housenumber?: string; postcode?: string;
  city?: string; district?: string; locality?: string; county?: string; state?: string; countrycode?: string;
}
interface PhotonFeature { geometry?: { coordinates?: unknown[] }; properties?: PhotonProps }

const MAX_WAY_IDS = 20;
/** Highway values that are not streets a vehicle is on: paths, footways, bus stops and the like. */
const NOT_A_ROAD = new Set(["footway", "cycleway", "path", "steps", "pedestrian", "bridleway", "corridor", "platform", "bus_stop", "crossing", "traffic_signals", "elevator", "proposed", "construction", "raceway"]);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

/** "Town, ST" for a place: the town, else the county, else just the state. Always carries the state when Photon has it. */
function townLine(town: string | undefined, county: string | undefined, state: string | undefined): string {
  const st = state ? stateAbbreviation(state) : undefined;
  return [town ?? county, st].filter(Boolean).join(", ");
}

/**
 * Turn a Photon FeatureCollection into PlaceResults: US only, one entry per street per town (a
 * street OSM splits into many ways comes back once, with all its way ids), "Town, ST" on every
 * entry. `null` means the body wasn't a Photon response.
 */
export function photonToPlaces(body: unknown, limit: number): PlaceResult[] | null {
  const features = (body as { features?: unknown } | null)?.features;
  if (!Array.isArray(features)) return null;
  const out: PlaceResult[] = [];
  const streets = new Map<string, number>(); // merge key → index in out
  for (const f of features as PhotonFeature[]) {
    const p = f.properties ?? {};
    const [lon, lat] = (f.geometry?.coordinates ?? []) as unknown[];
    if (typeof lat !== "number" || typeof lon !== "number" || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if ((p.countrycode ?? "").toUpperCase() !== "US") continue;

    // Bus stops, crossings and other single points tagged highway=* or public_transport=* are not places to pick.
    if ((p.osm_key === "highway" && p.osm_type === "N") || p.osm_key === "public_transport") continue;
    const housenumber = str(p.housenumber);
    const name = str(p.name);
    if (p.type === "street" && NOT_A_ROAD.has(p.osm_value ?? "")) continue; // footpaths and cycleways
    const isStreet = !housenumber && p.type === "street" && name !== undefined;
    const cityType = p.type === "city" || p.type === "locality" || p.type === "district" || p.type === "county" || p.type === "state";
    const town = str(p.city) ?? str(p.district) ?? str(p.locality) ?? (cityType && p.type !== "county" && p.type !== "state" ? name : undefined);
    const county = str(p.county);
    const state = str(p.state);
    const sub = townLine(town, county, state);
    const stAbbr = state ? stateAbbreviation(state) : undefined;
    const postcode = str(p.postcode);
    const kind = (str(p.osm_value) ?? str(p.type) ?? "").replace(/_/g, " ");
    const extra = {
      ...(town ? { town } : {}), ...(county ? { county } : {}), ...(stAbbr ? { state: stAbbr } : {}), ...(postcode ? { postcode } : {}),
    };

    if (isStreet) {
      const key = `${normalizeStreetName(name)}|${(town ?? county ?? "").toLowerCase()}|${stAbbr ?? ""}`;
      const at = streets.get(key);
      const wayId = p.osm_type === "W" && typeof p.osm_id === "number" ? p.osm_id : undefined;
      if (at !== undefined) {
        const prev = out[at] as PlaceResult;
        if (wayId !== undefined && !(prev.osmWayIds ?? []).includes(wayId) && (prev.osmWayIds ?? []).length < MAX_WAY_IDS) {
          out[at] = { ...prev, osmWayIds: [...(prev.osmWayIds ?? []), wayId] };
        }
        continue;
      }
      streets.set(key, out.length);
      out.push({
        label: [name, sub].filter(Boolean).join(", "), main: name, sub, lat, lon, kind: kind || "street",
        category: "street", street: name, ...extra, ...(wayId !== undefined ? { osmWayIds: [wayId] } : {}),
      });
    } else if (housenumber) {
      const street = str(p.street) ?? name;
      const main = [housenumber, street].filter(Boolean).join(" ");
      out.push({
        label: [main, sub, postcode].filter(Boolean).join(", "), main, sub, lat, lon, kind: kind || "house",
        category: "address", ...(street ? { street } : {}), ...extra,
      });
    } else if (name) {
      out.push({
        label: town === name ? sub : [name, sub].filter(Boolean).join(", "), main: name, sub, lat, lon, kind: kind || "place",
        category: "place", ...extra,
      });
    }
    if (out.length >= limit * 2) break; // plenty to merge and cut
  }
  return out.slice(0, limit);
}
