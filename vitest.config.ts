import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@csd/core": r("./packages/core/src/index.ts"),
      "@csd/mapdata": r("./packages/mapdata/src/index.ts"),
      "@csd/exports": r("./packages/exports/src/index.ts"),
      "@csd/proxy": r("./packages/proxy/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/web/test/**/*.test.{ts,tsx}", "scripts/test/**/*.test.mjs"],
    environment: "node",
    // Tests never touch live APIs: fixtures come from examples/.
    restoreMocks: true,
  },
});
