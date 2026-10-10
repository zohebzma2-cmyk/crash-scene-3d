import { defineConfig, devices } from "@playwright/test";

// The built app in fixture mode: no live map, geocoder or vehicle APIs.
//
// BASE_URL=http://localhost:4190 npx playwright test   -> test a build someone else is already serving
// npx playwright test  (or npm run e2e)                -> build with VITE_FIXTURES=1 and serve it here
//
// E2E_PORT changes the port of the server started here (default 4173, the preview port).
// The server started here is never shared: if the port is taken, Playwright stops instead of
// testing whatever happens to be running there. E2E_REUSE=1 opts back in to reusing it.
const PORT = Number(process.env.E2E_PORT ?? 4173);
const external = process.env.BASE_URL;
const full = process.env.E2E_FULL === "1";
const baseURL = external ?? `http://localhost:${PORT}`;

// Tips for first-time users (DESIGN.md section 19) start hidden in every spec, as the screens looked before they
// existed, through a stored value on the app's origin. e2e/tips.spec.ts clears it to test a real first visit.
const tipsHidden = { cookies: [], origins: [{ origin: new URL(baseURL).origin, localStorage: [{ name: "csd.tips.v1", value: JSON.stringify({ hidden: [], all: true }) }] }] };

// Headless Chromium has no GPU: SwiftShader gives the 3D viewer a real WebGL context.
const launchOptions = { args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] };

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  // SwiftShader WebGL is CPU-heavy; a few workers keep frame times sane.
  workers: process.env.E2E_WORKERS ? Number(process.env.E2E_WORKERS) : 3,
  fullyParallel: true,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: { baseURL, storageState: tipsHidden, trace: "retain-on-failure", screenshot: "only-on-failure", reducedMotion: "reduce", acceptDownloads: true, launchOptions },
  // Chromium runs every spec at 1440 and 390. WebKit runs the cross-browser subset (tests tagged @xb) at the
  // same two widths; E2E_FULL=1 (npm run e2e:full) runs everything on every project.
  projects: [
    {
      name: "desktop",
      testIgnore: /phone\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, launchOptions },
    },
    {
      name: "phone",
      use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 }, launchOptions },
    },
    {
      name: "webkit-desktop",
      testIgnore: /phone\.spec\.ts/,
      ...(full ? {} : { grep: /@xb/ }),
      use: { ...devices["Desktop Safari"], viewport: { width: 1440, height: 900 }, launchOptions: {} },
    },
    {
      name: "webkit-phone",
      ...(full ? {} : { grep: /@xb/ }),
      use: { ...devices["iPhone 15"], viewport: { width: 390, height: 844 }, launchOptions: {} },
    },
  ],
  ...(external
    ? {}
    : {
        webServer: {
          command: `npm run build && cd apps/web && npx --no-install vite preview --port ${PORT} --strictPort`,
          url: baseURL,
          reuseExistingServer: process.env.E2E_REUSE === "1",
          timeout: 240_000,
          env: { VITE_FIXTURES: "1" },
        },
      }),
});
