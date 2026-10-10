// Shared proxy types. KvStore and ProxyDeps are the injection points: Netlify Blobs in
// production, the memory store in tests and local dev.
import type { BucketLimit } from "@csd/core";

/** Validators from the provider and when we fetched the body; lets us revalidate instead of re-downloading. */
export interface EntryMeta {
  readonly etag?: string;
  readonly lastModified?: string;
  /** ms since epoch, as a string. */
  readonly fetchedAt?: string;
}

export interface StoredEntry {
  readonly value: Uint8Array;
  readonly contentType: string;
  readonly expiresAt: number;
  readonly meta?: EntryMeta;
}

/** Key-value store with TTL (Netlify Blobs in production, memory in tests). */
export interface KvStore {
  /** The entry, even when `expiresAt` has passed (the proxy decides between fresh and stale). */
  get(key: string): Promise<StoredEntry | null>;
  /** `meta` is small string metadata kept with the entry (HTTP validators and the fetch time). */
  set(key: string, value: Uint8Array, contentType: string, ttlS: number, meta?: EntryMeta): Promise<void>;
  /** Remove an entry (used to drop stale copies of what people searched for). */
  delete(key: string): Promise<void>;
  /** Atomically take the next request slot: true if `key` was free at `nowMs`, and books it until nowMs + intervalMs. */
  takeSlot(key: string, nowMs: number, intervalMs: number): Promise<boolean>;
  /**
   * Take one token from the bucket `key` (full at first; refills at limit.refillPerS up to
   * limit.capacity). Returns 0 when a token was taken, else the milliseconds until one will be available.
   */
  takeToken(key: string, nowMs: number, limit: BucketLimit): Promise<number>;
}

export interface ProxyDeps {
  readonly fetch: typeof globalThis.fetch;
  readonly store: KvStore;
  readonly now: () => number;
  /** One-way hash of the caller (e.g. IP + daily salt) for per-user limits; never stored raw. */
  readonly userKey: (req: Request) => string;
  /**
   * Fixtures mode for map tiles: when set, /api/geo/tile is answered from this lookup (captured files)
   * and a neutral "no tile" PNG outside the captured area. Nothing is fetched from a tile server.
   */
  readonly fixtureTiles?: (z: number, x: number, y: number) => Uint8Array | null | Promise<Uint8Array | null>;
}

/** The bucket arithmetic, shared by the memory and Blobs stores. */
export function refillBucket(state: { tokens: number; at: number } | null, nowMs: number, limit: BucketLimit): { tokens: number; at: number } {
  if (!state) return { tokens: limit.capacity, at: nowMs };
  const elapsedS = Math.max(0, nowMs - state.at) / 1000;
  return { tokens: Math.min(limit.capacity, state.tokens + elapsedS * limit.refillPerS), at: nowMs };
}

/** ms until `tokens` reaches 1 at the given refill rate. */
export function msUntilToken(tokens: number, limit: BucketLimit): number {
  return Math.max(1, Math.ceil(((1 - tokens) / limit.refillPerS) * 1000));
}
