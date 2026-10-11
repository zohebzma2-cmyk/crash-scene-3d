#!/usr/bin/env node
// The fixer benchmark in real browsers (docs/FIXER-BENCHMARK.md): every benchmark scene through the old fixer (v1) and the
// new one, on the main thread and in a module Web Worker, in Chromium and WebKit (Playwright). Serves a small harness with
// Vite on port 4391 (E2E_PORT to change), only on localhost; nothing leaves the machine.
//
//   node scripts/fixer-bench-browser.mjs [--browsers chromium,webkit] [--runs v1:main,v2:main,v2:worker]
import { createServer } from "vite";
import { chromium, webkit } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { ensureV1 } from "./fixer-v1.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : dflt; };
const browsers = arg("--browsers", "chromium,webkit").split(",");
const runs = arg("--runs", "v1:main,v2:main,v2:worker").split(",").map((r) => r.split(":"));
const port = Number(process.env.E2E_PORT ?? 4391);

const server = await createServer({
  configFile: false, logLevel: "error", root: `${root}scripts/fixer-bench-browser`,
  resolve: { alias: { "@csd/core": `${root}packages/core/src/index.ts`, "@fixer-v1": ensureV1() } },
  server: { port, strictPort: true, host: "127.0.0.1", fs: { allow: [root] } },
  worker: { format: "es" },
});
await server.listen();
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };
const fmt = (x) => `${x.toFixed(0)} ms`;
try {
  console.log("| Browser | Fixer | Where | Offered a fix | Median | p95 | Worst search | Longest main-thread task |");
  console.log("|---|---|---|---:|---:|---:|---:|---:|");
  for (const name of browsers) {
    const browser = await (name === "webkit" ? webkit : chromium).launch();
    for (const [which, mode] of runs) {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${port}/?which=${which}&mode=${mode}`);
      await page.waitForFunction(() => "__bench" in window, null, { timeout: 1_800_000, polling: 1000 });
      const b = await page.evaluate(() => window.__bench);
      const ms = b.results.map((r) => r.ms);
      const fixed = b.results.filter((r) => r.fixes > 0).length;
      const longest = b.longestTaskMs ? fmt(b.longestTaskMs) : "not measured";
      console.log(`| ${name} | ${which === "v1" ? "before (v1)" : "after"} | ${mode === "main" ? "main thread" : "Web Worker"} | ${fixed} of ${ms.length} | ${fmt(q(ms, 0.5))} | ${fmt(q(ms, 0.95))} | ${fmt(Math.max(...ms))} | ${longest} |`);
      await page.close();
    }
    await browser.close();
  }
} finally {
  await server.close();
}
