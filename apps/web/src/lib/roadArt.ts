// The road art (ribbons, paint, junctions) is the heaviest CPU step before the first 3D frame. buildRoadArt
// keeps one result per road network, so Review builds it while the 3D code is still downloading and the
// 3D world then finds it ready instead of building it inside its first render.
import { buildRoadArt, type RoadNetwork } from "@csd/core";

/** Builds the art in the next idle moment (or soon after). Returns a cancel. */
export function prepareRoadArt(net: RoadNetwork | null): () => void {
  if (!net) return () => undefined;
  const run = () => { buildRoadArt(net); };
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(run, { timeout: 200 });
    return () => cancelIdleCallback(id);
  }
  const id = window.setTimeout(run, 0);
  return () => window.clearTimeout(id);
}
