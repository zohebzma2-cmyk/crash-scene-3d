// The previews are the real files: the same exports service that Save uses builds the PDF, the
// diagram picture and the scene file, after a short pause in editing, and the Save step shows those bytes.
import { useEffect, useState } from "react";
import { canonicalJson, type ExportBundle, type RoadNetwork, type Scene, type SimulationResult } from "@csd/core";
import { useServices } from "../services/context";
import { mapThumbnail } from "../services/thumbnail";

export const PREVIEW_DEBOUNCE_MS = 500;
export const PREVIEW_FAILED_TEXT = "We couldn't make the preview. You can still try saving.";

export type BundlePreview =
  | { status: "building" }
  | { status: "ready"; bundle: ExportBundle }
  | { status: "error"; message: string };

/** null scene result (nothing to draw) means no preview. */
export function useBundlePreview(scene: Scene, sim: SimulationResult | null, roads: RoadNetwork | null): BundlePreview | null {
  const { exports } = useServices();
  const key = `${canonicalJson(scene)}|${sim?.physicsVersion ?? ""}|${roads?.fetchedAt ?? ""}`;
  const [result, setResult] = useState<{ key: string; value: BundlePreview } | null>(null);

  useEffect(() => {
    if (!sim) return;
    let off = false;
    const timer = window.setTimeout(() => {
      const thumb = mapThumbnail.get(scene.location);
      exports.build({ scene, sim, roads, formats: ["pdf", "png-diagram", "json"], ...(thumb ? { mapThumbnail: thumb } : {}) }).then(
        (bundle) => { if (!off) setResult({ key, value: { status: "ready", bundle } }); },
        (e: unknown) => { if (!off) setResult({ key, value: { status: "error", message: e instanceof Error && e.message ? e.message : PREVIEW_FAILED_TEXT } }); },
      );
    }, PREVIEW_DEBOUNCE_MS);
    return () => { off = true; window.clearTimeout(timer); };
    // `key` stands for scene + simulation + roads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, sim === null, exports]);

  if (!sim) return null;
  return result && result.key === key ? result.value : { status: "building" };
}
