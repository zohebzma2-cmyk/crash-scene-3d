// The one place that talks to outside services: cache first, then rate-limit slots, then the
// call (with timeout, User-Agent and fallbacks), then stale-on-error.
import {
  BUSY_MESSAGES, TIMEOUT_MESSAGES, UPSTREAM_MESSAGES,
  type BucketLimit, type ProviderConfig, type ProxyError, type ProxyTopic,
} from "@csd/core";
import type { EntryMeta, ProxyDeps, StoredEntry } from "./types";

/** Longest we hold a request waiting for a slot or token before answering "busy". */
export const MAX_SLOT_WAIT_MS = 1200;
/**
 * vPIC waits longer for a token than the map does: a model list is four calls that each need one, and a
 * person typing would rather wait a moment than be told "busy" (docs/PROXY-BUSY.md).
 */
export const VEHICLES_TOKEN_WAIT_MS = 2500;
/**
 * Overpass only: how long a request waits for the caller's own 1 req/s slot instead of being refused.
 * Picking a street asks for the roads around it (/api/geo/overpass) and its cross streets
 * (/api/geo/cross-streets) within a third of a second; the second one used to get an instant 429.
 * The request reserves the caller's next free slot (KvStore.reserveSlot) and sleeps until it: no
 * polling, and with 2 s and 1 req/s at most two requests per caller wait; more are refused at once.
 * Waiting keeps every caller at 1 request a second to Overpass, and the global slot still holds
 * all callers together to 1 a second. Nominatim's per-user slot still refuses at once (the app
 * spaces its on-submit searches a second apart itself).
 */
export const USER_QUEUE_MS: Readonly<Partial<Record<Service, number>>> = { overpass: 2000 };
const SLOT_POLL_MS = 100;
/** An attempt that would get less time than this is not worth starting. */
const MIN_ATTEMPT_MS = 300;
/** The first attempt of several gets at least this much (or half the time left), so mirrors still have time. */
const FIRST_ATTEMPT_FLOOR_MS = 1500;
const MAX_BODY_BYTES = 15 * 1024 * 1024;
/** The map's wording; other topics have their own (UPSTREAM_MESSAGES in @csd/core). */
export const UPSTREAM_MESSAGE = UPSTREAM_MESSAGES.map;
export const NOT_FOUND_MESSAGE = "That wasn't found.";

export type Service = "nominatim" | "overpass" | "tiles" | "terrain" | "vehicles" | "photon" | "carimages" | "logodev";
/**
 * Tiles, elevation tiles, type-ahead, vPIC and the media providers (CarImages, logo.dev) use token buckets
 * (ProviderConfig.tileBurst / suggestBurst / vehiclesBurst / media.*.burst); Nominatim and Overpass are 1 req/s.
 */
const isBucketService = (s: Service) => s === "tiles" || s === "terrain" || s === "photon" || s === "vehicles" || s === "carimages" || s === "logodev";
const burstOf = (config: ProviderConfig, s: Service) =>
  s === "photon" ? config.suggestBurst : s === "vehicles" ? config.vehiclesBurst
    : s === "carimages" ? config.media.carimages.burst : s === "logodev" ? config.media.logodev.burst : config.tileBurst;

export class ProxyFailure extends Error {
  constructor(
    readonly status: number, readonly error: ProxyError, readonly why?: { readonly service: string; readonly limiter: "user" | "global" },
    /** The provider's own 4xx when that is why the call failed (never sent to the browser). */
    readonly upstreamStatus?: number,
  ) {
    super(error.message);
  }
}

/**
 * The 429 for this request's topic, carrying the service and which limit refused it. It is logged by the
 * handler only when a 429 actually goes out (not when a stale copy is served instead), once per request.
 */
export function busy(ctx: Pick<Ctx, "topic">, retryAfterS: number, service: string, limiter: "user" | "global"): ProxyFailure {
  return new ProxyFailure(429, { code: "busy", message: BUSY_MESSAGES[ctx.topic], retryAfterS }, { service, limiter });
}

