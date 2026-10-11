// KvStore on Netlify Blobs. Server-only (imports @netlify/blobs); not re-exported from index.
//
// Cache entries: one blob per key (name = SHA-256 of the key), contentType and expiresAt in the
// metadata. Nothing readable about what was searched is stored: no key, no query text.
//
// Request slots (1 req/s routes) and token buckets (tile routes): one tiny blob per key, written
// with conditional writes (onlyIfNew / onlyIfMatch on the ETag) so exactly one of several
// concurrent callers wins, across function instances. Concurrent token takers in one instance
// are batched into a single read-modify-write, so a 40-tile burst costs a handful of Blobs
// requests, not 40 polling loops.
//
// Privacy and retention:
//  - Anything built from what people typed or pinned (cache keys starting "geo/": address
//    searches, crossings, and the Overpass data around a pin) is written to a store named for the
//    UTC day, csd-proxy-geo-YYYYMMDD. Reads look in today's store and the six before it, so an
//    entry lives at most 7 days whether or not anyone reads it again.
//  - Per-user rate blobs live in csd-proxy-user-YYYYMMDD (their keys also hash the day in).
//  - When an instance first needs a dated store on a new day, it lists the stores and deletes
//    every csd-proxy-geo-* older than 7 days and every csd-proxy-user-* except today's, so
//    nothing builds up even if a day is missed.
//
// Caveats:
//  - Times come from each instance's own clock (Date.now()). Instances can differ by tens of
//    milliseconds, which can let two calls land slightly closer than the interval. Fine at 1 s;
//    not a hard real-time guarantee.
//  - Expired non-geo entries (tiles, vPIC) are kept: stale-on-error needs them, and they hold no
//    typed or pinned data. They are never listed or deleted by the sweep.
//  - Global slot blobs and cache blobs are small and bounded by the number of distinct keys.
import { createHash } from "node:crypto";
import { getStore, listStores } from "@netlify/blobs";
import type { BucketLimit } from "@csd/core";
import { msUntilToken, refillBucket, type EntryMeta, type KvStore } from "./types";

type Meta = Record<string, unknown>;

/** The slice of the Blobs Store API we use (so tests can pass a fake). */
export interface BlobStoreLike {
  getWithMetadata(key: string, opts: { type: "arrayBuffer" }): Promise<{ data: ArrayBuffer; etag?: string; metadata: Meta } | null>;
  getWithMetadata(key: string, opts: { type: "text" }): Promise<{ data: string; etag?: string; metadata: Meta } | null>;
  set(key: string, data: string | ArrayBuffer, opts?: { metadata?: Meta; onlyIfNew?: boolean; onlyIfMatch?: string }): Promise<{ modified: boolean; etag?: string }>;
  delete(key: string): Promise<void>;
}

export const GEO_STORE_PREFIX = "csd-proxy-geo-";
export const USER_STORE_PREFIX = "csd-proxy-user-";
/** Days a geo entry may live: today's store plus the six before it. */
export const GEO_RETENTION_DAYS = 7;

export interface BlobsParts {
  /** Entries that hold no typed or pinned data (tiles, terrain, vPIC). */
  readonly cache: BlobStoreLike;
  /** Global slots and buckets. */
  readonly slots: BlobStoreLike;
  /** Entries built from typed text or a pin: one store per UTC day (YYYYMMDD). */
  readonly geoStore: (day: string) => BlobStoreLike;
  /** Per-user slots and buckets: one store per UTC day (YYYYMMDD). */
  readonly userStore: (day: string) => BlobStoreLike;
  /** Names of all stores (for the sweep). */
  readonly listStores: () => Promise<string[]>;
  readonly deleteStore: (name: string) => Promise<void>;
  /** Clock, ms; defaults to Date.now. */
  readonly now?: () => number;
  /**
   * Only for `netlify dev`, whose local Blobs sandbox returns no ETag on reads: write slots and buckets
   * without a condition when a read carried no ETag. Everywhere else leave this false: a missing ETag
   * is then a compare-and-swap conflict (retried, then reported busy), because an unconditional
   * write would let two function instances both "win" the same slot and break the 1 req/s limit.
   */
  readonly allowUnconditional?: boolean;
}

