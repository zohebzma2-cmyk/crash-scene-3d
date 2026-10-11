// Vehicle photos, 3D models and maker logos: /api/vehicles/image, /api/vehicles/model, /api/logos/make.
// docs/decisions/0011-vehicle-images.md has the why. In short:
//  - Everything is fetched here and served from our origin (the browser never sees a provider URL).
//  - Keys come from deps.secret at call time and only ever travel upstream in request headers, on calls
//    that refuse redirects. They are never in a URL, a cache key, a stored body, a log line or a response.
//  - Every failure (no keys, quota, our own limits, provider down, nothing found) is a fallback answer
//    (204, or JSON {fallback:true} for models) that the app shows as its own icon or model: never an error.
//  - Cached entries live under "media/" (one Blobs store, so they can be wiped together if the CarImages
//    subscription ends, as its terms require).
import { createHash } from "node:crypto";
import { MEDIA_HEADERS, type MediaFallback, type MediaFallbackReason, type ProviderConfig, type VehicleImageView } from "@csd/core";
import { canonicalMake, normMake, slugOf } from "./make-domains";
import { makeLogoParams, parseQuery, vehicleImageParams, vehicleModelParams } from "./params";
import type { ProxyDeps, SecretName } from "./types";
import { BadUpstreamBody, ProxyFailure, QuotaFailure, fetchUpstream, type Ctx, type Entry, type QuotaSpec, type UpstreamCall } from "./upstream";

const DAY_S = 86_400;
/** Longest a browser keeps a photo, model or logo (our server cache is longer). */
const BROWSER_MAX_S = 7 * DAY_S;
/** The temporary download URL logo.dev's API hands out lives about a day; we keep it an hour at most. */
const LOGODEV_LINK_TTL_S = 3600;
/** A generation whose years are this far from the asked year still counts (the provider picks "the closest"). */
const YEAR_SLACK = 2;
const LOGO_SIZE_PX = 256;

/** Fallbacks that may clear up soon: never cached by the browser. */
const TRANSIENT: ReadonlySet<MediaFallbackReason> = new Set(["not-configured", "quota", "busy", "upstream"]);

const decoder = new TextDecoder();
function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    throw new BadUpstreamBody("not JSON");
  }
}
const encodeJson = (v: unknown) => ({ bytes: new TextEncoder().encode(JSON.stringify(v)), contentType: "application/json; charset=utf-8" });

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const yearOf = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{4}$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isInteger(n) && n > 1880 && n < 2200 ? n : null;
};
/** The list in `data` (the catalog's usual shape) or the body itself when it is a list. */
const listOf = (body: unknown, field = "data"): unknown[] => (Array.isArray(body) ? body : isObj(body) && Array.isArray(body[field]) ? body[field] : []);

/* ------------------------------------------------------------------ bytes */

export type ImageKind = "image/webp" | "image/png" | "image/jpeg";
/** What the bytes are, by their signature (never by the provider's content-type). */
export function imageKind(b: Uint8Array): ImageKind | null {
  if (b.byteLength >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.byteLength >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.byteLength >= 12 && decoder.decode(b.subarray(0, 4)) === "RIFF" && decoder.decode(b.subarray(8, 12)) === "WEBP") return "image/webp";
  return null;
}
const isPng = (b: Uint8Array) => imageKind(b) === "image/png";
/** A binary glTF starts with "glTF" and version 2. */
export const isGlb = (b: Uint8Array) => b.byteLength >= 20 && b[0] === 0x67 && b[1] === 0x6c && b[2] === 0x54 && b[3] === 0x46 && b[4] === 2;
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/* ------------------------------------------------------------------ asset URLs */

/** Query parameters that could carry a credential: removed from every provider URL we keep. */
const SECRET_PARAMS = ["api_key", "api_secret", "apikey", "key", "secret", "token", "access_token"];

/**
 * An asset URL from a catalog answer, made safe to keep: https only, on an allowed host, credential
 * parameters removed, and dropped entirely if a secret still shows up anywhere in it.
 */
function safeAssetUrl(raw: unknown, hosts: readonly string[], secrets: readonly string[]): string | null {
  const s = str(raw);
  if (!s) return null;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== "https:" || !hosts.includes(u.hostname) || u.username || u.password) return null;
  for (const p of SECRET_PARAMS) u.searchParams.delete(p);
  const out = u.toString();
  return secrets.some((x) => x && out.includes(x)) ? null : out;
}