/**
 * A keyed provider call was not made (our daily soft cap, or a cooldown after the provider's own 429), or the
 * provider answered 429. The media routes turn it into their fallback; it is never shown as an error.
 */
export class QuotaFailure extends ProxyFailure {
  constructor(
    retryAfterS: number,
    /** What refused it: the caller's own daily share, the shared daily cap, the cooldown after a provider 429, or that 429. */
    readonly refusedBy: QuotaRefusal = "provider",
    /** The QuotaSpec key ("quota:carimages"), when known. */
    readonly quotaKey?: string,
  ) {
    // Never shown: the media routes answer their fallback instead.
    super(429, { code: "busy", message: BUSY_MESSAGES.vehicles, retryAfterS });
  }
}

export type QuotaRefusal = "per-user" | "shared" | "cooldown" | "provider";

/**
 * A call that spends a provider's monthly quota. Before it is made (never for a cache hit) it takes a token
 * from `key` (a rolling daily bucket) and checks the cooldown entry; when the provider answers 429 the
 * cooldown is set for `cooldownS`. Either way the request fails with QuotaFailure without waiting.
 */
export interface QuotaSpec {
  readonly key: string;
  readonly limit: BucketLimit;
  /**
   * Each caller's own share of the daily cap (a rolling bucket kept with the per-user records, which are dated by
   * UTC day): one person can't spend everyone's quota. Taken first; given back if the shared cap then refuses.
   */
  readonly perUser?: BucketLimit;
  readonly cooldownKey: string;
  readonly cooldownS: number;
}

/** Thrown by a `process` hook when the upstream body is unusable (counts like a 5xx: try the next URL). */
export class BadUpstreamBody extends Error {}

export interface Entry {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  /** When this body was fetched or last revalidated (ms). */
  readonly fetchedAt: number;
  /** The provider's ETag, when it sent one (tiles). */
  readonly etag?: string;
  /** The provider said `Cache-Control: no-store`: nothing was (or is) kept, and the browser must not keep it either. */
  readonly noStore?: boolean;
  readonly stale: boolean;
  readonly hit: boolean;
}

export interface Ctx {
  /** What the request is about: picks the wording of busy, timeout and upstream answers. */
  readonly topic: ProxyTopic;
  readonly config: ProviderConfig;
  readonly deps: ProxyDeps;
  readonly userKey: string;
  /** Services whose per-user 1 req/s slot this request already holds. */
  readonly userSlots: Set<string>;
  /** Per-user bucket tokens this request took or is waiting for, by service (one per request and service). */
  readonly userTokens: Map<string, Promise<void>>;
  readonly inflight: Map<string, Promise<Entry>>;
  /** URL → time (ms) until which it is tried last: it timed out or failed recently. Per proxy instance. */
  readonly health: Map<string, number>;
  /** Overall deadline for this request (ms, deps.now() clock): slot waits and every attempt count against it. */
  readonly deadline: number;
}

/**
 * What went wrong with one upstream call, for a diagnostic log line. `url` is the URL that answered (a redirect
 * hop's, not always the call's); `status` is 0 for a timeout or a network error; `body` is the start of the
 * error body as the provider sent it (raw: whoever logs it must redact it first). Request headers are never here.
 */
export interface UpstreamErrorInfo {
  readonly url: string;
  readonly status: number;
  readonly body: string;
  /** The body was longer than what was read: its last word may be cut short. */
  readonly truncated?: boolean;
  readonly note?: string;
}

/** How much of an error body is read for a diagnostic (the log keeps less). */
const ERROR_BODY_BYTES = 1024;

