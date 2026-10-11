// The one-tap fixer's search, off the main thread (DESIGN.md section 18): the page stays responsive while the physics
// tries small changes. A module Web Worker served from the page's own origin (CSP worker-src 'self'); it makes no
// network requests and keeps nothing after the tab closes. One request at a time; the page terminates it to cancel.
import { suggestFixes, type RoadNetwork } from "@csd/core";
import type { FixRequest, FixResponse } from "./protocol";

const scope = self as unknown as { onmessage: ((e: MessageEvent<FixRequest>) => void) | null; postMessage(m: FixResponse): void };

/** The last road data the page sent, by its key, so the same roads aren't copied over for every request. */
let held: { key: number; net: RoadNetwork } | null = null;

scope.onmessage = (e) => {
  const req = e.data;
  let reply: FixResponse;
  try {
    if (req.roads && req.roadsKey !== null) held = { key: req.roadsKey, net: req.roads };
    const roads = req.roadsKey === null ? null : held && held.key === req.roadsKey ? held.net : req.roads;
    if (req.roadsKey !== null && !roads) throw new Error("road data missing");
    reply = { id: req.id, ok: true, result: suggestFixes(req.scene, roads, { prefer: req.prefer, gate: req.gate === true }) };
  } catch (err) {
    reply = { id: req.id, ok: false, message: err instanceof Error ? err.message : "failed" };
  }
  scope.postMessage(reply);
};
