// What starts loading before React renders anything. An example link (/?example=<name>) opens straight on
// Review, so its scene file, its roads and terrain, and the 3D code all start at once, in parallel, instead of
// one after another as the screens ask for them. The Roads provider and the viewer pick up these same loads.
// Any other link starts the code of the step it opens on.
import { hasWebGL, loadViewer } from "./viewer/load-viewer";
import { preloadStep } from "./steps";
import type { Services } from "./services/types";

export function bootPreload(services: Services, search: string, hash: string): void {
  const example = new URLSearchParams(search).get("example");
  if (!example) { preloadStep(hash.replace(/^#/, "") || "location"); return; }
  if (hasWebGL()) void loadViewer().catch(() => undefined);
  // Failures are reported by the screens that wait on these (with Retry); here they are only started.
  services.examples.load(example).then((scene) => {
    if (scene) services.roads.load(scene.location).catch(() => undefined);
  }, () => undefined);
}