/**
 * Write `text` only if the blob is still as we read it (`cur`, null = it didn't exist). Every write
 * here is conditional (onlyIfNew / onlyIfMatch) except in one case, below.
 *
 * `netlify dev`'s local Blobs sandbox returns no ETag on reads, and there `onlyIfMatch` can't be
 * used (an empty ETag means "no condition"), so with `allowUnconditional` (set only under
 * NETLIFY_DEV=true) the write goes through without a condition: last writer wins, which is safe
 * inside the one process a sandbox is. Without it, a missing ETag is reported as `noEtag` and the
 * caller treats it as a conflict (retry, then busy) rather than risk two instances both winning.
 */
async function writeIfUnchanged(
  store: BlobStoreLike, name: string, text: string, cur: { etag?: string } | null, allowUnconditional: boolean,
): Promise<{ modified: boolean; noEtag?: boolean }> {
  if (!cur) return store.set(name, text, { onlyIfNew: true });
  if (cur.etag) return store.set(name, text, { onlyIfMatch: cur.etag });
  if (allowUnconditional) return store.set(name, text);
  return { modified: false, noEtag: true };
}



const blobKey = (key: string) => createHash("sha256").update(key).digest("hex");
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10).replaceAll("-", "");
const shiftDay = (ms: number, days: number) => dayOf(ms - days * 86_400_000);
const CAS_ATTEMPTS = 5;

interface Waiter { readonly nowMs: number; readonly resolve: (retryInMs: number) => void }

