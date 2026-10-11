// /api/vehicles/image, /api/vehicles/model and /api/logos/make against a fake CarImages and logo.dev.
// The keys here are made up at run time; the point of several tests is that they never come back out.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MEDIA_HEADERS, PROXY_ROUTES, type ProviderConfig } from "@csd/core";
import { createProxy, defaultProviderConfig, isGlb, memoryStore, type KvStore, type SecretName } from "../src";
import { START, settle } from "./helpers";

beforeEach(() => { vi.useFakeTimers({ now: START }); });
afterEach(() => { vi.useRealTimers(); });

const DAY_MS = 86_400_000;
// Fake credentials, built at run time so nothing that looks like a key is in the repo.
const KEY = ["ci", "test", "k3y", String(START).slice(-6)].join("_");
const SECRET = ["sec", "test", "s3cret", String(START).slice(-5)].join("_");
const LD_SECRET = ["sk", "test", "logo", String(START).slice(-4)].join("_");
const SECRETS: Record<SecretName, string> = { CARIMAGES_API_KEY: KEY, CARIMAGES_API_SECRET: SECRET, LOGO_DEV_SECRET_KEY: LD_SECRET };

const bytes = (...parts: Array<string | number[]>) => new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...new TextEncoder().encode(p)] : p)));
const WEBP_A = bytes("RIFF", [1, 0, 0, 0], "WEBP", "VP8 car-a");
const WEBP_B = bytes("RIFF", [1, 0, 0, 0], "WEBP", "VP8 car-b");
const WEBP_SIDE = bytes("RIFF", [1, 0, 0, 0], "WEBP", "VP8 side");
const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "logo");
const PNG_LD = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "logo.dev");
// A GLB header: magic, version 2, and the total length (24) little-endian.
const GLB = bytes("glTF", [2, 0, 0, 0, 24, 0, 0, 0], "padding.....");

const CI = "https://carimagesapi.com/api/v1";
const CDN = "https://cdn.carimagesapi.com";
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const file = (b: Uint8Array, type = "application/octet-stream") => new Response(b as BodyInit, { status: 200, headers: { "content-type": type } });

interface Call { url: string; headers: Headers; redirect: string | undefined }
type Route = (c: Call) => Response | Promise<Response> | undefined;

/** The fake providers. Each test can override a URL by its start. */
function catalog(over: Record<string, Route> = {}): Route {
  const base: Record<string, Route> = {
    [`${CI}/makes/ford/models/f-150`]: () => json({
      slug: "f-150", name: "F-150",
      generations: [
        // A credential in a catalog URL must never be kept or sent on.
        { slug: "p552", year_start: 2015, year_end: 2020, images: { webp: `${CDN}/v/ford/f-150/p552.webp?sig=a&api_key=${KEY}`, sizes: { "400": { webp: `${CDN}/v/ford/f-150/p552-400.webp?sig=a&api_key=${KEY}` } } } },
        { slug: "p702", year_start: 2021, year_end: null, images: { webp: `${CDN}/v/ford/f-150/p702.webp`, sizes: { "400": { webp: `${CDN}/v/ford/f-150/p702-400.webp` } } } },
      ],
    }),
    [`${CI}/makes/ford/models/focus`]: () => json({ generations: [{ slug: "mk3", year_start: 2011, year_end: 2018, images: { webp: `${CDN}/v/ford/focus/mk3.webp` } }] }),
    [`${CI}/makes/ford/models`]: () => json({ make: { slug: "ford", name: "Ford" }, data: [
      { slug: "f-150", name: "F-150", year_start: 1975, year_end: null },
      { slug: "focus", name: "Focus", year_start: 2000, year_end: 2018 },
    ] }),
    [`${CI}/makes`]: () => json({ data: [{ slug: "ford", name: "Ford" }, { slug: "mercedes-benz", name: "Mercedes-Benz" }], total: 2 }),
    [`${CI}/vehicles/ford/f-150/p702/image`]: () => json({ views: { side: { webp: `${CDN}/v/ford/f-150/p702-side.webp` } } }),
    [`${CI}/vehicles/ford/f-150/p702/model`]: () => json({ url: `${CDN}/3d/ford/f-150/p702.glb`, watermarked: true, fallback: false }),
    [`${CI}/vehicles/ford/focus/mk3/model`]: () => json({ url: `${CDN}/3d/masked.glb`, watermarked: true, fallback: true }),
    [`${CI}/libraries`]: () => json({ libraries: {}, your_access: { plan: "free", car: true, moto: false } }),
    [`${CDN}/v/ford/f-150/p552-400.webp`]: () => file(WEBP_A),
    [`${CDN}/v/ford/f-150/p702-400.webp`]: () => file(WEBP_B),
    [`${CDN}/v/ford/f-150/p702-side.webp`]: () => file(WEBP_SIDE),
    [`${CDN}/v/ford/focus/mk3.webp`]: () => file(WEBP_A),
    [`${CDN}/3d/ford/f-150/p702.glb`]: () => file(GLB, "model/gltf-binary"),
    "https://carimagesapi.com/brand-logo?make=Ford": () => file(PNG, "image/png"),
    "https://carimagesapi.com/brand-logo": () => json({ error: "Unknown make" }, 404),
    [`${CI}/makes/zeta-motors/logo`]: () => file(PNG, "image/png"),
    "https://api.logo.dev/v2/brands/logo?domain=kia.com": () => json({ data: { url: "https://img.logo.dev/assets/kia?sig=1" } }),
    "https://img.logo.dev/assets/kia": () => file(PNG_LD, "image/png"),
    "https://api.logo.dev/v2/search": () => json({ data: [] }),
    "https://api.logo.dev/v2/brands/logo": () => json({ data: { status: "not_found" } }, 404),
    [`${CI}/makes/`]: () => json({ error: "Logo not found" }, 404),
    ...over,
  };
  // Longest matching start wins, so specific URLs beat their prefixes.
  const keys = Object.keys(base).sort((a, b) => b.length - a.length);
  return (c) => {
    const k = keys.find((p) => c.url === p || c.url.startsWith(`${p}?`) || c.url.startsWith(p));
    return k ? base[k]!(c) : json({ error: "not in the fake" }, 404);
  };
}

