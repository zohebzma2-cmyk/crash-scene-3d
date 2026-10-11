// Our own test and measuring traffic must not eat real users' budget on the live site (docs/PROXY-BUSY.md,
// PROGRESS.md hard rules, docs/DEPLOY.md "Our own test traffic").
//
// The proxy's global buckets (vPIC, type-ahead, tiles, terrain) and 1 req/s slots (Nominatim, Overpass) are shared by
// everyone. A run of a hundred specs against the live site spends them all evening. So any spec that opens a page on a
// deployed copy (BASE_URL that isn't this machine) answers the proxy calls it isn't there to check from inside the test:
//
//   /api/vehicles/*   -> the real proxy code with a made-up vPIC, in the test process (e2e/fake-proxy.ts)
//   /api/geo/tile/*   -> a neutral grey PNG (a map view is ~35 tiles; no live spec checks the tile pictures)
//
// Search, crossing, type-ahead, Overpass and terrain stay live by default: the live checks are there to verify them, and
// the 3D picture needs the real roads and ground. A spec that verifies one of the stubbed routes on purpose passes
// `keep` (e2e/live/vehicles.live.spec.ts keeps the vehicles). E2E_LIVE_API=all turns the guard off for a deliberate full live check, which the owner runs by hand.
import type { Page } from "@playwright/test";
import { NO_TILE_PNG } from "../packages/proxy/src/fixture-tiles";
import { routeVehiclesToFakeProxy } from "./fake-proxy";

export type GuardedRoute = "vehicles" | "tiles";

/** True when BASE_URL points at a deployed copy (not localhost). E2E_LIVE_GUARD=1 forces it (to test the guard itself). */
export function isLiveTarget(baseURL = process.env.BASE_URL): boolean {
  if (process.env.E2E_LIVE_GUARD === "1") return true;
  if (!baseURL) return false;
  const host = new URL(baseURL).hostname;
  return !(host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1");
}

/** Answer the non-essential proxy routes inside the test instead of on the live site. Returns what was kept live. */
export async function stubNonEssentialApi(page: Page, opts: { keep?: readonly GuardedRoute[] } = {}): Promise<readonly GuardedRoute[]> {
  if (process.env.E2E_LIVE_API === "all") return ["vehicles", "tiles"];
  const keep = new Set(opts.keep ?? []);
  if (!keep.has("vehicles")) await routeVehiclesToFakeProxy(page);
  if (!keep.has("tiles")) {
    await page.route("**/api/geo/tile/**", (route) => route.fulfill({ status: 200, contentType: "image/png", headers: { "cache-control": "no-store" }, body: Buffer.from(NO_TILE_PNG) }));
  }
  return [...keep];
}
