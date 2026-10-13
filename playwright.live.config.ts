import { defineConfig, devices } from "@playwright/test";

// Live-mode checks against a REAL deployment (real proxy, real Photon / Overpass / Nominatim): e2e/live/*.live.spec.ts.
// Not part of `npm run e2e` or check.sh (playwright.config.ts ignores e2e/live), and nothing is started here.
//
//   BASE_URL=https://crash-scene-3d.netlify.app npm run e2e:live
//   BASE_URL=http://localhost:8851 npm run e2e:live     (netlify dev, see docs/DEPLOY.md)
//
// One worker, one browser, one width: the specs make a handful of real requests each, from one IP (one proxy
// user), and must not trip the per-user limits by running side by side.
const baseURL = process.env.BASE_URL;
if (!baseURL) throw new Error("BASE_URL is required for live-mode e2e, e.g. BASE_URL=http://localhost:8851 npm run e2e:live");

// Tips hidden and the first-visit welcome seen (DESIGN.md section 19): a live build has no fixtures mode to keep the welcome away.
const tipsHidden = { cookies: [], origins: [{ origin: new URL(baseURL).origin, localStorage: [{ name: "csd.tips.v1", value: JSON.stringify({ hidden: [], all: true }) }, { name: "csd.welcome.v1", value: JSON.stringify({ seen: true }) }] }] };

export default defineConfig({
  testDir: "e2e/live",
  testMatch: /\.live\.spec\.ts$/,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  outputDir: "test-results/live",
  use: { baseURL, storageState: tipsHidden, trace: "retain-on-failure", screenshot: "only-on-failure", reducedMotion: "reduce" },
  projects: [{ name: "live-desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
});
