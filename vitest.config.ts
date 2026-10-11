import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    // Exact matches: a subpath (@csd/exports/png-meta) resolves through the package's own "exports" map.
    alias: [
      { find: /^@csd\/core$/, replacement: r("./packages/core/src/index.ts") },
      { find: /^@csd\/mapdata$/, replacement: r("./packages/mapdata/src/index.ts") },
      { find: /^@csd\/exports$/, replacement: r("./packages/exports/src/index.ts") },
      { find: /^@csd\/proxy$/, replacement: r("./packages/proxy/src/index.ts") },
    ],
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/web/test/**/*.test.{ts,tsx}", "scripts/test/**/*.test.mjs"],
    environment: "node",
    // Tests never touch live APIs: fixtures come from examples/.
    restoreMocks: true,
  },
});