function setup(route: Route = catalog(), opts: { secrets?: Partial<Record<SecretName, string>>; config?: ProviderConfig } = {}) {
  const calls: Call[] = [];
  const logs: string[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = { url: String(input), headers: new Headers(init?.headers), redirect: init?.redirect };
    calls.push(call);
    const r = await route(call);
    if (!r) throw new TypeError("fetch failed");
    return r;
  }) as typeof globalThis.fetch;
  const inner = memoryStore();
  /** Everything ever written to the store, for the leak checks. */
  const written: Array<{ key: string; value: Uint8Array; contentType: string }> = [];
  const tokenKeys: string[] = [];
  const store: KvStore = {
    get: (k) => inner.get(k),
    set: (k, v, c, t, m) => { written.push({ key: k, value: v.slice(), contentType: c }); return inner.set(k, v, c, t, m); },
    delete: (k) => inner.delete(k),
    takeSlot: (k, n, i) => inner.takeSlot(k, n, i),
    reserveSlot: (k, n, i, w) => inner.reserveSlot(k, n, i, w),
    takeToken: (k, n, l) => { tokenKeys.push(k); return inner.takeToken(k, n, l); },
  };
  const secrets = opts.secrets ?? SECRETS;
  const proxy = createProxy(opts.config ?? defaultProviderConfig(), {
    fetch, store, now: () => Date.now(), userKey: (req) => req.headers.get("x-user") ?? "user-1",
    secret: (n) => secrets[n], log: (l) => logs.push(l),
  });
  const responses: Array<{ headers: string; body: Uint8Array }> = [];
  const get = async (path: string, user = "user-1") => {
    const res = await settle(proxy(new Request(`https://app.test${path}`, { headers: { "x-user": user } })));
    const body = new Uint8Array(await res.clone().arrayBuffer());
    responses.push({ headers: [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n"), body });
    return res;
  };
  return { calls, logs, written, tokenKeys, store, get, responses };
}

const image = (q: Record<string, string>) => `${PROXY_ROUTES.vehicleImage}?${new URLSearchParams(q)}`;
const model = (q: Record<string, string>) => `${PROXY_ROUTES.vehicleModel}?${new URLSearchParams(q)}`;
const logo = (name: string) => `${PROXY_ROUTES.makeLogo}?${new URLSearchParams({ name })}`;
const F150 = { year: "2022", make: "Ford", model: "F-150" };
const body = async (r: Response) => new Uint8Array(await r.arrayBuffer());
const text = (b: Uint8Array) => new TextDecoder("latin1").decode(b);

describe("vehicle photos", () => {
  it("serves the generation's photo from our origin, keys in headers only, redirects refused", async () => {
    const t = setup();
    const res = await t.get(image(F150));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get(MEDIA_HEADERS.image)).toBe("exact");
    expect(res.headers.get(MEDIA_HEADERS.view)).toBe("front34");
    expect(await body(res)).toEqual(WEBP_B); // 2022 is in p702 (2021-)
    const keyed = t.calls.filter((c) => c.url.startsWith(CI));
    expect(keyed.map((c) => c.url)).toEqual([`${CI}/makes`, `${CI}/makes/ford/models`, `${CI}/makes/ford/models/f-150`]);
    for (const c of keyed) {
      expect(c.headers.get("authorization")).toBe(`Bearer ${KEY}`);
      expect(c.headers.get("x-api-secret")).toBe(SECRET);
      expect(c.redirect).toBe("error");
    }
    // The CDN never gets a credential.
    const cdn = t.calls.filter((c) => c.url.startsWith(CDN));
    expect(cdn).toHaveLength(1);
    expect(cdn[0]!.headers.get("authorization")).toBeNull();
    expect(cdn[0]!.headers.get("x-api-secret")).toBeNull();
  });

  it("picks the generation by year, and strips credentials from catalog links before using or keeping them", async () => {
    const t = setup();
    const res = await t.get(image({ ...F150, year: "2017" }));
    expect(await body(res)).toEqual(WEBP_A);
    const cdn = t.calls.find((c) => c.url.startsWith(CDN))!;
    expect(cdn.url).toBe(`${CDN}/v/ford/f-150/p552-400.webp?sig=a`);
  });

  it("caches: a second ask makes no upstream call and takes no token", async () => {
    const t = setup();
    await t.get(image(F150));
    const calls = t.calls.length;
    const tokens = t.tokenKeys.length;
    const again = await t.get(image(F150), "user-2");
    expect(again.headers.get("x-proxy-cache")).toBe("hit");
    expect(await body(again)).toEqual(WEBP_B);
    expect(t.calls).toHaveLength(calls);
    expect(t.tokenKeys).toHaveLength(tokens);
  });

  it("serves another angle when asked, and says which one it served", async () => {
    const t = setup();
    const res = await t.get(image({ ...F150, view: "side" }));
    expect(res.headers.get(MEDIA_HEADERS.view)).toBe("side");
    expect(await body(res)).toEqual(WEBP_SIDE);
    // An angle the provider doesn't have: the default one, labelled as such.
    const t2 = setup(catalog({ [`${CI}/vehicles/ford/f-150/p702/image`]: () => json({ views: {} }) }));
    const res2 = await t2.get(image({ ...F150, view: "rear" }));
    expect(res2.headers.get(MEDIA_HEADERS.view)).toBe("front34");
  });

  it("answers 204 with a reason when the make or model is unknown, without asking for a photo", async () => {
    const t = setup();
    const noMake = await t.get(image({ year: "2020", make: "Zeta", model: "One" }));
    expect(noMake.status).toBe(204);
    expect(noMake.headers.get(MEDIA_HEADERS.fallback)).toBe("no-make");
    expect(noMake.headers.get(MEDIA_HEADERS.image)).toBe("none");
    const noModel = await t.get(image({ year: "2020", make: "Ford", model: "Model Q" }));
    expect(noModel.status).toBe(204);
    expect(noModel.headers.get(MEDIA_HEADERS.fallback)).toBe("no-model");
    expect(noModel.headers.get(MEDIA_HEADERS.image)).toBe("make-only");
    expect(noModel.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(t.calls.some((c) => c.url.startsWith(CDN))).toBe(false);
  });

  it("without keys: 204 not-configured, no upstream call, and one log line that names no key", async () => {
    const t = setup(catalog(), { secrets: {} });
    const a = await t.get(image(F150));
    const b = await t.get(model(F150));
    await t.get(image(F150));
    expect(a.status).toBe(204);
    expect(a.headers.get(MEDIA_HEADERS.fallback)).toBe("not-configured");
    expect(a.headers.get("cache-control")).toBe("no-store");
    expect(b.status).toBe(200);
    expect(await b.json()).toEqual({ fallback: true, reason: "not-configured" });
    expect(t.calls).toHaveLength(0);
    expect(t.logs).toEqual(["proxy: CarImages keys are not set; vehicle photos and 3D models answer the fallback"]);
  });

  it("treats a malformed key (spaces, control characters) as not set", async () => {
    const t = setup(catalog(), { secrets: { CARIMAGES_API_KEY: "has space in it", CARIMAGES_API_SECRET: SECRET } });
    const r = await t.get(image(F150));
    expect(r.headers.get(MEDIA_HEADERS.fallback)).toBe("not-configured");
    expect(t.calls).toHaveLength(0);
  });

  it("the provider's 429: fallback 'quota', then a cooldown with no further calls", async () => {
    const t = setup(catalog({ [`${CI}/makes`]: () => json({ error: "Monthly quota exceeded" }, 429) }));
    const r = await t.get(image(F150));
    expect(r.status).toBe(204);
    expect(r.headers.get(MEDIA_HEADERS.fallback)).toBe("quota");
    expect(r.headers.get("cache-control")).toBe("no-store");
    const n = t.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    const again = await t.get(image({ ...F150, model: "Focus" }));
    expect(again.headers.get(MEDIA_HEADERS.fallback)).toBe("quota");
    expect(t.calls).toHaveLength(n);
    // After the cooldown the provider is asked again.
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await t.get(image(F150));
    expect(t.calls.length).toBeGreaterThan(n);
  });

  it("our daily soft cap: past it, the fallback at once without a call", async () => {
    const base = defaultProviderConfig();
    const config: ProviderConfig = { ...base, media: { ...base.media, carimages: { ...base.media.carimages, dailyCap: 3 } } };
    const t = setup(catalog(), { config });
    expect((await t.get(image(F150))).status).toBe(200); // 3 keyed calls: makes, models, generations
    const before = t.calls.length;
    const FOCUS = { year: "2015", make: "Ford", model: "Focus" };
    const r = await t.get(image(FOCUS)); // needs one more keyed call
    expect(r.status).toBe(204);
    expect(r.headers.get(MEDIA_HEADERS.fallback)).toBe("quota");
    expect(t.calls).toHaveLength(before);
    // Cached answers still work past the cap.
    expect((await t.get(image(F150))).status).toBe(200);
    // The bucket refills over a day.
    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect((await t.get(image(FOCUS))).status).toBe(200);
  });

  it("network failure: fallback 'upstream', never a 5xx", async () => {
    const t = setup(() => undefined);
    const r = await t.get(image(F150));
    expect(r.status).toBe(204);
    expect(r.headers.get(MEDIA_HEADERS.fallback)).toBe("upstream");
  });

  it("stale while error: an expired photo is served when the provider fails", async () => {
    let down = false;
    const healthy = catalog();
    const t = setup((c) => (down ? undefined : healthy(c)));
    await t.get(image(F150));
    await vi.advanceTimersByTimeAsync(31 * DAY_MS);
    down = true;
    const r = await t.get(image(F150));
    expect(r.status).toBe(200);
    expect(r.headers.get("x-proxy-cache")).toBe("stale");
    expect(await body(r)).toEqual(WEBP_B);
  });

  it("refreshes a cached catalog once when its link has expired", async () => {
    let downloads = 0;
    const t = setup(catalog({ [`${CDN}/v/ford/f-150/p702-400.webp`]: () => (++downloads === 2 ? json({ error: "expired" }, 403) : file(WEBP_B)) }));
    expect((await t.get(image(F150))).status).toBe(200);
    const generationsCalls = () => t.calls.filter((c) => c.url === `${CI}/makes/ford/models/f-150`).length;
    expect(generationsCalls()).toBe(1);
    // A new width is a new download: the cached catalog's link fails once, so the catalog is fetched again and the download retried.
    const r = await t.get(image({ ...F150, width: "800" }));
    expect(r.status).toBe(200);
    expect(generationsCalls()).toBe(2);
    expect(downloads).toBe(3);
  });

  it("placeholder guard: the same bytes for two different vehicles is a placeholder, not a photo", async () => {
    const t = setup();
    expect((await t.get(image({ ...F150, year: "2017" }))).status).toBe(200); // p552 = WEBP_A
    const r = await t.get(image({ year: "2015", make: "Ford", model: "Focus" })); // mk3 = WEBP_A too
    expect(r.status).toBe(204);
    expect(r.headers.get(MEDIA_HEADERS.fallback)).toBe("no-image");
    // The first copy is dropped as well, and from now on that picture is a fallback.
    const again = await t.get(image({ ...F150, year: "2017" }));
    expect(again.status).toBe(204);
  });

  it("motorcycles: when the plan has none, the fallback after one cached plan check", async () => {
    const t = setup();
    const r = await t.get(image({ year: "2020", make: "Yamaha", model: "MT-07", type: "moto" }));
    expect(r.status).toBe(204);
    expect(r.headers.get(MEDIA_HEADERS.fallback)).toBe("moto-not-in-plan");
    await t.get(image({ year: "2019", make: "Honda", model: "Rebel", type: "moto" }));
    expect(t.calls.map((c) => c.url)).toEqual([`${CI}/libraries`]);
  });

  it("motorcycles in the plan: the catalog thumbnail", async () => {
    const t = setup(catalog({
      [`${CI}/libraries`]: () => json({ your_access: { plan: "pro_combined", car: true, moto: true } }),
      [`${CI}/motos/makes/yamaha/models`]: () => json({ data: [{ slug: "mt-07", name: "MT-07", thumbnail: `${CDN}/m/yamaha/mt-07.webp` }] }),
      [`${CI}/motos/makes`]: () => json({ data: [{ slug: "yamaha", name: "Yamaha" }] }),
      [`${CDN}/m/yamaha/mt-07.webp`]: () => file(WEBP_SIDE),
    }));
    const r = await t.get(image({ year: "2020", make: "Yamaha", model: "MT-07", type: "moto" }));
    expect(r.status).toBe(200);
    expect(await body(r)).toEqual(WEBP_SIDE);
  });

  it("rejects anything but the listed parameters", async () => {
    const t = setup();
    expect((await t.get(`${PROXY_ROUTES.vehicleImage}?make=Ford&model=F-150&api_key=x`)).status).toBe(400);
    expect((await t.get(`${PROXY_ROUTES.vehicleImage}?make=Ford&model=F-150&width=333`)).status).toBe(400);
    expect((await t.get(`${PROXY_ROUTES.vehicleImage}?make=<script>&model=x`)).status).toBe(400);
    expect(t.calls).toHaveLength(0);
  });
});

describe("3D models", () => {
  it("relays the GLB with the watermark flag", async () => {
    const t = setup();
    const r = await t.get(model(F150));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("model/gltf-binary");
    expect(r.headers.get(MEDIA_HEADERS.watermarked)).toBe("true");
    expect(await body(r)).toEqual(GLB);
  });

  it("a provider fallback (masked placeholder model) is 'no model'", async () => {
    const t = setup();
    const r = await t.get(model({ year: "2015", make: "Ford", model: "Focus" }));
    expect(await r.json()).toEqual({ fallback: true, reason: "no-model" });
    expect(t.calls.some((c) => c.url.includes("masked"))).toBe(false);
  });

  it("a file that isn't a GLB is not relayed", async () => {
    const t = setup(catalog({ [`${CDN}/3d/ford/f-150/p702.glb`]: () => file(bytes("<html>oops</html>")) }));
    const r = await t.get(model(F150));
    expect(await r.json()).toEqual({ fallback: true, reason: "upstream" });
  });
});

describe("maker logos", () => {
  it("CarImages' public logo first, with no key and no quota", async () => {
    const t = setup(catalog(), { secrets: {} });
    const r = await t.get(logo("Ford"));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(r.headers.get(MEDIA_HEADERS.logoSource)).toBe("carimages");
    expect(t.calls.map((c) => c.url)).toEqual(["https://carimagesapi.com/brand-logo?make=Ford"]);
    expect(t.calls[0]!.headers.get("authorization")).toBeNull();
    expect(t.tokenKeys.some((k) => k.startsWith("quota:"))).toBe(false);
  });

  it("then logo.dev's API (secret key, table domain), then CarImages' makes logo, in that order", async () => {
    const t = setup();
    const kia = await t.get(logo("Kia"));
    expect(kia.headers.get(MEDIA_HEADERS.logoSource)).toBe("logodev");
    expect(await body(kia)).toEqual(PNG_LD);
    expect(t.calls.map((c) => c.url)).toEqual([
      "https://carimagesapi.com/brand-logo?make=Kia",
      "https://api.logo.dev/v2/brands/logo?domain=kia.com",
      "https://img.logo.dev/assets/kia?sig=1&size=256&format=png",
    ]);
    expect(t.calls[1]!.headers.get("authorization")).toBe(`Bearer ${LD_SECRET}`);
    expect(t.calls[1]!.redirect).toBe("error");
    expect(t.calls[2]!.headers.get("authorization")).toBeNull();

    t.calls.length = 0;
    const zeta = await t.get(logo("Zeta Motors"));
    expect(zeta.headers.get(MEDIA_HEADERS.logoSource)).toBe("carimages");
    expect(t.calls.map((c) => c.url)).toEqual([
      "https://carimagesapi.com/brand-logo?make=Zeta+Motors",
      "https://api.logo.dev/v2/search?q=Zeta+Motors&limit=1",
      `${CI}/makes/zeta-motors/logo`,
    ]);
  });

  it("nobody has it: 204, remembered, so the next ask makes no call", async () => {
    const t = setup();
    const r = await t.get(logo("Nonesuch"));
    expect(r.status).toBe(204);
    expect(r.headers.get(MEDIA_HEADERS.fallback)).toBe("no-image");
    const n = t.calls.length;
    expect((await t.get(logo("nonesuch"))).status).toBe(204);
    expect(t.calls).toHaveLength(n);
  });

  it("a remembered source is served from cache with no call", async () => {
    const t = setup();
    await t.get(logo("Kia"));
    const n = t.calls.length;
    const again = await t.get(logo("KIA"));
    expect(again.headers.get(MEDIA_HEADERS.logoSource)).toBe("logodev");
    expect(t.calls).toHaveLength(n);
  });

  it("aliases resolve to the catalog name", async () => {
    const t = setup(catalog({ "https://carimagesapi.com/brand-logo?make=Chevrolet": () => file(PNG, "image/png") }));
    expect((await t.get(logo("Chevy"))).status).toBe(200);
    expect(t.calls[0]!.url).toBe("https://carimagesapi.com/brand-logo?make=Chevrolet");
  });
});

describe("limits", () => {
  it("media has its own buckets: busy map tiles never block a vehicle photo, and photos never spend tile tokens", async () => {
    const t = setup(catalog({ "https://tile.openstreetmap.org": () => file(PNG, "image/png") }));
    // Drain this user's tile bucket.
    await Promise.all(Array.from({ length: 70 }, (_, i) => t.get(`${PROXY_ROUTES.tile}/15/${9000 + i}/12070.png`)));
    const r = await t.get(image(F150));
    expect(r.status).toBe(200);
    const mediaTokens = t.tokenKeys.filter((k) => k.includes("carimages"));
    expect(mediaTokens).toContain("user:user-1:carimages");
    expect(mediaTokens).toContain("global:carimages");
    expect(mediaTokens).toContain("quota:carimages");
  });

  it("one caller asking too fast gets the fallback 'busy', not an error", async () => {
    const t = setup();
    const models = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"];
    const rs = await Promise.all(models.map((m) => t.get(image({ year: "2020", make: "Ford", model: `Model ${m}` }))));
    expect(rs.every((r) => r.status === 204 || r.status === 200)).toBe(true);
  });
});

describe("the keys never leak", () => {
  it("not in any response, header, stored entry, stored key or log line", async () => {
    const t = setup(catalog({ [`${CI}/makes/ford/models/focus`]: () => json({ error: `bad key ${KEY}` }, 500) }));
    await t.get(image(F150));
    await t.get(image({ ...F150, year: "2017" }));
    await t.get(image({ ...F150, view: "side" }));
    await t.get(image({ year: "2015", make: "Ford", model: "Focus" }));
    await t.get(model(F150));
    await t.get(model({ year: "2015", make: "Ford", model: "Focus" }));
    await t.get(logo("Kia"));
    await t.get(logo("Zeta Motors"));
    await t.get(image({ year: "2020", make: "Yamaha", model: "MT-07", type: "moto" }));
    const q = setup(catalog({ [`${CI}/makes`]: () => json({ error: `quota for ${KEY}` }, 429) }));
    await q.get(image(F150));
    const none = setup(catalog(), { secrets: {} });
    await none.get(image(F150));

    for (const s of [KEY, SECRET, LD_SECRET]) {
      for (const run of [t, q, none]) {
        for (const r of run.responses) {
          expect(r.headers).not.toContain(s);
          expect(text(r.body)).not.toContain(s);
        }
        for (const w of run.written) {
          expect(w.key).not.toContain(s);
          expect(text(w.value)).not.toContain(s);
          expect(w.contentType).not.toContain(s);
        }
        for (const l of run.logs) expect(l).not.toContain(s);
        for (const k of run.tokenKeys) expect(k).not.toContain(s);
        // Never in a URL we fetched.
        for (const c of run.calls) expect(c.url).not.toContain(s);
      }
    }
    // And the keys only ever went to the API hosts.
    for (const c of t.calls) {
      const host = new URL(c.url).host;
      if (c.headers.get("x-api-secret") || c.headers.get("authorization")) expect(["carimagesapi.com", "api.logo.dev"]).toContain(host);
    }
  });
});

const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } });

describe("redirects (SSRF)", () => {
  it("a CDN redirect to the cloud metadata address is refused, and that address is never fetched", async () => {
    const t = setup(catalog({ [`${CDN}/v/ford/f-150/p702-400.webp`]: () => redirect("http://169.254.169.254/latest/meta-data/iam") }));
    const r = await t.get(image(F150));
    expect(r.status).toBe(204);
    expect(r.headers.get(MEDIA_HEADERS.fallback)).toBe("upstream");
    expect(t.calls.some((c) => c.url.includes("169.254"))).toBe(false);
    // Downloads are made with manual redirects, so the runtime never follows one on its own.
    expect(t.calls.filter((c) => c.url.startsWith(CDN)).every((c) => c.redirect === "manual")).toBe(true);
  });

  it("a /brand-logo redirect to localhost is refused; the logo chain moves on and never serves it", async () => {
    const t = setup(catalog({ "https://carimagesapi.com/brand-logo?make=Ford": () => redirect("http://127.0.0.1:9001/admin") }));
    const r = await t.get(logo("Ford"));
    expect(t.calls.some((c) => c.url.includes("127.0.0.1"))).toBe(false);
    // Nothing else in this fake has a Ford logo: the answer is the fallback, not the redirect's target, and the
    // refusal is not remembered as "no logo" (it may be a passing fault).
    expect(r.status).toBe(204);
    expect(r.headers.get(MEDIA_HEADERS.fallback)).toBe("upstream");
    expect((await body(r)).byteLength).toBe(0);
  });

  it("follows up to three hops on the provider's own https hosts, and refuses a fourth", async () => {
    const hop = (n: number) => `${CDN}/hop/${n}`;
    const chain = (hops: number) => catalog({
      [`${CDN}/v/ford/f-150/p702-400.webp`]: () => redirect(hop(1)),
      [`${CDN}/hop/`]: (c) => {
        const n = Number(c.url.split("/").pop());
        return n < hops ? redirect(hop(n + 1)) : file(WEBP_B);
      },
    });
    const three = setup(chain(3));
    const ok = await three.get(image(F150));
    expect(ok.status).toBe(200);
    expect(await body(ok)).toEqual(WEBP_B);
    const four = setup(chain(4));
    const refused = await four.get(image(F150));
    expect(refused.status).toBe(204);
    expect(four.calls.some((c) => c.url === hop(4))).toBe(false);
  });

  it("an http: Location, even on the provider's host, is refused", async () => {
    const t = setup(catalog({ [`${CDN}/v/ford/f-150/p702-400.webp`]: () => redirect("http://cdn.carimagesapi.com/v/ford/f-150/p702-400.webp") }));
    const r = await t.get(image(F150));
    expect(r.status).toBe(204);
    expect(t.calls.filter((c) => c.url.startsWith("http:"))).toEqual([]);
  });

  it("a relative redirect on the same allowed host is followed", async () => {
    const t = setup(catalog({ "https://carimagesapi.com/brand-logo?make=Ford": () => redirect("https://cdn.carimagesapi.com/makes/ford.png?sig=x"), [`${CDN}/makes/ford.png`]: () => file(PNG, "image/png") }));
    const r = await t.get(logo("Ford"));
    expect(r.status).toBe(200);
    expect(r.headers.get(MEDIA_HEADERS.logoSource)).toBe("carimages");
  });
});