export interface UpstreamCall {
  readonly url: string;
  /**
   * `redirect: "error"` for calls that carry a key in a header: a redirect to another host must never take
   * the key along. The default follows redirects. With `redirectHosts`, these headers go to the first URL
   * only: a redirect hop never gets them.
   */
  readonly init?: { method?: string; headers?: Record<string, string>; body?: string; redirect?: "follow" | "error" };
  /**
   * Redirects are followed by hand, at most MAX_REDIRECT_HOPS, and only to an https URL whose host is in this
   * list; any other Location (another host, http:, an IP, a fourth hop) fails the call. For downloads whose URL
   * came from a provider (media), so a redirect can't point the server at an internal address. Hops are made
   * with the User-Agent only (no `init.headers`), so a keyed first call never hands its key to the next host.
   */
  readonly redirectHosts?: readonly string[];
  /** Slot service for this URL (fallback hosts get their own). */
  readonly service: Service | `${Service}-${number}`;
  /** This call spends a provider quota (keyed media API calls). */
  readonly quota?: QuotaSpec;
  /** Told about every failed attempt (a 4xx/5xx, a refused redirect, a timeout, an unusable body). For logging only. */
  readonly onError?: (info: UpstreamErrorInfo) => void;
}

/** The first `max` bytes of a body as text, then the rest cancelled (an error page is never read in full). */
async function bodyStart(res: Response, max: number): Promise<{ body: string; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { body: "", truncated: false };
  const chunks: Uint8Array[] = [];
  let n = 0;
  try {
    while (n < max) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      n += value.byteLength;
    }
  } catch {
    // a body that breaks off is reported as far as it got
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const all = new Uint8Array(Math.min(n, max));
  let at = 0;
  for (const c of chunks) {
    const part = c.subarray(0, all.byteLength - at);
    all.set(part, at);
    at += part.byteLength;
    if (at >= all.byteLength) break;
  }
  return { body: new TextDecoder().decode(all), truncated: n > max };
}

/** Tell the call's onError hook, never letting the hook break the request. */
function report(call: UpstreamCall, info: UpstreamErrorInfo): void {
  if (!call.onError) return;
  try { call.onError(info); } catch { /* logging must never fail a request */ }
}

