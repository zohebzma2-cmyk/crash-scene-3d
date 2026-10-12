// The image and 3D model chains against CarImages answers shaped as its docs publish them (fixtures/carimages/*.json,
// synthetic values) and the live API's own 401 body (error-401.json, recorded unkeyed on 2026-10-11, no key in it).
//
// The production bug this guards (2026-10-11): the docs' catalog links every picture into the keyed REST API
// ("https://carimagesapi.com/api/v1/vehicles/{make}/{model}/{gen}/image?redirect=1&format=webp"), which answers 401
// without the key. The proxy downloaded those links with no credentials, so every photo became 204 "upstream".
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MEDIA_HEADERS, PROXY_ROUTES } from "@csd/core";
import { createProxy, defaultProviderConfig, memoryStore, type KvStore, type SecretName } from "../src";
import { START, settle } from "./helpers";

beforeEach(() => { vi.useFakeTimers({ now: START }); });
afterEach(() => { vi.useRealTimers(); });

// Fake credentials, built at run time so nothing that looks like a key is in the repo.
const KEY = ["ci", "rec", "k3y", String(START).slice(-6)].join("_");
const SECRET = ["sec", "rec", "s3cret", String(START).slice(-5)].join("_");
const SECRETS: Record<SecretName, string> = { CARIMAGES_API_KEY: KEY, CARIMAGES_API_SECRET: SECRET, LOGO_DEV_SECRET_KEY: "" };

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/carimages/${name}.json`, import.meta.url), "utf8");
const bytes = (...parts: Array<string | number[]>) => new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...new TextEncoder().encode(p)] : p)));
const WEBP_400 = bytes("RIFF", [1, 0, 0, 0], "WEBP", "VP8 silverado-400");
const WEBP_SIDE = bytes("RIFF", [1, 0, 0, 0], "WEBP", "VP8 silverado-side");
const GLB = bytes("glTF", [2, 0, 0, 0, 24, 0, 0, 0], "padding.....");

const API = "https://carimagesapi.com/api/v1";
const CDN = "https://cdn.carimagesapi.com";
const GEN = `${API}/vehicles/chevrolet/silverado/gmt-t1xx-2019-2024`;
const jsonText = (text: string, status = 200) => new Response(text, { status, headers: { "content-type": "application/json" } });
const file = (b: Uint8Array, type: string) => new Response(b as BodyInit, { status: 200, headers: { "content-type": type } });
const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });

interface Call { url: string; headers: Headers; redirect: string | undefined }
type Route = (c: Call) => Response | undefined;

/** A keyed REST call: 401 with the live body unless both credentials are in the headers. */
const keyed = (answer: (c: Call) => Response): Route => (c) =>
  c.headers.get("authorization") === `Bearer ${KEY}` && c.headers.get("x-api-secret") === SECRET ? answer(c) : jsonText(fixture("error-401"), 401);

function provider(over: Record<string, Route> = {}): Route {
  const routes: Record<string, Route> = {
    [`${API}/makes`]: keyed(() => jsonText(fixture("makes"))),
    [`${API}/makes/chevrolet/models`]: keyed(() => jsonText(fixture("models-chevrolet"))),
    [`${API}/makes/chevrolet/models/silverado`]: keyed(() => jsonText(fixture("model-chevrolet-silverado"))),
    [`${GEN}/image`]: keyed((c) => {
      const q = new URL(c.url).searchParams;
      if (q.get("redirect") !== "1") return jsonText(fixture("vehicle-image-chevrolet-silverado"));
      // The documented 302 to the edge CDN, signed with expires + sig.
      const sized = q.get("view") === "side" ? "side" : `front34-${q.get("size") ?? "full"}`;
      return redirect(`${CDN}/v/chevrolet/silverado/gmt-t1xx-2019-2024/${sized}.${q.get("format") ?? "webp"}?expires=1791763200&sig=9a8b7c`);
    }),
    [`${GEN}/model`]: keyed((c) => (new URL(c.url).searchParams.get("redirect") === "1"
      ? redirect(`${CDN}/3d/chevrolet/silverado/gmt-t1xx-2019-2024.glb?expires=1791763200&sig=1a2b3c`)
      : jsonText(fixture("model-info")))),
    // The CDN: signed URLs, no credentials needed (or wanted).
    [`${CDN}/v/chevrolet/silverado/gmt-t1xx-2019-2024/front34-400.webp`]: (c) => (c.url.includes("sig=9a8b7c") ? file(WEBP_400, "image/webp") : jsonText('{"error":"Invalid signature"}', 403)),
    [`${CDN}/v/chevrolet/silverado/gmt-t1xx-2019-2024/side.webp`]: () => file(WEBP_SIDE, "image/webp"),
    [`${CDN}/3d/chevrolet/silverado/gmt-t1xx-2019-2024.glb`]: () => file(GLB, "model/gltf-binary"),
    ...over,
  };
  const keys = Object.keys(routes).sort((a, b) => b.length - a.length);
  return (c) => {
    const at = c.url.split("?")[0];
    const k = keys.find((p) => at === p);
    return k ? routes[k]!(c) : jsonText('{"error":"Make, model, or image not found"}', 404);
  };
}

function setup(route: Route = provider()) {
  const calls: Call[] = [];
  const logs: string[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = { url: String(input), headers: new Headers(init?.headers), redirect: init?.redirect };
    calls.push(call);
    const r = route(call);
    if (!r) throw new TypeError("fetch failed");
    return r;
  }) as typeof globalThis.fetch;
  const inner = memoryStore();
  const tokenKeys: string[] = [];
  const store: KvStore = {
    get: (k) => inner.get(k), set: (k, v, c, t, m) => inner.set(k, v, c, t, m), delete: (k) => inner.delete(k),
    takeSlot: (k, n, i) => inner.takeSlot(k, n, i), reserveSlot: (k, n, i, w) => inner.reserveSlot(k, n, i, w),
    takeToken: (k, n, l) => { tokenKeys.push(k); return inner.takeToken(k, n, l); },
  };
  const proxy = createProxy(defaultProviderConfig(), {
    fetch, store, now: () => Date.now(), userKey: () => "user-1", secret: (n) => SECRETS[n] || undefined, log: (l) => logs.push(l),
  });
  const get = (path: string) => settle(proxy(new Request(`https://app.test${path}`)));
  return { calls, logs, tokenKeys, get };
}