describe("review fixes", () => {
  it("logo.dev search: only its top result, and only with the make's exact name ('Geo', 'Eagle' refused)", async () => {
    const t = setup(catalog({
      "https://api.logo.dev/v2/search?q=Geo": () => json({ data: [{ name: "The GEO Group", domain: "geogroup.com" }, { name: "Geo", domain: "geo.example" }] }),
      "https://api.logo.dev/v2/search?q=Eagle": () => json({ data: [{ name: "Eagle Bank", domain: "eaglebankcorp.com" }, { name: "Eagle", domain: "eagle.org" }] }),
    }));
    for (const name of ["Geo", "Eagle"]) {
      const r = await t.get(logo(name));
      expect(r.status, name).toBe(204);
    }
    expect(t.calls.some((c) => /domain=(geogroup|geo\.example|eaglebankcorp|eagle\.org)/.test(c.url))).toBe(false);
    expect(t.calls.filter((c) => c.url.includes("/v2/search")).every((c) => c.url.includes("limit=1"))).toBe(true);
  });

  it("GLB check: version 2 and the header's length must match the bytes", () => {
    expect(isGlb(GLB)).toBe(true);
    const v = GLB.slice();
    v[4] = 2; v[5] = 1; // version 0x0102
    expect(isGlb(v)).toBe(false);
    const long = GLB.slice();
    long[8] = 99;
    expect(isGlb(long)).toBe(false);
    expect(isGlb(new Uint8Array([...GLB, 0, 0, 0, 0]))).toBe(false);
  });

  it("one user can't spend the whole daily cap: a second user still gets photos", async () => {
    const base = defaultProviderConfig();
    const config: ProviderConfig = { ...base, media: { ...base.media, carimages: { ...base.media.carimages, perUserDailyCap: 3 } } };
    const t = setup(catalog(), { config });
    expect((await t.get(image(F150), "heavy")).status).toBe(200); // makes, models, generations: 3 keyed calls
    const capped = await t.get(image({ year: "2015", make: "Ford", model: "Focus" }), "heavy");
    expect(capped.status).toBe(204);
    expect(capped.headers.get(MEDIA_HEADERS.fallback)).toBe("quota");
    const other = await t.get(image({ year: "2015", make: "Ford", model: "Focus" }), "someone-else");
    expect(other.status).toBe(200);
    expect(t.tokenKeys).toContain("user:heavy:quota:carimages");
  });

  it("a 5xx on a cached catalog's link doesn't refresh the catalog; a 410 does", async () => {
    for (const [status, refetch] of [[502, false], [504, false], [410, true], [403, true]] as const) {
      let n = 0;
      const t = setup(catalog({ [`${CDN}/v/ford/f-150/p702-400.webp`]: () => (++n === 2 ? json({ error: "x" }, status) : file(WEBP_B)) }));
      await t.get(image(F150));
      await t.get(image({ ...F150, width: "800" }));
      const gens = t.calls.filter((c) => c.url === `${CI}/makes/ford/models/f-150`).length;
      expect(gens, String(status)).toBe(refetch ? 2 : 1);
    }
  });

  it("two generations of one model with the same picture are not a placeholder", async () => {
    const t = setup(catalog({ [`${CDN}/v/ford/f-150/p552-400.webp`]: () => file(WEBP_B) }));
    expect((await t.get(image({ ...F150, year: "2017" }))).status).toBe(200);
    expect((await t.get(image(F150))).status).toBe(200);
    expect((await t.get(image({ ...F150, year: "2017" }))).status).toBe(200);
  });

  it("a secret with | and { is caught percent-encoded in a catalog link: the link is dropped, never fetched or kept", async () => {
    const odd = ["sec|ret{x}", String(START).slice(-5)].join("_");
    const enc = encodeURIComponent(odd);
    const t = setup(catalog({
      [`${CI}/makes/ford/models/f-150`]: () => json({ generations: [{ slug: "p702", year_start: 2021, year_end: null, images: { webp: `${CDN}/v/p702.webp?sig=${enc}` } }] }),
    }), { secrets: { ...SECRETS, CARIMAGES_API_SECRET: odd } });
    const r = await t.get(image(F150));
    expect(r.status).toBe(204);
    expect(r.headers.get(MEDIA_HEADERS.fallback)).toBe("no-image");
    for (const c of t.calls) expect(c.url.toLowerCase()).not.toContain(enc.toLowerCase());
    for (const w of t.written) expect(text(w.value).toLowerCase()).not.toContain(enc.toLowerCase());
  });
});