export interface UpstreamSpec {
  readonly cacheKey: string;
  readonly ttlS: number;
  readonly calls: readonly UpstreamCall[];
  /** Validate / reshape an OK body. Throw BadUpstreamBody to reject it. */
  readonly process?: (bytes: Uint8Array, contentType: string, call: UpstreamCall, nowMs: number) => { bytes: Uint8Array; contentType: string };
  /**
   * Longest an entry may be kept, counted from when it was fetched (default: forever, i.e. the
   * store's own turnover). Entries older than this are deleted when read instead of served
   * stale. Used for entries built from what people typed (search, crossing): 7 days.
   */
  readonly keepS?: number;
  /**
   * Honour the provider's HTTP caching (tiles, terrain): keep the body for max(ttlS, the provider's
   * max-age or Expires), store its ETag / Last-Modified, and once expired revalidate with
   * If-None-Match / If-Modified-Since: a 304 refreshes the entry without a body, only a 200
   * replaces the bytes. A response with `Cache-Control: no-store` is passed through but never cached.
   */
  readonly httpCache?: boolean;
  /**
   * Is a stored body still usable? A stored entry that fails this (an empty or non-PNG tile that
   * somehow got in) is deleted and fetched in full instead of being served or revalidated.
   */
  readonly validStored?: (bytes: Uint8Array) => boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Take one token from a bucket, waiting (until `waitUntil`, ms on the deps.now() clock) for a refill. */
async function takeBucketToken(ctx: Ctx, key: string, limit: BucketLimit, waitUntil: number, service: string, limiter: "user" | "global"): Promise<void> {
  for (;;) {
    const retryInMs = await ctx.deps.store.takeToken(key, ctx.deps.now(), limit);
    if (retryInMs <= 0) return;
    if (retryInMs > waitUntil - ctx.deps.now()) throw busy(ctx, Math.max(1, Math.ceil(retryInMs / 1000)), service, limiter);
    await sleep(retryInMs);
  }
}

/** Take the per-user slot (once per request and service) and the global slot (once per call), or throw busy. */
async function takeSlots(ctx: Ctx, service: string): Promise<void> {
  const base = service.split("-")[0] as Service;
  const { limits } = ctx.config;
  const { store, now } = ctx.deps;
  if (isBucketService(base)) {
    const burst = burstOf(ctx.config, base);
    // One wait budget for both buckets: a call never waits longer than this in all before its 429.
    const waitUntil = Math.min(now() + (base === "vehicles" ? VEHICLES_TOKEN_WAIT_MS : MAX_SLOT_WAIT_MS), ctx.deadline);
    const userBucket = `user:${ctx.userKey}:${base}`;
    if (base === "vehicles") {
      // vPIC: one user token per upstream call, so one person's long-run share of the global bucket is capped at
      // perUser.refillPerS calls a second, below the global refill (a model list is four calls). The user token
      // is taken first, so a caller over its own limit never spends the shared tokens; if the global bucket then
      // refuses, the user token is given back.
      await takeBucketToken(ctx, userBucket, burst.perUser, waitUntil, base, "user");
      try {
        await takeBucketToken(ctx, `global:${base}`, burst.global, waitUntil, base, "global");
      } catch (e) {
        await store.returnToken?.(userBucket, now(), burst.perUser).catch(() => undefined);
        throw e;
      }
      return;
    }
    // One user token per request and service: calls in one request share the one wait.
    let mine = ctx.userTokens.get(base);
    if (!mine) {
      mine = takeBucketToken(ctx, userBucket, burst.perUser, waitUntil, base, "user");
      ctx.userTokens.set(base, mine);
    }
    await mine;
    await takeBucketToken(ctx, `global:${base}`, burst.global, waitUntil, base, "global");
    return;
  }
  if (!ctx.userSlots.has(base)) {
    const userKey = `user:${ctx.userKey}:${base}`;
    const queueMs = USER_QUEUE_MS[base];
    if (queueMs === undefined) {
      if (!(await store.takeSlot(userKey, now(), limits.perUserMinIntervalMs))) throw busy(ctx, Math.ceil(limits.perUserMinIntervalMs / 1000), base, "user");
    } else {
      // Reserve the caller's next slot (one read, one write) and sleep until it, instead of polling: at most
      // queueMs / interval requests wait per caller, the rest are refused at once, first come first served.
      const start = await store.reserveSlot(userKey, now(), limits.perUserMinIntervalMs, Math.max(0, Math.min(queueMs, ctx.deadline - now())));
      if (start === null) throw busy(ctx, Math.ceil(limits.perUserMinIntervalMs / 1000), base, "user");
      if (start > now()) await sleep(start - now());
    }
    ctx.userSlots.add(base);
  }
  const waitUntil = Math.min(now() + MAX_SLOT_WAIT_MS, ctx.deadline);
  for (;;) {
    if (await store.takeSlot(`global:${service}`, now(), limits.minIntervalMs)) return;
    const left = waitUntil - now();
    if (left <= 0) throw busy(ctx, Math.ceil((limits.minIntervalMs * 2) / 1000), service, "global");
    await sleep(Math.min(SLOT_POLL_MS, left));
  }
}

/** Take one quota token for a keyed call, or throw QuotaFailure (no waiting: the caller falls back at once). */
async function takeQuota(ctx: Ctx, q: QuotaSpec): Promise<void> {
  const { store, now } = ctx.deps;
  const cooling = await store.get(q.cooldownKey);
  if (cooling && cooling.expiresAt > now()) throw new QuotaFailure(Math.max(1, Math.ceil((cooling.expiresAt - now()) / 1000)), "cooldown", q.key);
  const mine = `user:${ctx.userKey}:${q.key}`;
  if (q.perUser) {
    const wait = await store.takeToken(mine, now(), q.perUser);
    if (wait > 0) throw new QuotaFailure(Math.max(1, Math.ceil(wait / 1000)), "per-user", q.key);
  }
  const retryInMs = await store.takeToken(q.key, now(), q.limit);
  if (retryInMs > 0) {
    if (q.perUser) await store.returnToken?.(mine, now(), q.perUser).catch(() => undefined);
    throw new QuotaFailure(Math.max(1, Math.ceil(retryInMs / 1000)), "shared", q.key);
  }
}

type Attempt =
  | { kind: "ok"; bytes: Uint8Array; contentType: string; headers: Headers }
  | { kind: "not-modified"; headers: Headers }
  | { kind: "retry"; timeout: boolean; status?: number }
  | { kind: "fail"; status: number };

/** Most redirects a `redirectHosts` call follows. */
export const MAX_REDIRECT_HOPS = 3;

/** The next URL of a redirect, or null unless it is https, has no credentials and its host is allowed. */
export function allowedRedirect(from: string, location: string | null, hosts: readonly string[]): string | null {
  if (!location) return null;
  let u: URL;
  try { u = new URL(location, from); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password || u.port || !hosts.includes(u.hostname)) return null;
  return u.toString();
}

async function attempt(ctx: Ctx, call: UpstreamCall, budgetMs: number): Promise<Attempt> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => { ctrl.abort(); resolve("timeout"); }, budgetMs);
  });
  let url = call.url;
  const work = (async (): Promise<Attempt> => {
    let res: Response;
    for (let hop = 0; ; hop++) {
      res = await ctx.deps.fetch(url, {
        method: hop === 0 ? (call.init?.method ?? "GET") : "GET",
        body: hop === 0 ? call.init?.body : undefined,
        // A redirect hop gets the User-Agent only: a key sent to the first URL never travels to the next one.
        headers: hop === 0 ? { ...call.init?.headers, "User-Agent": ctx.config.userAgent } : { "User-Agent": ctx.config.userAgent },
        signal: ctrl.signal,
        redirect: call.redirectHosts ? "manual" : (call.init?.redirect ?? "follow"),
      });
      if (!call.redirectHosts || res.status < 300 || res.status >= 400 || res.status === 304) break;
      const location = res.headers.get("location");
      const next = hop < MAX_REDIRECT_HOPS ? allowedRedirect(url, location, call.redirectHosts) : null;
      await res.body?.cancel().catch(() => undefined);
      if (!next) {
        let where = "no Location";
        try { if (location) { const u = new URL(location, url); where = `${u.protocol}//${u.host}`; } } catch { where = "an unreadable Location"; }
        report(call, { url, status: res.status, body: "", note: hop < MAX_REDIRECT_HOPS ? `redirect refused (to ${where})` : "too many redirects" });
        return { kind: "fail", status: 502 };
      }
      url = next;
    }
    if (res.status === 304) return { kind: "not-modified", headers: res.headers };
    if (res.status === 429 || res.status >= 500 || !res.ok) {
      if (call.onError) report(call, { url, status: res.status, ...(await bodyStart(res, ERROR_BODY_BYTES)) });
      else await res.body?.cancel().catch(() => undefined);
    }
    if (res.status === 429 || res.status >= 500) return { kind: "retry", timeout: false, status: res.status };
    if (!res.ok) return { kind: "fail", status: res.status };
    // Only a complete 200 is a usable body: a 204 is empty and a 206 is a fragment.
    if (res.status !== 200) return { kind: "retry", timeout: false };
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > MAX_BODY_BYTES) return { kind: "retry", timeout: false };
    return { kind: "ok", bytes, contentType: res.headers.get("content-type") ?? "application/octet-stream", headers: res.headers };
  })();
  work.catch(() => undefined); // a late failure after the timeout must not become an unhandled rejection
  try {
    const first = await Promise.race([work, timedOut]);
    if (first === "timeout") report(call, { url, status: 0, body: "", note: `timeout after ${Math.round(budgetMs)} ms` });
    return first === "timeout" ? { kind: "retry", timeout: true } : first;
  } catch (e) {
    // undici says "fetch failed" and puts the reason (DNS, TLS, a refused redirect) in `cause`.
    const cause = e instanceof Error && e.cause instanceof Error ? `: ${e.cause.message}` : "";
    report(call, { url, status: 0, body: "", note: `network error (${e instanceof Error ? e.message : "unknown"}${cause})` });
    return { kind: "retry", timeout: false };
  } finally {
    clearTimeout(timer);
  }
}

