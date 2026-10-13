// OSM observations, deliberately separate from the geometry defaults used by physics.
import type { LocalFrame, RoadFeature, RoadFeatureKind, TaggedRoad, Vec2 } from "@csd/core";
import { enuAbout } from "./enu";
import { osmWays } from "./osm";
import { isDrivableHighway } from "./queries";

const count = (v: string | undefined): number | null => v && /^(?:[1-9]|1\d|20)$/.test(v) ? Number(v) : null;
const turns = (v: string | undefined): string[] => v && v.length <= 300 ? v.split("|") : [];
const bearing = (a: Vec2, b: Vec2): number => (Math.atan2(b.x - a.x, b.y - a.y) * 180 / Math.PI + 360) % 360;

/** Halfway along actual geometry, not the average of vertices. */
export function featureAnchor(points: readonly Vec2[]): { position: Vec2; bearingDeg: number } | null {
  const lengths = points.slice(1).map((p, i) => Math.hypot(p.x - points[i]!.x, p.y - points[i]!.y));
  let remaining = lengths.reduce((a, b) => a + b, 0) / 2;
  for (let i = 0; i < lengths.length; i++) {
    const length = lengths[i]!;
    if (length > 0 && remaining <= length) {
      const a = points[i]!, b = points[i + 1]!;
      return { position: { x: a.x + (b.x - a.x) * remaining / length, y: a.y + (b.y - a.y) * remaining / length }, bearingDeg: bearing(a, b) };
    }
    remaining -= length;
  }
  return null;
}

