// The fixer benchmark's scenes and roads, loaded the browser way (no node:fs). Mirrors packages/core/test/fixer/bench.ts.
import type { LatLon, RoadNetwork, Scene, Vec2 } from "@csd/core";
import { toLatLon, toLocal } from "@csd/core";
import benchRaw from "../../packages/core/test/data/fixer-bench.jsonl?raw";
import tbone from "../../packages/core/test/data/t-bone-intersection-roads.json";
import highway from "../../packages/core/test/data/highway-rear-end-roads.json";
import parking from "../../packages/core/test/data/parking-lot-backing-roads.json";

type Example = "t-bone-intersection" | "highway-rear-end" | "parking-lot-backing";
type NetRef = Example | "none" | RoadNetwork | { example: Example; around: LatLon };
export interface BenchCase { readonly id: string; readonly src: string; readonly net: NetRef; readonly scene: Scene }

const NETS: Record<Example, RoadNetwork> = { "t-bone-intersection": tbone as unknown as RoadNetwork, "highway-rear-end": highway as unknown as RoadNetwork, "parking-lot-backing": parking as unknown as RoadNetwork };
export const cases: BenchCase[] = benchRaw.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as BenchCase);

const recentred = new Map<string, RoadNetwork>();
export function roadsOf(net: NetRef): RoadNetwork | null {
  if (net === "none") return null;
  if (typeof net === "string") return NETS[net];
  if (!("example" in net)) return net;
  const key = `${net.example}@${net.around.lat},${net.around.lon}`;
  const hit = recentred.get(key);
  if (hit) return hit;
  const src = NETS[net.example], frame = { origin: { lat: net.around.lat, lon: net.around.lon } };
  const move = (p: Vec2): Vec2 => toLocal(frame, toLatLon(src.frame, p));
  const out: RoadNetwork = {
    ...src, frame, terrain: null,
    ways: src.ways.map((w) => ({ ...w, centerline: w.centerline.map(move) })),
    buildings: src.buildings.map((b) => ({ ...b, footprint: b.footprint.map(move) })),
    parking: src.parking.map((l) => ({ ...l, outline: l.outline.map(move) })),
  };
  recentred.set(key, out);
  return out;
}