type Stored = StoredEntry;

/** When the entry was fetched (ms): recorded in its metadata, else derived from its expiry. */
const fetchedAtOf = (c: Stored, ttlS: number): number => {
  const recorded = Number(c.meta?.fetchedAt);
  return Number.isFinite(recorded) && recorded > 0 ? recorded : c.expiresAt - ttlS * 1000;
};

/**
 * How long a provider response may be kept: at least `minS`, longer if the provider says so
 * (Cache-Control max-age, else Expires). Null for `no-store`: do not cache it at all
 * (OSM tile servers send max-age today, but if they ever send no-store we must not keep tiles).
 */
export function freshnessS(headers: Headers, minS: number, nowMs: number): number | null {
  const cc = (headers.get("cache-control") ?? "").toLowerCase();
  if (/(^|[\s,])no-store([\s,;=]|$)/.test(cc)) return null;
  let upstreamS = 0;
  const maxAge = /(?:^|[\s,])max-age=(\d+)/.exec(cc);
  if (maxAge) upstreamS = Number(maxAge[1]);
  else {
    const expires = Date.parse(headers.get("expires") ?? "");
    if (Number.isFinite(expires)) upstreamS = Math.max(0, (expires - nowMs) / 1000);
  }
  return Math.max(minS, Math.floor(upstreamS));
}

