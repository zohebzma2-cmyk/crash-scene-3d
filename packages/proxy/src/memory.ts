import { msUntilToken, refillBucket, type KvStore, type StoredEntry } from "./types";

const MAX_ENTRIES = 5000;

/**
 * In-memory KvStore for tests and local dev. `now` defaults to Date.now (so vitest fake timers
 * apply); pass your own clock when tests drive time by hand.
 */
export function memoryStore(opts: { now?: () => number } = {}): KvStore {
  const now = opts.now ?? Date.now;
  const entries = new Map<string, StoredEntry>();
  const slots = new Map<string, number>();
  const buckets = new Map<string, { tokens: number; at: number }>();
  return {
    get(key) {
      return Promise.resolve(entries.get(key) ?? null);
    },
    set(key, value, contentType, ttlS, meta) {
      entries.delete(key); // re-insert so the oldest entry is first
      entries.set(key, { value: value.slice(), contentType, expiresAt: now() + ttlS * 1000, ...(meta ? { meta } : {}) });
      if (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value as string);
      return Promise.resolve();
    },
    delete(key) {
      entries.delete(key);
      return Promise.resolve();
    },
    takeSlot(key, nowMs, intervalMs) {
      // No await between the check and the write, so this is atomic within one process.
      const busyUntil = slots.get(key) ?? 0;
      if (busyUntil > nowMs) return Promise.resolve(false);
      slots.set(key, nowMs + intervalMs);
      if (slots.size > MAX_ENTRIES) for (const [k, until] of slots) if (until <= nowMs) slots.delete(k);
      return Promise.resolve(true);
    },
    reserveSlot(key, nowMs, intervalMs, maxWaitMs) {
      // Same as takeSlot: no await between the read and the write.
      const start = Math.max(nowMs, slots.get(key) ?? 0);
      if (start - nowMs > maxWaitMs) return Promise.resolve(null);
      slots.set(key, start + intervalMs);
      return Promise.resolve(start);
    },
    takeToken(key, nowMs, limit) {
      const state = refillBucket(buckets.get(key) ?? null, nowMs, limit);
      if (state.tokens < 1) {
        buckets.set(key, state);
        return Promise.resolve(msUntilToken(state.tokens, limit));
      }
      buckets.set(key, { tokens: state.tokens - 1, at: state.at });
      if (buckets.size > MAX_ENTRIES) for (const [k, b] of buckets) if (b.tokens >= limit.capacity || nowMs - b.at > 60_000) buckets.delete(k);
      return Promise.resolve(0);
    },
  };
}
