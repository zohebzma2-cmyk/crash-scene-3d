import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { normalize, join, sep } from "node:path";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const EXAMPLES = r("../../examples");

/** Dev/preview: serve the cached examples (fixture mode, viewer harness). Read-only, path-checked. */
function examples(): Plugin {
  const handler = async (req: { url?: string }, res: { statusCode: number; setHeader(k: string, v: string): void; end(b?: unknown): void }, next: () => void) => {
    if (!req.url?.startsWith("/examples/")) return next();
    const rel = decodeURIComponent(req.url.split("?")[0]!.slice("/examples/".length));
    const file = normalize(join(EXAMPLES, rel));
    if (!file.startsWith(EXAMPLES + sep)) { res.statusCode = 403; return res.end(); }
    try {
      const body = await readFile(file);
      res.setHeader("Content-Type", file.endsWith(".json") ? "application/json" : file.endsWith(".png") ? "image/png" : "application/octet-stream");
      res.end(body);
    } catch { res.statusCode = 404; res.end(); }
  };
  return { name: "examples", configureServer: (s) => { s.middlewares.use(handler as never); }, configurePreviewServer: (s) => { s.middlewares.use(handler as never); } };
}

// Source maps are for development and for the e2e (fixtures) build only. A production build publishes
// no .map files: they expose the source and add several MB to the deploy.
export default defineConfig(({ mode }) => ({
  plugins: [react(), examples()],
  resolve: {
    alias: {
      "@csd/core": r("../../packages/core/src/index.ts"),
      "@csd/mapdata": r("../../packages/mapdata/src/index.ts"),
      "@csd/exports": r("../../packages/exports/src/index.ts"),
    },
  },
  server: { fs: { allow: ["../.."] } },
  build: { sourcemap: mode === "development" || process.env.VITE_FIXTURES === "1", target: "es2022" },
  // Same strict CSP as netlify.toml, so preview and e2e run under production rules.
  // (Dev mode needs Vite's inline HMR preamble, so CSP is enforced on preview/production only.)
  preview: { headers: {
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  } },
}));