const metaOf = (headers: Headers, nowMs: number, previous?: EntryMeta): EntryMeta => {
  const etag = headers.get("etag") ?? previous?.etag;
  const lastModified = headers.get("last-modified") ?? previous?.lastModified;
  return { ...(etag ? { etag } : {}), ...(lastModified ? { lastModified } : {}), fetchedAt: String(nowMs) };
};

/** Read a cache entry; one older than keepS is deleted and reported as missing. */
async function readCache(ctx: Ctx, key: string, ttlS: number, keepS: number | undefined): Promise<Stored | null> {
  const cached = await ctx.deps.store.get(key);
  if (!cached) return null;
  if (keepS !== undefined && ctx.deps.now() > fetchedAtOf(cached, ttlS) + keepS * 1000) {
    await ctx.deps.store.delete(key);
    return null;
  }
  return cached;
}

const entryOf = (c: Stored, ttlS: number, extra: { stale: boolean; hit: boolean }): Entry => ({
  bytes: c.value, contentType: c.contentType, fetchedAt: fetchedAtOf(c, ttlS), ...(c.meta?.etag ? { etag: c.meta.etag } : {}), ...extra,
});

/** How long a mirror that just failed is tried last. */
const PENALTY_MS = 120_000;

/** Healthy URLs first (stable), then the ones that failed in the last two minutes. */
function byHealth(calls: readonly UpstreamCall[], ctx: Ctx): UpstreamCall[] {
  const at = ctx.deps.now();
  const bad = (c: UpstreamCall) => (ctx.health.get(c.url) ?? 0) > at;
  return [...calls.filter((c) => !bad(c)), ...calls.filter(bad)];
}