const SILVERADO = { make: "Chevrolet", model: "Silverado", year: "2021" };
const image = (q: Record<string, string>) => `${PROXY_ROUTES.vehicleImage}?${new URLSearchParams(q)}`;
const model = (q: Record<string, string>) => `${PROXY_ROUTES.vehicleModel}?${new URLSearchParams(q)}`;
const body = async (r: Response) => new Uint8Array(await r.arrayBuffer());
const hasCredential = (c: Call) => c.headers.get("authorization") !== null || c.headers.get("x-api-secret") !== null;

describe("CarImages as documented: the photo chain", () => {
  it("catalog, then the picture's REST link with the key in headers, then the CDN without it", async () => {
    const t = setup();
    const r = await t.get(image(SILVERADO));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/webp");
    expect(r.headers.get(MEDIA_HEADERS.image)).toBe("exact");
    expect(await body(r)).toEqual(WEBP_400);
    expect(t.calls.map((c) => c.url)).toEqual([
      `${API}/makes`,
      `${API}/makes/chevrolet/models`,
      `${API}/makes/chevrolet/models/silverado`,
      `${GEN}/image?redirect=1&format=webp&size=400`,
      `${CDN}/v/chevrolet/silverado/gmt-t1xx-2019-2024/front34-400.webp?expires=1791763200&sig=9a8b7c`,
    ]);
    // Every REST call carried both credentials in headers and none in the URL; the CDN got neither.
    for (const c of t.calls.slice(0, 4)) {
      expect(c.headers.get("authorization")).toBe(`Bearer ${KEY}`);
      expect(c.headers.get("x-api-secret")).toBe(SECRET);
      expect(c.url).not.toContain(KEY);
    }
    expect(t.calls.slice(0, 3).every((c) => c.redirect === "error")).toBe(true);
    expect(t.calls[3]!.redirect).toBe("manual"); // the 302 is followed by hand, to an allowed host only
    expect(hasCredential(t.calls[4]!)).toBe(false);
    // The download is a REST call too: it spends a quota token like the catalog calls.
    expect(t.tokenKeys.filter((k) => k === "quota:carimages")).toHaveLength(4);
    expect(t.logs).toEqual([]);
  });

  it("the production failure: a REST picture link fetched without the key is a 401, logged redacted, answered 204 'upstream'", async () => {
    // Simulates the old download step (and any key the API refuses): the picture link answers the live 401 body.
    const t = setup(provider({ [`${GEN}/image`]: () => jsonText(fixture("error-401"), 401) }));
    const r = await t.get(image(SILVERADO));
    expect(r.status).toBe(204);
    expect(r.headers.get(MEDIA_HEADERS.fallback)).toBe("upstream");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(t.logs).toHaveLength(1);
    expect(t.logs[0]).toBe(
      "proxy: carimages https://carimagesapi.com/api/v1/vehicles/chevrolet/silverado/gmt-t1xx-2019-2024/image?redirect,format,size -> 401 "
      + '{"error":"API key required. The REST API is available on every plan (free is watermarked) — pass ?api_key=<redacted> or '
      + 'Authorization: Bearer <redacted>, plus your api_secret via the X-Api-Secret header."}',
    );
    for (const l of t.logs) { expect(l).not.toContain(KEY); expect(l).not.toContain(SECRET); }
  });

  it("another angle: the views answer's link, keyed, then the CDN", async () => {
    const t = setup();
    const r = await t.get(image({ ...SILVERADO, view: "side" }));
    expect(r.headers.get(MEDIA_HEADERS.view)).toBe("side");
    expect(await body(r)).toEqual(WEBP_SIDE);
    expect(t.calls.map((c) => c.url)).toContain(`${GEN}/image?redirect=1&format=webp&view=side`);
    expect(t.calls.filter((c) => c.url.startsWith(CDN)).some(hasCredential)).toBe(false);
  });

  it("a generation without images (images: null) is 'no-image', with no download", async () => {
    const t = setup();
    const r = await t.get(image({ ...SILVERADO, year: "2010" }));
    expect(r.status).toBe(204);
    expect(r.headers.get(MEDIA_HEADERS.fallback)).toBe("no-image");
    expect(t.calls.some((c) => c.url.includes("/image"))).toBe(false);
  });

  it("a 404 on a picture link is 'no-image' (the provider has none), not an outage, and doesn't refetch the catalog", async () => {
    const t = setup(provider({ [`${GEN}/image`]: () => jsonText('{"error":"Image not found"}', 404) }));
    const r = await t.get(image(SILVERADO));
    expect(r.headers.get(MEDIA_HEADERS.fallback)).toBe("no-image");
    await t.get(image({ ...SILVERADO, width: "800" }));
    expect(t.calls.filter((c) => c.url === `${API}/makes/chevrolet/models/silverado`)).toHaveLength(1);
  });

  it("the keyed call's redirect never takes the key along, even to an allowed host, and a foreign host is refused", async () => {
    const onApi = setup(provider({ [`${GEN}/image`]: keyed(() => redirect(`https://carimagesapi.com/files/silverado.webp?sig=9a8b7c`)), "https://carimagesapi.com/files/silverado.webp": () => file(WEBP_400, "image/webp") }));
    expect((await onApi.get(image(SILVERADO))).status).toBe(200);
    expect(hasCredential(onApi.calls.find((c) => c.url.startsWith("https://carimagesapi.com/files/"))!)).toBe(false);

    const foreign = setup(provider({ [`${GEN}/image`]: keyed(() => redirect("https://collector.example/steal")) }));
    const r = await foreign.get(image(SILVERADO));
    expect(r.headers.get(MEDIA_HEADERS.fallback)).toBe("upstream");
    expect(foreign.calls.some((c) => c.url.includes("collector.example"))).toBe(false);
    expect(foreign.logs.some((l) => l.includes("redirect refused (to https://collector.example)"))).toBe(true);
  });
});