export function kvOnBlobs(parts: BlobsParts): KvStore {
  const { cache } = parts;
  const allowUnconditional = parts.allowUnconditional === true;
  /** Said once per store: the real service always sends ETags, so a missing one means something is wrong. */
  let reportedNoEtag = false;
  const reportNoEtag = () => {
    if (reportedNoEtag) return;
    reportedNoEtag = true;
    console.error("proxy: Blobs returned no ETag for a rate-limit blob; refusing an unconditional write. Rate-limited calls will answer busy.");
  };
  const clock = parts.now ?? Date.now;
  const isGeo = (key: string) => key.startsWith("geo/");
  const queues = new Map<string, { limit: BucketLimit; waiters: Waiter[]; running: boolean; store: BlobStoreLike }>();
  let lastSweep = "";

  /** Once per UTC day per instance: delete geo stores older than 7 days and user stores from other days. */
  const sweep = async (nowMs: number): Promise<void> => {
    const today = dayOf(nowMs);
    if (today === lastSweep) return;
    lastSweep = today;
    const oldestKept = shiftDay(nowMs, GEO_RETENTION_DAYS - 1);
    const run = async () => {
      const doomed = (await parts.listStores()).filter((name) => {
        const geo = name.startsWith(GEO_STORE_PREFIX) ? name.slice(GEO_STORE_PREFIX.length) : null;
        const user = name.startsWith(USER_STORE_PREFIX) ? name.slice(USER_STORE_PREFIX.length) : null;
        if (geo !== null) return /^\d{8}$/.test(geo) && geo < oldestKept;
        // Strictly older days only: an instance whose clock lags (or steps back) must never delete
        // a store other instances already use as today's.
        return user !== null && /^\d{8}$/.test(user) && user < today;
      });
      await Promise.all(doomed.map((name) => parts.deleteStore(name).catch(() => undefined)));
    };
    // Never let housekeeping hold a request for more than a moment.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([run().catch(() => undefined), new Promise<void>((r) => { timer = setTimeout(r, 1500); })]);
    clearTimeout(timer);
  };

  const storeFor = async (key: string, nowMs: number): Promise<BlobStoreLike> => {
    if (!key.startsWith("user:")) return parts.slots;
    await sweep(nowMs);
    return parts.userStore(dayOf(nowMs));
  };

  /** The stores a geo entry may be in, newest day first. */
  const geoStores = (nowMs: number) => Array.from({ length: GEO_RETENTION_DAYS }, (_, i) => parts.geoStore(shiftDay(nowMs, i)));

  const parse = (text: string): { tokens: number; at: number } | null => {
    const [t, a] = text.split(",").map(Number);
    return Number.isFinite(t) && Number.isFinite(a) ? { tokens: t as number, at: a as number } : null;
  };

  /** One batch: read the bucket, hand out as many tokens as there are takers, write once. */
  async function serve(store: BlobStoreLike, name: string, limit: BucketLimit, waiters: Waiter[]): Promise<void> {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const cur = await store.getWithMetadata(name, { type: "text" });
      const now = Math.max(...waiters.map((w) => w.nowMs));
      const s = refillBucket(cur ? parse(cur.data) : null, now, limit);
      const grants = Math.min(waiters.length, Math.floor(s.tokens));
      const left = s.tokens - grants;
      const retryIn = msUntilToken(left, limit);
      if (grants === 0) {
        waiters.forEach((w) => w.resolve(retryIn)); // nothing to write: the stored state still refills correctly
        return;
      }
      const text = `${left},${now}`;
      const res = await writeIfUnchanged(store, name, text, cur, allowUnconditional);
      if (res.modified) {
        waiters.forEach((w, i) => w.resolve(i < grants ? 0 : retryIn));
        return;
      }
      if (res.noEtag) reportNoEtag();
      // Another instance changed the bucket between our read and write (or no ETag came back): read again.
    }
    waiters.forEach((w) => w.resolve(250));
  }

  async function drain(name: string): Promise<void> {
    const q = queues.get(name);
    if (!q) return;
    q.running = true;
    try {
      while (q.waiters.length > 0) {
        const batch = q.waiters.splice(0, q.waiters.length);
        try {
          await serve(q.store, name, q.limit, batch);
        } catch {
          batch.forEach((w) => w.resolve(250)); // Blobs hiccup: report "try again shortly", never throw into a request
        }
      }
    } finally {
      queues.delete(name);
    }
  }

  return {
    async get(key) {
      let hit: { data: ArrayBuffer; etag?: string; metadata: Meta } | null;
      if (isGeo(key)) {
        await sweep(clock());
        // A failing day store reads as a miss for that day, never as a 500 for the user.
        const found = await Promise.all(geoStores(clock()).map((s) => s.getWithMetadata(blobKey(key), { type: "arrayBuffer" }).catch(() => null)));
        hit = found.find((h) => h !== null) ?? null; // newest day first
      } else {
        hit = await cache.getWithMetadata(blobKey(key), { type: "arrayBuffer" });
      }
      if (!hit) return null;
      const { contentType, expiresAt, meta } = hit.metadata;
      if (typeof contentType !== "string" || typeof expiresAt !== "number") return null;
      return { value: new Uint8Array(hit.data), contentType, expiresAt, ...(meta && typeof meta === "object" ? { meta: meta as EntryMeta } : {}) };
    },
    async set(key, value, contentType, ttlS, meta) {
      const buf = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
      const opts = { metadata: { contentType, expiresAt: clock() + ttlS * 1000, ...(meta ? { meta } : {}) } };
      if (isGeo(key)) {
        await sweep(clock());
        await parts.geoStore(dayOf(clock())).set(blobKey(key), buf, opts);
      } else {
        await cache.set(blobKey(key), buf, opts);
      }
    },
    async delete(key) {
      if (isGeo(key)) await Promise.all(geoStores(clock()).map((s) => s.delete(blobKey(key)).catch(() => undefined)));
      else await cache.delete(blobKey(key));
    },
    async takeSlot(key, nowMs, intervalMs) {
      const store = await storeFor(key, nowMs);
      const name = blobKey(`slot:${key}`);
      const until = String(nowMs + intervalMs);
      for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
        const cur = await store.getWithMetadata(name, { type: "text" });
        if (cur && Number(cur.data) > nowMs) return false;
        // Free (or never taken): win only if nobody changed it since we read it.
        const res = await writeIfUnchanged(store, name, until, cur, allowUnconditional);
        if (!res.noEtag) return res.modified;
        reportNoEtag(); // no ETag came back: read again, and in the end answer busy rather than write blind
      }
      return false;
    },
    async reserveSlot(key, nowMs, intervalMs, maxWaitMs) {
      // Same blob as takeSlot (it holds the end of the last booking), so both share one queue.
      const store = await storeFor(key, nowMs);
      const name = blobKey(`slot:${key}`);
      for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
        const cur = await store.getWithMetadata(name, { type: "text" });
        const booked = Number(cur?.data ?? 0);
        const start = Math.max(nowMs, Number.isFinite(booked) ? booked : 0);
        if (start - nowMs > maxWaitMs) return null;
        const res = await writeIfUnchanged(store, name, String(start + intervalMs), cur, allowUnconditional);
        if (res.modified) return start;
        if (res.noEtag) reportNoEtag();
        // Someone else booked in between (or no ETag came back): read again; in the end answer busy rather than write blind.
      }
      return null;
    },
    async takeToken(key, nowMs, limit) {
      const store = await storeFor(key, nowMs);
      const name = blobKey(`bucket:${key}`);
      return new Promise<number>((resolve) => {
        let q = queues.get(name);
        if (!q) {
          q = { limit, waiters: [], running: false, store };
          queues.set(name, q);
        }
        q.waiters.push({ nowMs, resolve });
        if (!q.running) void drain(name);
      });
    },
    async returnToken(key, nowMs, limit) {
      // Best effort: one conditional read-modify-write, retried on a conflict; never above capacity.
      const store = await storeFor(key, nowMs);
      const name = blobKey(`bucket:${key}`);
      for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
        const cur = await store.getWithMetadata(name, { type: "text" });
        if (!cur) return; // never taken from: already full
        const s = refillBucket(parse(cur.data), nowMs, limit);
        const res = await writeIfUnchanged(store, name, `${Math.min(limit.capacity, s.tokens + 1)},${s.at}`, cur, allowUnconditional);
        if (res.modified) return;
        if (res.noEtag) { reportNoEtag(); return; }
      }
    },
  };
}

