// The three example scenes (examples/*/scene.json). Available in every build, so /?example=<name>
// works in production too, but only the scene file is bundled, and each one is loaded lazily only
// when asked for. The cached map data (osm.json, terrain) is a fixtures-build-only matter: see fixtures.ts.
import { parseScene, type Scene } from "@csd/core";
import type { ExamplesService } from "./types";

const sceneModules = import.meta.glob("../../../../examples/*/scene.json", { import: "default" }) as Record<string, () => Promise<unknown>>;

export const exampleName = (path: string): string => /examples\/([^/]+)\//.exec(path)?.[1] ?? "";

const NAMES = Object.keys(sceneModules).map(exampleName).filter(Boolean).sort();

export function createExamplesService(): ExamplesService {
  return {
    names: () => NAMES,
    async load(name) {
      const key = Object.keys(sceneModules).find((k) => exampleName(k) === name);
      const loader = key ? sceneModules[key] : undefined;
      if (!loader) return null;
      const parsed = parseScene(await loader());
      return parsed.ok ? parsed.value : null;
    },
  };
}

/** Every example scene (fixtures mode searches over them). */
export async function loadAllExamples(): Promise<Map<string, Scene>> {
  const svc = createExamplesService();
  const out = new Map<string, Scene>();
  for (const name of svc.names()) {
    const s = await svc.load(name);
    if (s) out.set(name, s);
  }
  return out;
}