describe("CarImages as documented: the 3D model chain", () => {
  it("model JSON (url + watermarked + fallback), then the signed CDN link without credentials", async () => {
    const t = setup();
    const r = await t.get(model(SILVERADO));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("model/gltf-binary");
    expect(r.headers.get(MEDIA_HEADERS.watermarked)).toBe("true");
    expect(await body(r)).toEqual(GLB);
    const cdn = t.calls.find((c) => c.url.startsWith(`${CDN}/3d/`))!;
    expect(cdn.url).toBe(`${CDN}/3d/chevrolet/silverado/gmt-t1xx-2019-2024.glb?expires=1791763200&sig=0f0e0d0c0b0a`);
    expect(hasCredential(cdn)).toBe(false);
  });

  it("a model JSON with no URL we know: the documented ?redirect=1 (keyed) gives the GLB", async () => {
    const t = setup(provider({ [`${GEN}/model`]: keyed((c) => (new URL(c.url).searchParams.get("redirect") === "1"
      ? redirect(`${CDN}/3d/chevrolet/silverado/gmt-t1xx-2019-2024.glb?expires=1791763200&sig=1a2b3c`)
      : jsonText(JSON.stringify({ data: { asset: { location: "elsewhere" } }, fallback: false })))) }));
    const r = await t.get(model(SILVERADO));
    expect(r.status).toBe(200);
    expect(await body(r)).toEqual(GLB);
    // Watermark flag missing: assume the free plan's watermark.
    expect(r.headers.get(MEDIA_HEADERS.watermarked)).toBe("true");
    const redirected = t.calls.find((c) => c.url === `${GEN}/model?redirect=1`)!;
    expect(redirected.headers.get("x-api-secret")).toBe(SECRET);
    expect(t.logs.some((l) => l.includes("/model -> 200 but no model URL we can use"))).toBe(true);
  });

  it("fallback: true (the masked placeholder) is 'no-model', and says so in the log", async () => {
    const t = setup(provider({ [`${GEN}/model`]: keyed(() => jsonText(fixture("model-info-fallback"))) }));
    const r = await t.get(model(SILVERADO));
    expect(await r.json()).toEqual({ fallback: true, reason: "no-model" });
    expect(t.calls.some((c) => c.url.includes("_masked"))).toBe(false);
    expect(t.logs.some((l) => l.includes("/model -> 200 with fallback: true"))).toBe(true);
  });
});

