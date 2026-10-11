// A fake /api/vehicles for e2e: the REAL proxy code (createProxy with defaultProviderConfig, so the real
// limits, cache and messages) running in the test process, with a made-up vPIC behind it. Playwright routes the
// page's /api/vehicles/* requests to it. Nothing leaves the machine.
import type { Page } from "@playwright/test";
import { createProxy, defaultProviderConfig, memoryStore } from "../packages/proxy/src/index";

/** Made-up vPIC lists (public make and model names only). */
const MAKES = ["CHEVROLET", "FORD", "HONDA", "TOYOTA"];
const MODELS: Record<string, Partial<Record<"car" | "mpv" | "truck" | "motorcycle", string[]>>> = {
  chevrolet: { car: ["Malibu"], mpv: ["Equinox"], truck: ["Silverado 1500", "Colorado"] },
  ford: { car: ["Fusion"], mpv: ["Escape"], truck: ["F-150"] },
  honda: { car: ["Accord", "Civic"], mpv: ["CR-V", "Odyssey"] },
  toyota: { car: ["Camry"], mpv: ["RAV4"], truck: ["Tacoma"] },
};
const TYPE_NAME = { car: "Passenger Car", mpv: "Multipurpose Passenger Vehicle (MPV)", truck: "Truck", motorcycle: "Motorcycle" } as const;

function fakeVpic(latencyMs: number): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL) => {
    await new Promise((r) => setTimeout(r, latencyMs));
    const url = new URL(String(input));
    const body = (results: unknown[]) => new Response(JSON.stringify({ Results: results }), { status: 200, headers: { "content-type": "application/json" } });
    if (url.pathname.includes("/GetMakesForVehicleType/")) return body(MAKES.map((MakeName) => ({ MakeName })));
    const m = /\/GetModelsForMakeYear\/make\/([^/]+)\/modelyear\/\d+\/vehicletype\/(\w+)$/.exec(url.pathname);
    if (m) {
      // vPIC matches the make text loosely ("chev" finds Chevrolet); so does this fake.
      const typed = decodeURIComponent(m[1]!).toLowerCase();
      const kind = m[2] as keyof typeof TYPE_NAME;
      const make = Object.keys(MODELS).find((k) => k.startsWith(typed));
      return body((make ? MODELS[make]?.[kind] ?? [] : []).map((Model_Name) => ({ Model_Name, VehicleTypeName: TYPE_NAME[kind] })));
    }
    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;
}

export interface ApiSeen { readonly path: string; readonly status: number }

/**
 * Route the page's /api/vehicles/* to a fresh real proxy (cold cache, real limits) over the fake vPIC.
 * Returns every answer it gave, and every vPIC call it made.
 */
export async function routeVehiclesToFakeProxy(page: Page, opts: { latencyMs?: number } = {}): Promise<{ answers: ApiSeen[]; upstream: string[] }> {
  const upstream: string[] = [];
  const vpic = fakeVpic(opts.latencyMs ?? 150);
  const proxy = createProxy(defaultProviderConfig(), {
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => { upstream.push(String(input)); return vpic(input, init); }) as typeof globalThis.fetch,
    store: memoryStore(),
    now: () => Date.now(),
    // One browser is one person to the limiter.
    userKey: () => "e2e-claimant",
  });
  const answers: ApiSeen[] = [];
  await page.route("**/api/vehicles/**", async (route) => {
    const req = route.request();
    const res = await proxy(new Request(req.url(), { method: req.method() }));
    const u = new URL(req.url());
    answers.push({ path: `${u.pathname}${u.search}`, status: res.status });
    await route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers.entries()), body: Buffer.from(await res.arrayBuffer()) });
  });
  return { answers, upstream };
}