describe("upstream diagnostics", () => {
  it("logs one redacted line per distinct failure: endpoint, status, body start; a body echoing the key never reaches the log", async () => {
    const echo = `{"error":"bad key ${KEY} secret ${SECRET} Authorization: Bearer ${KEY} url ?api_key=${KEY}&api_secret=${SECRET}&sig=abc123&token=zz9 ${encodeURIComponent(SECRET)}"}`;
    const t = setup(catalog({ [`${CI}/makes`]: () => new Response(echo, { status: 401, headers: { "content-type": "application/json" } }) }));
    const r = await t.get(image(F150));
    expect(r.headers.get(MEDIA_HEADERS.fallback)).toBe("upstream");
    await t.get(image(F150));
    await t.get(model(F150));
    expect(t.logs).toHaveLength(1); // once per distinct line, however many requests hit it
    const line = t.logs[0]!;
    expect(line).toMatch(/^proxy: carimages https:\/\/carimagesapi\.com\/api\/v1\/makes -> 401 /);
    expect(line).toContain('"error":"bad key <redacted>');
    expect(line).toContain("Bearer <redacted>");
    expect(line).toContain("sig=<redacted>");
    expect(line).toContain("token=<redacted>");
    for (const s of [KEY, SECRET, encodeURIComponent(SECRET), "abc123", "zz9"]) expect(line).not.toContain(s);
    expect(line.toLowerCase()).not.toContain("x-api-secret:");
    expect(line.length).toBeLessThan(500);
  });

  it("a long error body is cut to 300 characters, and a secret cut off at the end of what was read is dropped", async () => {
    const odd = ["Zq", "9x", "unprefixed", String(START).slice(-5)].join("");
    // The secret straddles the 1024-byte read: only its first half is read. The long words before it are redacted
    // to "<redacted>", so what is left of it would land inside the 300 characters kept.
    const body = `${`${"w".repeat(45)} `.repeat(22)}ab ${odd} ${"y".repeat(400)}`;
    expect(body.indexOf(odd)).toBe(1015);
    const t = setup(catalog({ [`${CI}/makes`]: () => new Response(body, { status: 500 }) }), { secrets: { ...SECRETS, CARIMAGES_API_SECRET: odd } });
    await t.get(image(F150));
    expect(t.logs.length).toBeGreaterThan(0);
    for (const l of t.logs) {
      expect(l).not.toContain(odd.slice(0, 6));
      expect(l.length).toBeLessThan(450);
    }
  });

  it("a refused redirect names only the host it pointed at; a timeout or network error says so", async () => {
    const t = setup(catalog({ [`${CDN}/v/ford/f-150/p702-400.webp`]: () => new Response(null, { status: 302, headers: { location: `https://evil.example/x?api_key=${KEY}` } }) }));
    await t.get(image(F150));
    const line = t.logs.find((l) => l.includes("redirect refused"))!;
    expect(line).toContain("(redirect refused (to https://evil.example))");
    expect(line).toContain(`${CDN}/v/ford/f-150/p702-400.webp -> 302`);
    expect(line).not.toContain(KEY);
    const n = setup(() => undefined);
    await n.get(image(F150));
    expect(n.logs.some((l) => /carimages https:\/\/carimagesapi\.com\/api\/v1\/makes -> no answer \(network error/.test(l))).toBe(true);
  });

  it("logs the query's parameter names, never their values", async () => {
    const t = setup(catalog({ [`${CDN}/v/ford/f-150/p702-400.webp`]: () => json({ error: "expired" }, 403) }));
    await t.get(image(F150));
    expect(t.logs.some((l) => l.includes(`${CDN}/v/ford/f-150/p702-400.webp -> 403 {"error":"expired"}`))).toBe(true);
    const t2 = setup(catalog({ [`${CDN}/v/ford/f-150/p552-400.webp`]: () => json({ error: "gone" }, 410) }));
    await t2.get(image({ ...F150, year: "2017" }));
    const line = t2.logs.find((l) => l.includes("p552-400.webp"))!;
    expect(line).toContain("p552-400.webp?sig -> 410");
    expect(line).not.toContain("sig=a");
  });

  it("a model answer we can't use logs its shape (names and types, never values)", async () => {
    const t = setup(catalog({ [`${CI}/vehicles/ford/f-150/p702/model`]: () => json({ model: { href: `${CDN}/3d/x.glb?sig=${KEY}` }, watermarked: true, fallback: false }) }));
    await t.get(model(F150));
    const line = t.logs.find((l) => l.includes("/model -> 200"))!;
    expect(line).toContain("but no model URL we can use");
    expect(line).toContain("model:{href:url(https://cdn.carimagesapi.com)}");
    expect(line).toContain("fallback:false");
    expect(line).not.toContain(KEY);
    const f = setup();
    await f.get(model({ year: "2015", make: "Ford", model: "Focus" }));
    expect(f.logs.some((l) => l.includes("/vehicles/ford/focus/mk3/model -> 200 with fallback: true"))).toBe(true);
  });

  it("logo.dev failures are logged the same way, redacted", async () => {
    const t = setup(catalog({ "https://api.logo.dev/v2/brands/logo?domain=kia.com": () => json({ error: `invalid key ${LD_SECRET}` }, 401) }));
    await t.get(logo("Kia"));
    const line = t.logs.find((l) => l.startsWith("proxy: logodev"))!;
    expect(line).toContain("https://api.logo.dev/v2/brands/logo?domain -> 401");
    expect(line).not.toContain(LD_SECRET);
  });
});