/** Photo URLs of one picture, keyed "<format>@<width>" ("webp@400") and "<format>@default". */
type AssetSet = Readonly<Record<string, string>>;
const FORMATS = ["webp", "png", "jpg"] as const;

function assetSet(v: unknown, hosts: readonly string[], secrets: readonly string[]): AssetSet | null {
  if (!isObj(v)) return null;
  const out: Record<string, string> = {};
  for (const f of FORMATS) {
    const u = safeAssetUrl(v[f], hosts, secrets);
    if (u) out[`${f}@default`] = u;
  }
  if (isObj(v.sizes)) {
    for (const [w, entry] of Object.entries(v.sizes)) {
      if (!/^\d{2,4}$|^full$/.test(w)) continue;
      if (typeof entry === "string") {
        const u = safeAssetUrl(entry, hosts, secrets);
        const f = FORMATS.find((x) => new RegExp(`\\.${x}(\\?|$)`, "i").test(entry));
        if (u && f) out[`${f}@${w}`] = u;
      } else if (isObj(entry)) {
        for (const f of FORMATS) {
          const u = safeAssetUrl(entry[f], hosts, secrets);
          if (u) out[`${f}@${w}`] = u;
        }
      }
    }
  }
  return Object.keys(out).length ? out : null;
}

/** The URL for this width: the configured format first, the width asked or the next larger, else the default size. */
function pickAsset(set: AssetSet, format: string, width: number): string | null {
  for (const f of [format, ...FORMATS.filter((x) => x !== format)]) {
    const widths = Object.keys(set).filter((k) => k.startsWith(`${f}@`) && /@\d+$/.test(k)).map((k) => Number(k.split("@")[1])).sort((a, b) => a - b);
    const w = widths.find((x) => x >= width) ?? widths[widths.length - 1];
    if (w !== undefined) return set[`${f}@${w}`] ?? null;
    if (set[`${f}@default`]) return set[`${f}@default`] ?? null;
  }
  return null;
}

/* ------------------------------------------------------------------ catalog shapes (what we keep) */

interface NamedSlug { readonly slug: string; readonly name: string; readonly start: number | null; readonly end: number | null }
interface Generation { readonly slug: string; readonly start: number | null; readonly end: number | null; readonly image: AssetSet | null }

function namedSlugs(body: unknown): NamedSlug[] {
  const out: NamedSlug[] = [];
  for (const r of listOf(body)) {
    if (!isObj(r)) continue;
    const slug = str(r.slug);
    const name = str(r.name) ?? slug;
    if (slug && name && /^[a-z0-9][a-z0-9._-]{0,80}$/i.test(slug)) out.push({ slug, name, start: yearOf(r.year_start), end: yearOf(r.year_end) });
  }
  return out;
}

/** The best catalog entry for a typed name: same letters and digits as its name or slug, the year inside its range if several. */
function findNamed(list: readonly NamedSlug[], typed: string, year: number | null, prefix = ""): NamedSlug | null {
  const want = normMake(typed);
  const wantNoPrefix = prefix && want.startsWith(prefix) ? want.slice(prefix.length) : want;
  const hits = list.filter((m) => [normMake(m.name), normMake(m.slug)].some((n) => n === want || n === wantNoPrefix));
  if (hits.length <= 1 || year === null) return hits[0] ?? null;
  return hits.find((m) => (m.start ?? -Infinity) <= year && year <= (m.end ?? Infinity)) ?? hits[0] ?? null;
}

/** The generation for a model year: one whose years hold it (the newest such), else the nearest within YEAR_SLACK. No year: the newest. */
export function pickGeneration<G extends { start: number | null; end: number | null }>(gens: readonly G[], year: number | null): G | null {
  if (gens.length === 0) return null;
  const byStart = [...gens].sort((a, b) => (b.start ?? 0) - (a.start ?? 0));
  if (year === null) return byStart[0] ?? null;
  const holding = byStart.find((g) => (g.start ?? -Infinity) <= year && year <= (g.end ?? Infinity));
  if (holding) return holding;
  const dist = (g: G) => (g.start !== null && year < g.start ? g.start - year : g.end !== null && year > g.end ? year - g.end : Infinity);
  const near = [...gens].sort((a, b) => dist(a) - dist(b))[0];
  return near && dist(near) <= YEAR_SLACK ? near : null;
}