async function run(ctx: Ctx, spec: UpstreamSpec): Promise<Entry> {
  const { store, now } = ctx.deps;
  let cached = await readCache(ctx, spec.cacheKey, spec.ttlS, spec.keepS);
  if (cached && spec.validStored && !spec.validStored(cached.value)) {
    await store.delete(spec.cacheKey); // never serve, or keep alive with a 304, a body that isn't what it should be
    cached = null;
  }
  // Cache hits never take a slot.
  if (cached && cached.expiresAt > now()) return entryOf(cached, spec.ttlS, { stale: false, hit: true });

  let sawTimeout = false;
  let sawQuota: string | null = null;
  let failStatus: number | null = null;
  try {
    const ordered = byHealth(spec.calls, ctx);
    for (const [idx, call] of ordered.entries()) {
      if (ctx.deadline - now() < MIN_ATTEMPT_MS) { sawTimeout = true; break; }
      await takeSlots(ctx, call.service);
      if (call.quota) {
        try {
          await takeQuota(ctx, call.quota);
        } catch (e) {
          // No call is made: give the shared token back (the caller's own token covers its whole request).
          const base = call.service.split("-")[0] as Service;
          await store.returnToken?.(`global:${base}`, now(), burstOf(ctx.config, base).global).catch(() => undefined);
          throw e;
        }
      }
      const left = ctx.deadline - now();
      if (left < MIN_ATTEMPT_MS) { sawTimeout = true; break; }
      // With mirrors still to try, don't spend the whole deadline on this one.
      const isLast = idx === ordered.length - 1;
      const budget = isLast ? left : Math.min(left, Math.max(left / 2, FIRST_ATTEMPT_FLOOR_MS));
      // Expired but revalidatable: ask the provider whether it changed instead of downloading again.
      const validators: Record<string, string> = {};
      if (spec.httpCache && cached) {
        if (cached.meta?.etag) validators["If-None-Match"] = cached.meta.etag;
        else if (cached.meta?.lastModified) validators["If-Modified-Since"] = cached.meta.lastModified;
      }
      const sent = Object.keys(validators).length > 0 ? { ...call, init: { ...call.init, headers: { ...call.init?.headers, ...validators } } } : call;
      const result = await attempt(ctx, sent, budget);
      if (result.kind === "not-modified") {
        if (!cached || Object.keys(validators).length === 0) continue; // we sent no validators: a 304 makes no sense
        const refreshed = freshnessS(result.headers, spec.ttlS, now());
        if (refreshed === null) {
          // The provider now says no-store: serve the copy this once, but keep nothing.
          await store.delete(spec.cacheKey);
          return { ...entryOf(cached, spec.ttlS, { stale: false, hit: false }), fetchedAt: now(), noStore: true };
        }
        await store.set(spec.cacheKey, cached.value, cached.contentType, refreshed, metaOf(result.headers, now(), cached.meta));
        return { ...entryOf({ ...cached, expiresAt: now() + refreshed * 1000, meta: metaOf(result.headers, now(), cached.meta) }, spec.ttlS, { stale: false, hit: false }) };
      }
      if (result.kind === "retry") {
        if (result.status === 429 && call.quota) {
          // The provider's own limit: stop asking it for a while (every instance sees this entry).
          sawQuota = call.quota.key;
          await store.set(call.quota.cooldownKey, new Uint8Array([1]), "text/plain", call.quota.cooldownS);
        }
        if (ordered.length > 1) ctx.health.set(call.url, now() + PENALTY_MS);
        sawTimeout ||= result.timeout;
        // A slow provider with an old copy in hand: serve the copy now rather than spend the deadline on mirrors.
        if (result.timeout && cached) return entryOf(cached, spec.ttlS, { stale: true, hit: true });
        continue;
      }
      if (result.kind === "fail") {
        failStatus = result.status;
        break; // a 4xx won't change on another host
      }
      let body = { bytes: result.bytes, contentType: result.contentType };
      if (spec.process) {
        try {
          body = spec.process(result.bytes, result.contentType, call, now());
        } catch (e) {
          if (e instanceof BadUpstreamBody) {
            report(call, { url: call.url, status: 200, body: "", note: `unusable body (${e.message}; ${result.contentType}, ${result.bytes.byteLength} bytes)` });
            if (ordered.length > 1) ctx.health.set(call.url, now() + PENALTY_MS);
            continue;
          }
          throw e;
        }
      }
      ctx.health.delete(call.url);
      const meta = spec.httpCache ? metaOf(result.headers, now()) : undefined;
      const keepForS = spec.httpCache ? freshnessS(result.headers, spec.ttlS, now()) : spec.ttlS;
      if (keepForS !== null) await store.set(spec.cacheKey, body.bytes, body.contentType, keepForS, meta);
      else await store.delete(spec.cacheKey); // no-store: drop any copy we held from before
      return {
        bytes: body.bytes, contentType: body.contentType, fetchedAt: now(), stale: false, hit: false,
        ...(keepForS !== null && meta?.etag ? { etag: meta.etag } : {}),
        ...(keepForS === null ? { noStore: true } : {}),
      };
    }
  } catch (e) {
    // Busy (or anything unexpected): an old copy beats an error.
    if (cached) return entryOf(cached, spec.ttlS, { stale: true, hit: true });
    throw e;
  }
  if (cached) return entryOf(cached, spec.ttlS, { stale: true, hit: true });
  if (sawQuota !== null) throw new QuotaFailure(60, "provider", sawQuota);
  if (failStatus === 404) throw new ProxyFailure(404, { code: "not-found", message: NOT_FOUND_MESSAGE }, undefined, 404);
  if (sawTimeout && failStatus === null) throw new ProxyFailure(504, { code: "timeout", message: TIMEOUT_MESSAGES[ctx.topic], retryAfterS: 5 });
  throw new ProxyFailure(502, { code: "upstream", message: UPSTREAM_MESSAGES[ctx.topic], retryAfterS: 5 }, undefined, failStatus ?? undefined);
}

