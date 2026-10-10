import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { jsonResponse, type Call, type Upstream } from "./helpers";

// A "cassette" is one real exchange recorded through the proxy: the request, the proxy's answer, and every
// upstream call behind it (Photon, Nominatim, Overpass) with the real response text. See fixtures/cassettes/ATTRIBUTION.md.
export interface Cassette {
  readonly request: string;
  readonly response: { readonly status: number; readonly body: string };
  readonly upstream: ReadonlyArray<{ method: string; url: string; body?: string; status: number; text: string }>;
}

const dir = fileURLToPath(new URL("./fixtures/cassettes/", import.meta.url));
export const cassetteNames = (): string[] => readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();
export const loadCassette = (name: string): Cassette => JSON.parse(readFileSync(`${dir}${name}.json`, "utf8")) as Cassette;

/** What the proxy sent for one upstream call, in the form the recording used. */
function keyOf(call: Call): string {
  if (call.method === "GET") return `GET ${call.url}`;
  return `${call.method} ${decodeURIComponent((call.body ?? "").replace(/\+/g, " "))}`;
}

/**
 * A fake upstream that answers exactly what was recorded, and notes any call that was not recorded
 * (answered 500) and which recorded calls were used. Overpass mirrors are told apart by their query, not their host.
 */
export function replay(c: Cassette) {
  const byKey = new Map(c.upstream.map((u, i) => [u.method === "GET" ? `GET ${u.url}` : `${u.method} ${u.body ?? ""}`, i] as const));
  const used = new Set<number>();
  const unrecorded: string[] = [];
  const upstream: Upstream = (call) => {
    const i = byKey.get(keyOf(call));
    if (i === undefined) {
      unrecorded.push(keyOf(call).slice(0, 300));
      return new Response("no recording", { status: 500 });
    }
    used.add(i);
    const u = c.upstream[i]!;
    return u.status === 200 ? jsonResponse(JSON.parse(u.text)) : new Response(u.text, { status: u.status });
  };
  return { upstream, used, unrecorded };
}

/** The OSM nodes (id → coordinates) of the ways with these names in a recorded Overpass response. */
export function recordedNodes(c: Cassette, names: readonly string[]): Map<string, Map<number, { lat: number; lon: number }>> {
  const out = new Map<string, Map<number, { lat: number; lon: number }>>();
  for (const u of c.upstream) {
    if (!u.url.includes("overpass")) continue;
    const j = JSON.parse(u.text) as { elements: { nodes: number[]; geometry: { lat: number; lon: number }[]; tags: { name?: string } }[] };
    for (const w of j.elements) {
      const name = w.tags?.name;
      if (!name || !names.includes(name)) continue;
      const m = out.get(name) ?? new Map();
      w.nodes.forEach((n, i) => m.set(n, w.geometry[i]!));
      out.set(name, m);
    }
  }
  return out;
}