describe("review fixes: only the documented REST asset links are fetched keyed", () => {
  it("N2: a catalog picture link to another REST path is refused: never fetched, no token spent, 'no-image'", async () => {
    const t = setup(provider({
      [`${API}/makes/chevrolet/models/silverado`]: keyed(() => jsonText(JSON.stringify({
        generations: [{ slug: "gmt-t1xx-2019-2024", year_start: 2019, year_end: 2024, images: { webp: `${API}/account/keys?redirect=1` } }],
      }))),
    }));
    const r = await t.get(image(SILVERADO));
    expect(r.status).toBe(204);
    expect(r.headers.get(MEDIA_HEADERS.fallback)).toBe("no-image");
    expect(t.calls.some((c) => c.url.includes("/account/"))).toBe(false);
    expect(t.tokenKeys.filter((k) => k === "quota:carimages")).toHaveLength(3); // makes, models, generations only
    expect(t.logs.some((l) => l.includes("refused a catalog link into the REST API") && l.includes("/api/v1/account/keys?redirect"))).toBe(true);
  });

  it("N2: a model URL of /api/v1/makes?redirect=1 is refused the same way ('no-model')", async () => {
    const t = setup(provider({ [`${GEN}/model`]: keyed(() => jsonText(JSON.stringify({ url: `${API}/makes?redirect=1`, watermarked: true, fallback: false }))) }));
    const r = await t.get(model(SILVERADO));
    expect(await r.json()).toEqual({ fallback: true, reason: "no-model" });
    expect(t.calls.filter((c) => c.url.startsWith(`${API}/makes?`))).toHaveLength(0);
    expect(t.tokenKeys.filter((k) => k === "quota:carimages")).toHaveLength(4); // makes, models, generations, model info
  });

  it("N2: the documented motorcycle thumbnail link is a keyed link", async () => {
    const t = setup(provider({
      [`${API}/libraries`]: keyed(() => jsonText(JSON.stringify({ your_access: { plan: "pro_combined", car: true, moto: true } }))),
      [`${API}/motos/makes`]: keyed(() => jsonText(JSON.stringify({ data: [{ slug: "ducati", name: "Ducati" }] }))),
      [`${API}/motos/makes/ducati/models`]: keyed(() => jsonText(JSON.stringify({ data: [{ slug: "ducati_panigale_v4", name: "Panigale V4", thumbnail: `${API}/motos/ducati/ducati_panigale_v4/2024/image?redirect=1&size=400&format=webp` }] }))),
      [`${API}/motos/ducati/ducati_panigale_v4/2024/image`]: keyed(() => redirect(`${CDN}/m/ducati/panigale-v4.webp?expires=1&sig=2`)),
      [`${CDN}/m/ducati/panigale-v4.webp`]: () => file(WEBP_SIDE, "image/webp"),
    }));
    const r = await t.get(image({ make: "Ducati", model: "Panigale V4", year: "2024", type: "moto" }));
    expect(r.status).toBe(200);
    expect(t.calls.find((c) => c.url.includes("/motos/ducati/ducati_panigale_v4/2024/image"))!.headers.get("x-api-secret")).toBe(SECRET);
    expect(hasCredential(t.calls.find((c) => c.url.startsWith(`${CDN}/m/`))!)).toBe(false);
  });
});