/* ------------------------------------------------------------------ responses */

function mediaResponse(entry: Entry, ttlS: number, contentType: string, extra: Record<string, string>): Response {
  return new Response(entry.bytes as BodyInit, {
    status: 200,
    headers: {
      "content-type": contentType,
      "cache-control": entry.stale ? "public, max-age=60" : `public, max-age=${Math.min(ttlS, BROWSER_MAX_S)}`,
      "x-content-type-options": "nosniff",
      "x-proxy-cache": entry.stale ? "stale" : entry.hit ? "hit" : "miss",
      ...extra,
    },
  });
}

const fallbackHeaders = (reason: MediaFallbackReason): Record<string, string> => ({
  "cache-control": TRANSIENT.has(reason) ? "no-store" : "public, max-age=3600",
  "x-content-type-options": "nosniff",
  [MEDIA_HEADERS.fallback]: reason,
});

/** 204: "use your own picture". */
function noImage(reason: MediaFallbackReason, match: "none" | "make-only" = "none"): Response {
  return new Response(null, { status: 204, headers: { ...fallbackHeaders(reason), [MEDIA_HEADERS.image]: match } });
}
function noLogo(reason: MediaFallbackReason): Response {
  return new Response(null, { status: 204, headers: fallbackHeaders(reason) });
}
function noModel(reason: MediaFallbackReason): Response {
  const body: MediaFallback = { fallback: true, reason };
  return new Response(JSON.stringify(body), { status: 200, headers: { ...fallbackHeaders(reason), "content-type": "application/json; charset=utf-8" } });
}

/** Turn a failure into a fallback reason; anything unexpected is rethrown (a 500 with a plain message). */
function reasonOf(e: unknown): MediaFallbackReason {
  if (e instanceof QuotaFailure) return "quota";
  if (e instanceof ProxyFailure) return e.status === 429 ? "busy" : "upstream";
  if (e instanceof NoMatch) return e.reason;
  throw e;
}

class NoMatch extends Error {
  constructor(readonly reason: MediaFallbackReason, readonly match: "none" | "make-only" = "none") { super(reason); }
}

/* ------------------------------------------------------------------ the routes */

export interface MediaRoutes {
  vehicleImage(ctx: Ctx, url: URL): Promise<Response>;
  vehicleModel(ctx: Ctx, url: URL): Promise<Response>;
  makeLogo(ctx: Ctx, url: URL): Promise<Response>;
}

/** Printable ASCII, no spaces, a sane length: anything else is treated as "not set" (and never echoed). */
const SECRET_SHAPE = /^[\x21-\x7e]{8,512}$/;