/**
 * Share one in-flight promise per key between concurrent callers, but only a success: a failure
 * (this caller's own rate limit, say) is not handed to anyone else; they try for themselves.
 */
async function singleFlight(ctx: Ctx, key: string, start: () => Promise<Entry>): Promise<Entry> {
  const pending = ctx.inflight.get(key);
  if (pending) {
    try {
      return await pending;
    } catch {
      // not ours to share: fall through and try on our own account
    }
  }
  const p = start().finally(() => { if (ctx.inflight.get(key) === p) ctx.inflight.delete(key); });
  if (!ctx.inflight.has(key)) ctx.inflight.set(key, p);
  return p;
}

/** Cached, rate-limited upstream fetch. Concurrent identical requests in this instance share one successful call. */
export function fetchUpstream(ctx: Ctx, spec: UpstreamSpec): Promise<Entry> {
  return singleFlight(ctx, spec.cacheKey, () => run(ctx, spec));
}

/**
 * A cached result built from several upstream calls (each cached on its own). Stale on failure;
 * a partial result is never cached, and `cache: false` from build keeps a degraded answer
 * (e.g. a fallback after an error) out of the cache. `stale: true` from build (it was made from expired
 * parts because the provider failed or was busy) is served as stale, dated by its oldest part (`fetchedAt`), and
 * not cached as fresh either.
 */
export function composite(
  ctx: Ctx, key: string, ttlS: number,
  build: () => Promise<{ bytes: Uint8Array; contentType: string; cache?: boolean; stale?: boolean; fetchedAt?: number }>,
  keepS?: number,
): Promise<Entry> {
  return singleFlight(ctx, key, async () => {
    const { store, now } = ctx.deps;
    const cached = await readCache(ctx, key, ttlS, keepS);
    if (cached && cached.expiresAt > now()) return entryOf(cached, ttlS, { stale: false, hit: true });
    try {
      const { cache = true, stale = false, fetchedAt, ...built } = await build();
      if (cache && !stale) await store.set(key, built.bytes, built.contentType, ttlS);
      // Built from expired parts: it is as old as the oldest of them (x-fetched-at says so).
      return { ...built, fetchedAt: stale && fetchedAt !== undefined ? fetchedAt : now(), stale, hit: stale };
    } catch (e) {
      if (cached) return entryOf(cached, ttlS, { stale: true, hit: true });
      throw e;
    }
  });
}