/** Production store: Netlify Blobs with strong consistency (opened on first use). */
export function blobsStore(): KvStore {
  let kv: KvStore | undefined;
  const open = (name: string) => getStore({ name, consistency: "strong" }) as unknown as BlobStoreLike;
  const real = () =>
    (kv ??= kvOnBlobs({
      cache: open("csd-proxy-cache"),
      slots: open("csd-proxy-slots"),
      geoStore: (day) => open(`${GEO_STORE_PREFIX}${day}`),
      userStore: (day) => open(`${USER_STORE_PREFIX}${day}`),
      listStores: async () => {
        const names: string[] = [];
        for await (const page of listStores({ paginate: true })) names.push(...page.stores);
        return names;
      },
      deleteStore: async (name) => { await getStore({ name, consistency: "strong" }).deleteAll(); },
      // Only netlify dev's local sandbox lacks ETags; production keeps every write conditional.
      allowUnconditional: process.env.NETLIFY_DEV === "true",
    }));
  return {
    get: (key) => real().get(key),
    set: (key, value, contentType, ttlS, meta) => real().set(key, value, contentType, ttlS, meta),
    delete: (key) => real().delete(key),
    takeSlot: (key, nowMs, intervalMs) => real().takeSlot(key, nowMs, intervalMs),
    reserveSlot: (key, nowMs, intervalMs, maxWaitMs) => real().reserveSlot(key, nowMs, intervalMs, maxWaitMs),
    takeToken: (key, nowMs, limit) => real().takeToken(key, nowMs, limit),
    returnToken: (key, nowMs, limit) => real().returnToken?.(key, nowMs, limit) ?? Promise.resolve(),
  };
}