export function createMediaRoutes(config: ProviderConfig, deps: ProxyDeps, badRequest: (fields: string[]) => Response): MediaRoutes {
  const { carimages: ci, logodev: ld, cacheTtlS: ttl } = config.media;
  const said = new Set<string>();
  const logOnce = (line: string) => {
    if (said.has(line)) return;
    said.add(line);
    (deps.log ?? ((l: string) => console.warn(l)))(line);
  };
  const secret = (name: SecretName): string | null => {
    let v: string | undefined;
    try { v = deps.secret?.(name); } catch { v = undefined; }
    return v && SECRET_SHAPE.test(v) ? v : null;
  };
  const ciKeys = (): { key: string; secret: string } | null => {
    const key = secret("CARIMAGES_API_KEY");
    const sec = secret("CARIMAGES_API_SECRET");
    if (key && sec) return { key, secret: sec };
    logOnce("proxy: CarImages keys are not set; vehicle photos and 3D models answer the fallback");
    return null;
  };
  const ldKey = (): string | null => {
    const k = secret("LOGO_DEV_SECRET_KEY");
    if (!k) logOnce("proxy: the logo.dev secret key is not set; maker logos skip logo.dev");
    return k;
  };

  const daily = (cap: number) => ({ capacity: Math.max(1, cap), refillPerS: Math.max(1, cap) / DAY_S });
  const ciQuota: QuotaSpec = { key: "quota:carimages", limit: daily(ci.dailyCap), cooldownKey: "media/ci/cooldown", cooldownS: ci.cooldownS };
  const ldQuota: QuotaSpec = { key: "quota:logodev", limit: daily(ld.dailyCap), cooldownKey: "media/ld/cooldown", cooldownS: ld.cooldownS };

  /** A keyed CarImages API call: key and secret in headers only, redirects refused, one quota token. */
  const ciCall = (path: string, keys: { key: string; secret: string }): UpstreamCall => ({
    service: "carimages",
    url: `${ci.apiUrl}${path}`,
    quota: ciQuota,
    init: { redirect: "error", headers: { Authorization: `Bearer ${keys.key}`, "X-Api-Secret": keys.secret, Accept: "application/json" } },
  });
  const ldCall = (path: string, key: string): UpstreamCall => ({
    service: "logodev",
    url: `${ld.apiUrl}${path}`,
    quota: ldQuota,
    init: { redirect: "error", headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } },
  });

  /** A JSON answer reshaped to only what we use (`shape`), cached under `cacheKey`. */
  async function keyedJson<T>(ctx: Ctx, cacheKey: string, ttlS: number, call: UpstreamCall, shape: (body: unknown) => T): Promise<{ value: T; hit: boolean }> {
    const entry = await fetchUpstream(ctx, {
      cacheKey, ttlS, calls: [call],
      process: (bytes) => encodeJson(shape(parseJson(bytes))),
    });
    return { value: parseJson(entry.bytes) as T, hit: entry.hit };
  }

  /** Download a file from an allowed host (no credentials sent), check it, cache it. */
  function asset(ctx: Ctx, cacheKey: string, ttlS: number, url: string, service: "carimages" | "logodev", check: (b: Uint8Array) => boolean): Promise<Entry> {
    return fetchUpstream(ctx, {
      cacheKey, ttlS, validStored: check,
      calls: [{ service: `${service}-2`, url }],
      process: (bytes) => {
        if (!check(bytes)) throw new BadUpstreamBody("not the expected file");
        return { bytes, contentType: "application/octet-stream" };
      },
    });
  }

  const ciSecrets = (k: { key: string; secret: string }) => [k.key, k.secret];

  /* ---- CarImages catalog ---- */

  async function findMake(ctx: Ctx, keys: { key: string; secret: string }, typed: string): Promise<NamedSlug> {
    const { value } = await keyedJson(ctx, "media/ci/makes", ttl.catalog, ciCall("/makes", keys), namedSlugs);
    const hit = findNamed(value, canonicalMake(typed), null);
    if (!hit) throw new NoMatch("no-make");
    return hit;
  }

  async function findModel(ctx: Ctx, keys: { key: string; secret: string }, make: NamedSlug, typed: string, year: number | null): Promise<NamedSlug> {
    const { value } = await keyedJson(ctx, `media/ci/models/${make.slug}`, ttl.catalog, ciCall(`/makes/${encodeURIComponent(make.slug)}/models`, keys), namedSlugs);
    const hit = findNamed(value, typed, year, normMake(make.name));
    if (!hit) throw new NoMatch("no-model", "make-only");
    return hit;
  }

  async function generations(ctx: Ctx, keys: { key: string; secret: string }, make: NamedSlug, model: NamedSlug): Promise<{ gens: Generation[]; hit: boolean; key: string }> {
    const key = `media/ci/model/${make.slug}/${model.slug}`;
    try {
      const { value, hit } = await keyedJson(ctx, key, ttl.catalog, ciCall(`/makes/${encodeURIComponent(make.slug)}/models/${encodeURIComponent(model.slug)}`, keys), (body) => {
        const gens: Generation[] = [];
        const list = isObj(body) && Array.isArray(body.generations) ? body.generations : isObj(body) && isObj(body.data) && Array.isArray(body.data.generations) ? body.data.generations : [];
        for (const g of list) {
          if (!isObj(g)) continue;
          const slug = str(g.slug);
          if (!slug || !/^[a-z0-9][a-z0-9._-]{0,80}$/i.test(slug)) continue;
          gens.push({ slug, start: yearOf(g.year_start), end: yearOf(g.year_end), image: assetSet(g.images, ci.assetHosts, ciSecrets(keys)) });
        }
        return gens;
      });
      return { gens: value, hit, key };
    } catch (e) {
      if (e instanceof ProxyFailure && e.status === 404) throw new NoMatch("no-model", "make-only");
      throw e;
    }
  }

  /** The catalog chain for a car: make, model, generation. */
  async function resolveCar(ctx: Ctx, keys: { key: string; secret: string }, makeText: string, modelText: string, year: number | null) {
    const make = await findMake(ctx, keys, makeText);
    const model = await findModel(ctx, keys, make, modelText, year);
    const g = await generations(ctx, keys, make, model);
    const gen = pickGeneration(g.gens, year);
    if (!gen) throw new NoMatch("no-image", "make-only");
    return { make, model, gen, catalogHit: g.hit, catalogKey: g.key };
  }

  /** Another angle of one generation (one more catalog call, cached). Null when the provider has none. */
  async function viewSet(ctx: Ctx, keys: { key: string; secret: string }, make: NamedSlug, model: NamedSlug, gen: Generation, view: VehicleImageView): Promise<{ set: AssetSet | null; hit: boolean; key: string }> {
    const key = `media/ci/views/${make.slug}/${model.slug}/${gen.slug}`;
    try {
      const { value, hit } = await keyedJson(
        ctx, key, ttl.catalog,
        ciCall(`/vehicles/${encodeURIComponent(make.slug)}/${encodeURIComponent(model.slug)}/${encodeURIComponent(gen.slug)}/image`, keys),
        (body) => {
          const views: Record<string, AssetSet> = {};
          const raw = isObj(body) && isObj(body.views) ? body.views : {};
          for (const [k, v] of Object.entries(raw)) {
            const set = assetSet(v, ci.assetHosts, ciSecrets(keys));
            if (set && /^[a-z0-9-]{2,12}$/.test(k)) views[k] = set;
          }
          return views;
        },
      );
      return { set: (value as Record<string, AssetSet>)[view] ?? null, hit, key };
    } catch (e) {
      if (e instanceof ProxyFailure && (e.status === 404 || e.status === 400)) return { set: null, hit: false, key };
      throw e;
    }
  }

  /**
   * Placeholder guard. The catalog route never asks /image (the endpoint that answers unknown cars and
   * quota with a placeholder), but if the same bytes ever come back for two different vehicles, they are a
   * placeholder: remember the hash, drop both copies, and answer the fallback from then on.
   */
  async function isPlaceholder(ctx: Ctx, bytes: Uint8Array, identity: string, cacheKey: string, fresh: boolean): Promise<boolean> {
    const { store } = ctx.deps;
    const hash = sha256(bytes);
    const known = await store.get("media/ci/placeholders");
    const set: string[] = known ? (parseJsonSafe(known.value) as string[] | null) ?? [] : [];
    if (set.includes(hash)) return true;
    if (!fresh) return false;
    const seen = await store.get(`media/ci/hash/${hash}`);
    const prev = seen ? (parseJsonSafe(seen.value) as { id?: string; key?: string } | null) : null;
    if (prev?.id && prev.id !== identity) {
      await store.set("media/ci/placeholders", encodeJson([...set, hash].slice(-50)).bytes, "application/json", ttl.logo);
      if (prev.key) await store.delete(prev.key);
      return true;
    }
    if (!prev) await store.set(`media/ci/hash/${hash}`, encodeJson({ id: identity, key: cacheKey }).bytes, "application/json", ttl.image);
    return false;
  }

  /** Download a catalog asset; when the catalog answer was a cached one whose link has expired, refresh it once. */
  async function catalogAsset<T>(
    ctx: Ctx, resolve: () => Promise<{ url: string | null; catalogHit: boolean; catalogKeys: readonly string[]; extra: T }>,
    cacheKey: (extra: T) => string, ttlS: number, check: (b: Uint8Array) => boolean,
  ): Promise<{ entry: Entry; extra: T }> {
    for (let attempt = 0; ; attempt++) {
      const r = await resolve();
      if (!r.url) throw new NoMatch("no-image");
      try {
        return { entry: await asset(ctx, cacheKey(r.extra), ttlS, r.url, "carimages", check), extra: r.extra };
      } catch (e) {
        const expiredLink = e instanceof ProxyFailure && !(e instanceof QuotaFailure) && e.status !== 429;
        if (attempt === 0 && r.catalogHit && expiredLink) {
          for (const k of r.catalogKeys) await ctx.deps.store.delete(k);
          continue;
        }
        throw e;
      }
    }
  }

  /* ---- motorcycles ---- */

  async function motoInPlan(ctx: Ctx, keys: { key: string; secret: string }): Promise<boolean> {
    const { value } = await keyedJson(ctx, "media/ci/libraries", ttl.libraries, ciCall("/libraries", keys), (body) => ({
      moto: isObj(body) && isObj(body.your_access) && body.your_access.moto === true,
    }));
    return value.moto;
  }

  async function motoImage(ctx: Ctx, keys: { key: string; secret: string }, makeText: string, modelText: string, width: number): Promise<Response> {
    if (!(await motoInPlan(ctx, keys))) return noImage("moto-not-in-plan");
    const { value: makes } = await keyedJson(ctx, "media/ci/moto-makes", ttl.catalog, ciCall("/motos/makes", keys), namedSlugs);
    const make = findNamed(makes, canonicalMake(makeText), null);
    if (!make) return noImage("no-make");
    const modelsKey = `media/ci/moto-models/${make.slug}`;
    const { value: models } = await keyedJson(ctx, modelsKey, ttl.catalog, ciCall(`/motos/makes/${encodeURIComponent(make.slug)}/models?limit=500`, keys), (body) =>
      listOf(body).flatMap((r) => {
        if (!isObj(r)) return [];
        const slug = str(r.slug);
        const name = str(r.name) ?? slug;
        const thumb = safeAssetUrl(r.thumbnail, ci.assetHosts, ciSecrets(keys));
        return slug && name ? [{ slug, name, start: yearOf(r.year_start), end: yearOf(r.year_end), thumb }] : [];
      }));
    const model = findNamed(models, modelText, null, normMake(make.name)) as (NamedSlug & { thumb: string | null }) | null;
    if (!model) return noImage("no-model", "make-only");
    if (!model.thumb) return noImage("no-image", "make-only");
    const key = `media/ci/moto-img/${make.slug}/${model.slug}/${width}`;
    const entry = await asset(ctx, key, ttl.image, model.thumb, "carimages", (b) => imageKind(b) !== null);
    if (await isPlaceholder(ctx, entry.bytes, `moto/${make.slug}/${model.slug}`, key, !entry.hit)) { await ctx.deps.store.delete(key); return noImage("no-image"); }
    return mediaResponse(entry, ttl.image, imageKind(entry.bytes) ?? "application/octet-stream", { [MEDIA_HEADERS.image]: "exact" });
  }

  /* ---- routes ---- */

  async function vehicleImage(ctx: Ctx, url: URL): Promise<Response> {
    const p = parseQuery(url, vehicleImageParams(new Date(deps.now()).getUTCFullYear()));
    if (!p.ok) return badRequest(p.fields);
    const keys = ciKeys();
    if (!keys) return noImage("not-configured");
    const { make: makeText, model: modelText, view, width, type } = p.data;
    const year = p.data.year ?? null;
    try {
      if (type === "moto") return await motoImage(ctx, keys, makeText, modelText, width);
      const { entry, extra } = await catalogAsset(ctx, async () => {
        const car = await resolveCar(ctx, keys, makeText, modelText, year);
        let set = car.gen.image;
        let served: VehicleImageView = "front34";
        let hit = car.catalogHit;
        const keysUsed = [car.catalogKey];
        if (view !== "front34") {
          const other = await viewSet(ctx, keys, car.make, car.model, car.gen, view);
          if (other.set) { set = other.set; served = view; hit = other.hit; keysUsed.push(other.key); }
        }
        return { url: set ? pickAsset(set, ci.format, width) : null, catalogHit: hit, catalogKeys: keysUsed, extra: { ...car, served } };
      }, (x) => `media/ci/img/${x.make.slug}/${x.model.slug}/${x.gen.slug}/${x.served}/${width}`, ttl.image, (b) => imageKind(b) !== null);
      const key = `media/ci/img/${extra.make.slug}/${extra.model.slug}/${extra.gen.slug}/${extra.served}/${width}`;
      if (await isPlaceholder(ctx, entry.bytes, `car/${extra.make.slug}/${extra.model.slug}/${extra.gen.slug}`, key, !entry.hit)) {
        await ctx.deps.store.delete(key);
        return noImage("no-image");
      }
      return mediaResponse(entry, ttl.image, imageKind(entry.bytes) ?? "application/octet-stream", { [MEDIA_HEADERS.image]: "exact", [MEDIA_HEADERS.view]: extra.served });
    } catch (e) {
      const reason = reasonOf(e);
      return noImage(reason, e instanceof NoMatch ? e.match : "none");
    }
  }

  async function vehicleModel(ctx: Ctx, url: URL): Promise<Response> {
    const p = parseQuery(url, vehicleModelParams(new Date(deps.now()).getUTCFullYear()));
    if (!p.ok) return badRequest(p.fields);
    const keys = ciKeys();
    if (!keys) return noModel("not-configured");
    const year = p.data.year ?? null;
    try {
      const { entry, extra } = await catalogAsset(ctx, async () => {
        const car = await resolveCar(ctx, keys, p.data.make, p.data.model, year);
        const path = `/vehicles/${encodeURIComponent(car.make.slug)}/${encodeURIComponent(car.model.slug)}/${encodeURIComponent(car.gen.slug)}/model`;
        const infoKey = `media/ci/glb-info/${car.make.slug}/${car.model.slug}/${car.gen.slug}`;
        let info: { url: string | null; watermarked: boolean; fallback: boolean };
        let infoHit: boolean;
        try {
          const got = await keyedJson(ctx, infoKey, ttl.model, ciCall(path, keys), (body) => {
            const b = isObj(body) && isObj(body.data) ? body.data : isObj(body) ? body : {};
            const raw = str(b.url) ?? str(b.model_url) ?? str(b.glb) ?? str(b.glb_url);
            return { url: safeAssetUrl(raw, ci.assetHosts, ciSecrets(keys)), watermarked: b.watermarked === true, fallback: b.fallback === true };
          });
          info = got.value;
          infoHit = got.hit;
        } catch (e) {
          if (e instanceof ProxyFailure && e.status === 404) throw new NoMatch("no-model");
          throw e;
        }
        // A car the provider has no 3D for comes back as a masked placeholder model: that is "no model".
        if (info.fallback) throw new NoMatch("no-model");
        return { url: info.url, catalogHit: infoHit, catalogKeys: [infoKey], extra: { ...car, watermarked: info.watermarked } };
      }, (x) => `media/ci/glb/${x.make.slug}/${x.model.slug}/${x.gen.slug}`, ttl.model, (b) => isGlb(b) && b.byteLength <= ci.maxModelBytes);
      return mediaResponse(entry, ttl.model, "model/gltf-binary", { [MEDIA_HEADERS.watermarked]: extra.watermarked ? "true" : "false" });
    } catch (e) {
      const reason = reasonOf(e);
      return noModel(reason === "no-image" ? "no-model" : reason);
    }
  }

  /* ---- logos ---- */

  type LogoSource = { src: "ci-brand"; name: string } | { src: "logodev"; domain: string } | { src: "ci-api"; slug: string } | { src: "none" };

  /** Where a maker's logo comes from, decided once and cached (a year when found, logoMiss when nobody has it). */
  async function logoBytes(ctx: Ctx, source: Exclude<LogoSource, { src: "none" }>): Promise<Entry> {
    if (source.src === "ci-brand") {
      // No key: CarImages' public logo endpoint (it redirects to its CDN).
      return fetchUpstream(ctx, {
        cacheKey: `media/logo/ci-brand/${normMake(source.name)}`, ttlS: ttl.logo, validStored: isPng,
        calls: [{ service: "carimages", url: `${ci.brandLogoUrl}?${new URLSearchParams({ make: source.name })}` }],
        process: (bytes) => { if (!isPng(bytes)) throw new BadUpstreamBody("not a PNG"); return { bytes, contentType: "image/png" }; },
      });
    }
    if (source.src === "ci-api") {
      return fetchUpstream(ctx, {
        cacheKey: `media/logo/ci-api/${source.slug}`, ttlS: ttl.logo, validStored: isPng,
        calls: [{ service: "carimages", url: `${ci.apiUrl}/makes/${encodeURIComponent(source.slug)}/logo` }],
        process: (bytes) => { if (!isPng(bytes)) throw new BadUpstreamBody("not a PNG"); return { bytes, contentType: "image/png" }; },
      });
    }
    const cacheKey = `media/logo/ld/${source.domain}`;
    const cached = await ctx.deps.store.get(cacheKey);
    if (cached && cached.expiresAt > ctx.deps.now() && isPng(cached.value)) {
      return { bytes: cached.value, contentType: "image/png", fetchedAt: ctx.deps.now(), stale: false, hit: true };
    }
    const key = ldKey();
    if (!key) throw new NoMatch("not-configured");
    // The API (secret key) hands out a temporary download link; that file is ours to keep (logo.dev self-hosting).
    const { value } = await keyedJson(ctx, `media/ld/link/${source.domain}`, LOGODEV_LINK_TTL_S, ldCall(`/v2/brands/logo?${new URLSearchParams({ domain: source.domain })}`, key), (body) => {
      const d = isObj(body) && isObj(body.data) ? body.data : {};
      return { url: safeAssetUrl(d.url, ld.assetHosts, [key]) };
    });
    if (!value.url) throw new NoMatch("no-image");
    const u = new URL(value.url);
    u.searchParams.set("size", String(LOGO_SIZE_PX));
    u.searchParams.set("format", "png");
    return asset(ctx, cacheKey, ttl.logo, u.toString(), "logodev", isPng);
  }

  /** The make's domain for logo.dev: the table, else logo.dev's search when its top result is this very make. */
  async function logoDomain(ctx: Ctx, n: string, name: string): Promise<string | null> {
    const known = ld.makeDomains[n];
    if (known) return known;
    const key = ldKey();
    if (!key) return null;
    const { value } = await keyedJson(ctx, `media/ld/search/${n}`, ttl.logo, ldCall(`/v2/search?${new URLSearchParams({ q: name, limit: "5" })}`, key), (body) => {
      for (const r of listOf(body)) {
        if (!isObj(r)) continue;
        const domain = str(r.domain);
        if (domain && normMake(str(r.name) ?? "") === n && /^[a-z0-9.-]{3,80}$/i.test(domain)) return { domain: domain.toLowerCase() };
      }
      return { domain: null as string | null };
    });
    return value.domain;
  }

  async function makeLogo(ctx: Ctx, url: URL): Promise<Response> {
    const p = parseQuery(url, makeLogoParams);
    if (!p.ok) return badRequest(p.fields);
    const name = canonicalMake(p.data.name);
    const n = normMake(name);
    if (!n) return badRequest(["name"]);
    const srcKey = `media/logo/src/${n}`;
    const { store, now } = ctx.deps;
    const send = (entry: Entry, src: LogoSource["src"]) =>
      mediaResponse(entry, ttl.logo, "image/png", { [MEDIA_HEADERS.logoSource]: src === "logodev" ? "logodev" : "carimages" });

    const known = await store.get(srcKey);
    const record = known ? (parseJsonSafe(known.value) as LogoSource | null) : null;
    if (known && record && known.expiresAt > now()) {
      if (record.src === "none") return noLogo("no-image");
      try {
        return send(await logoBytes(ctx, record), record.src);
      } catch {
        // The remembered source failed: walk the chain again below.
      }
    }

    const chain: Array<() => Promise<Exclude<LogoSource, { src: "none" }> | null>> = [
      async () => ({ src: "ci-brand", name }),
      async () => {
        const domain = await logoDomain(ctx, n, name);
        return domain ? { src: "logodev", domain } : null;
      },
      async () => ({ src: "ci-api", slug: slugOf(name) }),
    ];
    let transient: MediaFallbackReason | null = null;
    for (const next of chain) {
      try {
        const source = await next();
        if (!source) continue;
        const entry = await logoBytes(ctx, source);
        await store.set(srcKey, encodeJson(source).bytes, "application/json", ttl.logo);
        return send(entry, source.src);
      } catch (e) {
        // A 404 (or "nobody has it") moves on quietly; anything else is remembered so a miss isn't cached.
        if (e instanceof NoMatch) { if (e.reason !== "no-image") transient ??= e.reason; continue; }
        if (e instanceof ProxyFailure && e.status === 404) continue;
        transient ??= reasonOf(e);
      }
    }
    if (transient) return noLogo(transient);
    const none: LogoSource = { src: "none" };
    await store.set(srcKey, encodeJson(none).bytes, "application/json", ttl.logoMiss);
    return noLogo("no-image");
  }

  return { vehicleImage, vehicleModel, makeLogo };
}

function parseJsonSafe(b: Uint8Array): unknown {
  try { return JSON.parse(decoder.decode(b)); } catch { return null; }
}