export function parseFeatures(json: unknown, frame: LocalFrame, radiusM: number): { features: RoadFeature[]; taggedRoads: TaggedRoad[] } {
  const enu = enuAbout(frame.origin);
  const features: RoadFeature[] = [], taggedRoads: TaggedRoad[] = [];
  const ways = osmWays(json);
  const inside = (p: Vec2) => Number.isFinite(p.x) && Number.isFinite(p.y) && Math.abs(p.x) <= radiusM && Math.abs(p.y) <= radiusM;
  for (const w of ways) {
    if (w.tags.footway === "crossing") {
      const path = w.geometry.map((p) => enu.toLocal(p));
      const anchor = featureAnchor(path);
      const marking = w.tags["crossing:markings"];
      const crossingMarkings = marking === "yes" || marking === "zebra" || marking === "ladder" ? marking : undefined;
      if (anchor && inside(anchor.position)) features.push({ id: `way-${w.id}-crosswalk`, kind: "crosswalk", position: anchor.position, facingDeg: anchor.bearingDeg, label: marking === "no" || w.tags.crossing === "unmarked" ? "Crossing (unmarked)" : "Crosswalk", source: "way", osmId: w.id, ...(crossingMarkings ? { crossingPath: path, crossingMarkings } : {}) });
    }
    if (!isDrivableHighway(w.tags.highway)) continue;
    const reverse = w.tags.oneway === "-1" || w.tags.oneway === "reverse";
    const oneway = reverse || /^(yes|1|true)$/.test(w.tags.oneway ?? "");
    const centerline = w.geometry.map((p) => enu.toLocal(p));
    if (reverse) centerline.reverse();
    const lanes = count(w.tags.lanes);
    const forward = count(w.tags["lanes:forward"]), backward = count(w.tags["lanes:backward"]);
    const t: TaggedRoad = { osmId: w.id, centerline, lanes, forward: reverse ? backward : forward, backward: reverse ? forward : backward, bothWays: count(w.tags["lanes:both_ways"]), oneway,
      turnsForward: turns(w.tags[reverse ? "turn:lanes:backward" : "turn:lanes:forward"] ?? (oneway ? w.tags["turn:lanes"] : undefined)),
      turnsBackward: turns(w.tags[reverse ? "turn:lanes:forward" : "turn:lanes:backward"]) };
    taggedRoads.push(t);
    const anchor = featureAnchor(centerline);
    if (!anchor || !inside(anchor.position)) continue;
    const add = (kind: RoadFeatureKind, label: string, facingDeg: number | null = null) => features.push({ id: `way-${w.id}-${kind}`, kind, position: anchor.position, facingDeg, label, source: "way", osmId: w.id });
    if (oneway) add("oneway", "One way", anchor.bearingDeg);
    if (lanes !== null) add("lanes", `${lanes} lanes total`);
    else if (forward !== null || backward !== null) add("lanes", `Lanes: forward ${forward ?? "not tagged"}, backward ${backward ?? "not tagged"}`);
    const turnTags = ["turn:lanes", "turn:lanes:forward", "turn:lanes:backward", "turn:lanes:both_ways"].filter((key) => w.tags[key]);
    if (turnTags.length) add("turn-lanes", turnTags.map((key) => `${key.replace("turn:lanes", "Turns")}: ${w.tags[key]!.slice(0, 300)}`).join("; "), anchor.bearingDeg);
    const speed = w.tags.maxspeed;
    if (speed && /^\d+(?:\.\d+)?(?: mph| km\/h)?$/.test(speed)) add("speed", `Limit ${speed}${/^\d/.test(speed) && !/\s/.test(speed) ? " km/h" : ""} (road tag; sign position unknown)`);
  }
  const elements = (json as { elements: unknown[] }).elements;
  for (const raw of elements) {
    if (!raw || typeof raw !== "object") continue;
    const n = raw as { type?: string; id?: number; lat?: number; lon?: number; tags?: Record<string, string> };
    if (n.type !== "node" || !Number.isSafeInteger(n.id) || typeof n.lat !== "number" || typeof n.lon !== "number" || Math.abs(n.lat) > 90 || Math.abs(n.lon) > 180) continue;
    const position = enu.toLocal({ lat: n.lat, lon: n.lon });
    if (!inside(position)) continue;
    const tags = n.tags ?? {};
    const kinds: Record<string, RoadFeatureKind> = { traffic_signals: "signal", stop: "stop", give_way: "yield", crossing: "crosswalk", street_lamp: "street-light" };
    const sign = typeof tags.traffic_sign === "string" ? tags.traffic_sign : "";
    const kind = (Object.hasOwn(kinds, tags.highway ?? "") ? kinds[tags.highway!] : undefined) ?? (/^(maxspeed|US:R2-1)$/.test(sign) && typeof tags.maxspeed === "string" && /^\d+(?:\.\d+)?(?: mph| km\/h)?$/.test(tags.maxspeed) ? "speed" : undefined);
    if (!kind) continue;
    let facingDeg: number | null = null;
    const direction = tags["traffic_signals:direction"] ?? tags["traffic_sign:direction"] ?? tags.direction;
    if (typeof direction === "string" && /^\d+(?:\.\d+)?$/.test(direction) && Number(direction) <= 360) facingDeg = Number(direction) % 360;
    if (direction === "forward" || direction === "backward") {
      const connected = ways.filter((w) => isDrivableHighway(w.tags.highway) && w.nodes.includes(n.id!));
      if (connected.length === 1) {
        const w = connected[0]!, i = w.nodes.indexOf(n.id!);
        const a = w.geometry[Math.max(0, i - 1)], b = w.geometry[Math.min(w.geometry.length - 1, i + 1)];
        if (a && b) facingDeg = (bearing(enu.toLocal(a), enu.toLocal(b)) + (direction === "forward" ? 180 : 0)) % 360;
      }
    }
    const label = kind === "speed" ? `Limit ${String(tags.maxspeed).slice(0, 40)}` : ({ signal: "Traffic signal", stop: "Stop", yield: "Yield", crosswalk: "Crosswalk", "street-light": "Street light" } as Record<string, string>)[kind]!;
    features.push({ id: `node-${n.id}`, kind, position, facingDeg, label, source: "node", osmId: n.id! });
  }
  return { features, taggedRoads };
}
