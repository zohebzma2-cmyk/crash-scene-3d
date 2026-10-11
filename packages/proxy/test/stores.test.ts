import { describe, expect, it, vi } from "vitest";
import { kvOnBlobs, type BlobStoreLike } from "../src/blobs";
import { clientIp, hashUserKey, memoryStore } from "../src";
import { limitIdentity, resolveSalt } from "../src/userkey";

type Row = { data: string | ArrayBuffer; etag: string; metadata: Record<string, unknown> };

/** A Blobs-like store with real conditional-write semantics (ETags), yielding between steps so callers interleave. */
function fakeBlobs(cfg: { noEtagOnRead?: boolean } = {}) {
  const data = new Map<string, Row>();
  const log = { sets: 0, gets: 0, setOptions: [] as { onlyIfNew?: boolean; onlyIfMatch?: string }[] };
  let n = 0;
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));
  const store = {
    data, log,
    async getWithMetadata(key: string, opts: { type: "arrayBuffer" | "text" }) {
      log.gets++;
      await tick();
      const e = data.get(key);
      if (!e) return null;
      // Netlify's local sandbox (`netlify dev`) returns no ETag on reads, and treats onlyIfMatch "" as no condition.
      return { data: opts.type === "text" ? String(e.data) : (e.data as ArrayBuffer), ...(cfg.noEtagOnRead ? {} : { etag: e.etag }), metadata: e.metadata };
    },
    async set(key: string, value: string | ArrayBuffer, opts: { metadata?: Record<string, unknown>; onlyIfNew?: boolean; onlyIfMatch?: string } = {}) {
      log.sets++;
      log.setOptions.push({ ...(opts.onlyIfNew ? { onlyIfNew: true } : {}), ...(opts.onlyIfMatch !== undefined ? { onlyIfMatch: opts.onlyIfMatch } : {}) });
      await tick();
      const cur = data.get(key);
      if (opts.onlyIfNew && cur) return { modified: false };
      if (opts.onlyIfMatch !== undefined && opts.onlyIfMatch !== "" && (!cur || cur.etag !== opts.onlyIfMatch)) return { modified: false };
      const etag = `etag-${++n}`;
      data.set(key, { data: value, etag, metadata: opts.metadata ?? {} });
      return { modified: true, etag };
    },
    async delete(key: string) { data.delete(key); },
  };
  return store as typeof store & BlobStoreLike;
}

const DAY1 = Date.parse("2026-10-09T12:00:00Z");

function setupKv(startMs = DAY1) {
  const clock = { now: startMs };
  const cache = fakeBlobs();
  const slots = fakeBlobs();
  // Every dated store that exists, by real store name (what Blobs' listStores would return).
  const stores = new Map<string, ReturnType<typeof fakeBlobs>>();
  const named = (name: string) => { if (!stores.has(name)) stores.set(name, fakeBlobs()); return stores.get(name)!; };
  const deleted: string[] = [];
  const kv = kvOnBlobs({
    cache, slots,
    geoStore: (day) => named(`csd-proxy-geo-${day}`),
    userStore: (day) => named(`csd-proxy-user-${day}`),
    listStores: async () => [...stores.keys(), "csd-proxy-cache", "csd-proxy-slots"],
    deleteStore: async (name) => { deleted.push(name); stores.delete(name); },
    now: () => clock.now,
  });
  return { kv, cache, slots, stores, named, deleted, clock };
}

const BUCKET = { capacity: 5, refillPerS: 2 };

describe("Blobs-backed store", () => {
  it("round-trips a body with content type, expiry and validators, and keeps no readable key", async () => {
    const { kv, cache, named } = setupKv();
    expect(await kv.get("tile/15/1/1")).toBeNull();
    const before = DAY1;
    await kv.set("tile/15/1/1", new Uint8Array([1, 2, 3]), "image/png", 60, { etag: '"abc"', lastModified: "Mon, 01 Jan 2026 00:00:00 GMT", fetchedAt: "123" });
    const hit = (await kv.get("tile/15/1/1"))!;
    expect(Array.from(hit.value)).toEqual([1, 2, 3]);
    expect(hit.contentType).toBe("image/png");
    expect(hit.expiresAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(hit.meta).toEqual({ etag: '"abc"', lastModified: "Mon, 01 Jan 2026 00:00:00 GMT", fetchedAt: "123" });
    // Nothing about the query is stored: not in the blob name, not in the metadata.
    for (const [name, row] of cache.data) {
      expect(name).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(row.metadata)).not.toContain("secret");
    }
    await kv.delete("tile/15/1/1");
    expect(await kv.get("tile/15/1/1")).toBeNull();
    void named;
  });

  it("keeps anything typed or pinned (geo/ keys) in the store for the day, readable for 7 days, then gone", async () => {
    const { kv, stores, named, clock, cache } = setupKv();
    await kv.set("geo/search?q=secret street", new Uint8Array([7]), "application/json", 86_400);
    await kv.set("geo/overpass?lat=1&lon=2&radius=250", new Uint8Array([8]), "application/json", 86_400);
    expect([...stores.keys()]).toEqual(["csd-proxy-geo-20261009"]); // dated store, not the shared cache
    expect(cache.data.size).toBe(0);
    for (const [name, row] of named("csd-proxy-geo-20261009").data) {
      expect(name).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(row.metadata)).not.toContain("secret");
    }
    // Day 6 (the sixth day after): still readable.
    clock.now = DAY1 + 6 * 86_400_000;
    expect((await kv.get("geo/search?q=secret street"))!.value).toEqual(new Uint8Array([7]));
    // Day 7: out of the read window even if the sweep hasn't removed the store yet.
    clock.now = DAY1 + 7 * 86_400_000;
    expect(await kv.get("geo/search?q=secret street")).toBeNull();
    // A fresh write lands in the new day's store; the newest copy wins on read.
    await kv.set("geo/search?q=secret street", new Uint8Array([9]), "application/json", 86_400);
    expect((await kv.get("geo/search?q=secret street"))!.value).toEqual(new Uint8Array([9]));
    expect(stores.has("csd-proxy-geo-20261016")).toBe(true);
    // delete removes every day's copy.
    await kv.delete("geo/search?q=secret street");
    expect(await kv.get("geo/search?q=secret street")).toBeNull();
  });

  it("sweeps every geo store older than 7 days and every user store but today's, once per day", async () => {
    const { kv, named, deleted, clock } = setupKv();
    for (const n of ["csd-proxy-geo-20261001", "csd-proxy-geo-20261002", "csd-proxy-geo-20261003", "csd-proxy-geo-20261004",
      "csd-proxy-geo-20261008", "csd-proxy-user-20261007", "csd-proxy-user-20261008", "csd-proxy-user-20261001"]) named(n);
    await kv.get("geo/search?q=x");
    // Today is 20261009; geo kept: 20261003 .. 20261009. User: only 20261009.
    expect(deleted.sort()).toEqual(["csd-proxy-geo-20261001", "csd-proxy-geo-20261002", "csd-proxy-user-20261001", "csd-proxy-user-20261007", "csd-proxy-user-20261008"]);
    expect(deleted).not.toContain("csd-proxy-geo-20261003"); // exactly 7 days kept: 20261003 .. 20261009
    const count = deleted.length;
    await kv.set("geo/search?q=y", new Uint8Array([1]), "application/json", 60);
    expect(deleted).toHaveLength(count); // not again the same day
    clock.now = DAY1 + 86_400_000;
    await kv.set("geo/search?q=z", new Uint8Array([1]), "application/json", 60);
    expect(deleted).toContain("csd-proxy-geo-20261003"); // 20261010 keeps 20261004 onward
    expect(deleted).not.toContain("csd-proxy-geo-20261004");
  });

  it("never touches stores that aren't dated geo or user stores", async () => {
    const { kv, deleted } = setupKv();
    await kv.get("geo/x");
    expect(deleted.filter((n) => n === "csd-proxy-cache" || n === "csd-proxy-slots")).toEqual([]);
  });

  it("never deletes a later day's user store (a lagging or stepped-back clock at midnight)", async () => {
    // This instance still thinks it's 2026-10-09 23:59:59.980Z; others already use 20261010.
    const { kv, named, deleted } = setupKv(Date.parse("2026-10-09T23:59:59.980Z"));
    named("csd-proxy-user-20261010");
    named("csd-proxy-user-20261008");
    await kv.get("geo/search?q=x");
    expect(deleted).toContain("csd-proxy-user-20261008");
    expect(deleted).not.toContain("csd-proxy-user-20261010");
  });

  it("reads a failing day store as a miss, never a 500", async () => {
    const { kv, named } = setupKv();
    await kv.set("geo/search?q=ok", new Uint8Array([7]), "application/json", 60);
    const broken = named("csd-proxy-geo-20261007");
    broken.getWithMetadata = async () => { throw new Error("Blobs 503"); };
    broken.delete = async () => { throw new Error("Blobs 503"); };
    expect((await kv.get("geo/search?q=ok"))!.value).toEqual(new Uint8Array([7]));
    expect(await kv.get("geo/search?q=missing")).toBeNull();
    await expect(kv.delete("geo/search?q=ok")).resolves.toBeUndefined();
  });

  it("hands a slot to exactly one of many concurrent callers (onlyIfNew, then onlyIfMatch)", async () => {
    const { kv } = setupKv();
    const first = await Promise.all(Array.from({ length: 8 }, () => kv.takeSlot("global:overpass", 10_000, 1000)));
    expect(first.filter(Boolean)).toHaveLength(1);
    expect(await kv.takeSlot("global:overpass", 10_500, 1000)).toBe(false);
    const second = await Promise.all(Array.from({ length: 8 }, () => kv.takeSlot("global:overpass", 11_000, 1000)));
    expect(second.filter(Boolean)).toHaveLength(1);
    expect(await kv.takeSlot("global:overpass", 11_500, 1000)).toBe(false);
  });

  it("keeps slot keys independent", async () => {
    const { kv } = setupKv();
    expect(await kv.takeSlot("global:a", 0, 1000)).toBe(true);
    expect(await kv.takeSlot("global:b", 0, 1000)).toBe(true);
    expect(await kv.takeSlot("user:x:a", 0, 1000)).toBe(true);
  });

  it("token bucket: a concurrent burst gets exactly `capacity` tokens, in a few writes", async () => {
    const { kv, slots } = setupKv();
    const t = 1_700_000_000_000;
    const results = await Promise.all(Array.from({ length: 12 }, () => kv.takeToken("global:tiles", t, BUCKET)));
    expect(results.filter((r) => r === 0)).toHaveLength(5);
    const waits = results.filter((r) => r > 0);
    expect(waits).toHaveLength(7);
    expect(waits.every((w) => w > 0 && w <= 500)).toBe(true); // 2 tokens/s → 500 ms per token
    expect(slots.log.sets).toBeLessThanOrEqual(3); // batched, not one write per caller
    // Half a second later one more token has refilled.
    expect(await kv.takeToken("global:tiles", t + 500, BUCKET)).toBe(0);
    expect(await kv.takeToken("global:tiles", t + 500, BUCKET)).toBeGreaterThan(0);
  });

  it("token bucket: two instances sharing the blob never hand out more than capacity", async () => {
    const shared = fakeBlobs();
    const mk = () => kvOnBlobs({ cache: fakeBlobs(), slots: shared, geoStore: () => shared, userStore: () => shared, listStores: async () => [], deleteStore: async () => undefined });
    const a = mk();
    const b = mk();
    const t = 1_700_000_000_000;
    const results = await Promise.all([
      ...Array.from({ length: 6 }, () => a.takeToken("global:terrain", t, BUCKET)),
      ...Array.from({ length: 6 }, () => b.takeToken("global:terrain", t, BUCKET)),
    ]);
    expect(results.filter((r) => r === 0)).toHaveLength(5);
  });

  it("keeps per-user blobs in a store for the day and sweeps other days' user stores", async () => {
    const { kv, stores, slots, deleted, clock, named } = setupKv();
    named("csd-proxy-user-20261008");
    expect(await kv.takeSlot("user:abc:overpass", DAY1, 1000)).toBe(true);
    await kv.takeToken("user:abc:tiles", DAY1, BUCKET);
    expect([...stores.keys()]).toEqual(["csd-proxy-user-20261009"]);
    expect(slots.data.size).toBe(0); // nothing per-user in the global store
    expect(deleted).toEqual(["csd-proxy-user-20261008"]);
    await kv.takeSlot("user:abc:overpass", DAY1 + 5000, 1000);
    expect(deleted).toHaveLength(1); // swept once per day per instance
    const day2 = DAY1 + 86_400_000;
    clock.now = day2;
    await kv.takeSlot("user:def:overpass", day2, 1000);
    expect(deleted).toContain("csd-proxy-user-20261009");
    expect([...stores.keys()]).toEqual(["csd-proxy-user-20261010"]);
    // Global keys never touch the per-user stores.
    await kv.takeSlot("global:overpass", day2, 1000);
    expect(slots.data.size).toBe(1);
  });
});

describe("Blobs without ETags on read (Netlify's local sandbox)", () => {
  // Found live under `netlify dev`: reads carry no ETag, so a slot or bucket that already existed
  // could never be taken again and every later request got a 429 "busy" for good.
  const sandbox = () => {
    const slots = fakeBlobs({ noEtagOnRead: true });
    const kv = kvOnBlobs({ cache: fakeBlobs({ noEtagOnRead: true }), slots, geoStore: () => slots, userStore: () => fakeBlobs({ noEtagOnRead: true }),
      listStores: async () => [], deleteStore: async () => undefined, allowUnconditional: true });
    return kv;
  };

  it("a slot can be taken again once its interval has passed", async () => {
    const kv = sandbox();
    expect(await kv.takeSlot("global:nominatim", 10_000, 1000)).toBe(true);
    expect(await kv.takeSlot("global:nominatim", 10_500, 1000)).toBe(false);
    expect(await kv.takeSlot("global:nominatim", 11_000, 1000)).toBe(true);
    expect(await kv.takeSlot("global:nominatim", 12_000, 1000)).toBe(true);
    expect(await kv.takeSlot("user:abc:nominatim", 12_000, 1000)).toBe(true);
    expect(await kv.takeSlot("user:abc:nominatim", 13_500, 1000)).toBe(true);
  });

  it("a token bucket keeps working across calls", async () => {
    const kv = sandbox();
    const t = 1_700_000_000_000;
    expect(await kv.takeToken("global:tiles", t, BUCKET)).toBe(0);
    expect(await kv.takeToken("global:tiles", t + 100, BUCKET)).toBe(0);
    const burst = await Promise.all(Array.from({ length: 6 }, () => kv.takeToken("global:tiles", t + 200, BUCKET)));
    expect(burst.filter((r) => r === 0)).toHaveLength(3); // 5 capacity, 2 used, plus a little refill
    expect(burst.some((r) => r > 0)).toBe(true);
  });
});

describe("production: every rate-limit write is conditional", () => {
  const unconditional = (log: { setOptions: { onlyIfNew?: boolean; onlyIfMatch?: string }[] }) =>
    log.setOptions.filter((o) => !o.onlyIfNew && (o.onlyIfMatch === undefined || o.onlyIfMatch === ""));

  it("with a service that sends ETags, slots and buckets only ever write with onlyIfNew or onlyIfMatch", async () => {
    const slots = fakeBlobs();
    const user = fakeBlobs();
    const kv = kvOnBlobs({ cache: fakeBlobs(), slots, geoStore: () => fakeBlobs(), userStore: () => user, listStores: async () => [], deleteStore: async () => undefined });
    for (let i = 0; i < 4; i++) {
      await kv.takeSlot("global:overpass", 10_000 + i * 1500, 1000);
      await kv.takeSlot("user:abc:overpass", 10_000 + i * 1500, 1000);
      await Promise.all(Array.from({ length: 4 }, () => kv.takeToken("global:tiles", 20_000 + i * 700, BUCKET)));
    }
    expect(slots.log.sets + user.log.sets).toBeGreaterThan(8);
    expect(unconditional(slots.log)).toEqual([]);
    expect(unconditional(user.log)).toEqual([]);
  });

  it("with a service that sends NO ETag, it never writes blind: a slot answers busy and a bucket says try again", async () => {
    const slots = fakeBlobs({ noEtagOnRead: true });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const kv = kvOnBlobs({ cache: fakeBlobs(), slots, geoStore: () => fakeBlobs(), userStore: () => fakeBlobs(), listStores: async () => [], deleteStore: async () => undefined });
    expect(await kv.takeSlot("global:nominatim", 10_000, 1000)).toBe(true); // the first take creates the blob (onlyIfNew)
    expect(await kv.takeSlot("global:nominatim", 12_000, 1000)).toBe(false); // free, but there is no ETag to condition on
    expect(await kv.takeToken("global:tiles", 10_000, BUCKET)).toBe(0); // creating is fine
    expect(await kv.takeToken("global:tiles", 10_100, BUCKET)).toBe(250); // updating can't be done safely: try again shortly
    expect(unconditional(slots.log)).toEqual([]);
    expect(error).toHaveBeenCalled();
    expect(String(error.mock.calls[0]![0])).toMatch(/no ETag/i);
    error.mockRestore();
  });

  it("only netlify dev's flag lets a no-ETag read be written over", async () => {
    const slots = fakeBlobs({ noEtagOnRead: true });
    const dev = kvOnBlobs({ cache: fakeBlobs(), slots, geoStore: () => fakeBlobs(), userStore: () => fakeBlobs(), listStores: async () => [], deleteStore: async () => undefined, allowUnconditional: true });
    expect(await dev.takeSlot("global:a", 0, 1000)).toBe(true);
    expect(await dev.takeSlot("global:a", 2000, 1000)).toBe(true);
    expect(unconditional(slots.log)).toHaveLength(1);
  });
});

describe("memory store", () => {
  it("stores bodies with an expiry and validators, books slots, and deletes", async () => {
    let now = 1_000;
    const kv = memoryStore({ now: () => now });
    await kv.set("k", new Uint8Array([9]), "text/plain", 5, { etag: "e" });
    expect((await kv.get("k"))!.expiresAt).toBe(6_000);
    expect((await kv.get("k"))!.meta).toEqual({ etag: "e" });
    expect(await kv.takeSlot("s", 1_000, 1000)).toBe(true);
    expect(await kv.takeSlot("s", 1_999, 1000)).toBe(false);
    now = 2_000;
    expect(await kv.takeSlot("s", 2_000, 1000)).toBe(true);
    await kv.delete("k");
    expect(await kv.get("k")).toBeNull();
  });

  it("token bucket: starts full, refills over time, reports the wait", async () => {
    const kv = memoryStore();
    const lim = { capacity: 3, refillPerS: 2 };
    expect(await kv.takeToken("b", 0, lim)).toBe(0);
    expect(await kv.takeToken("b", 0, lim)).toBe(0);
    expect(await kv.takeToken("b", 0, lim)).toBe(0);
    expect(await kv.takeToken("b", 0, lim)).toBe(500);
    expect(await kv.takeToken("b", 250, lim)).toBe(250);
    expect(await kv.takeToken("b", 500, lim)).toBe(0);
    expect(await kv.takeToken("b", 10_000, lim)).toBe(0); // refill is capped at capacity, never above
    expect(await kv.takeToken("b", 10_000, lim)).toBe(0);
    expect(await kv.takeToken("b", 10_000, lim)).toBe(0);
    expect(await kv.takeToken("b", 10_000, lim)).toBeGreaterThan(0);
  });
});

describe("user key", () => {
  it("is a one-way hash that changes daily and never contains the IP", () => {
    const day1 = Date.parse("2026-10-09T12:00:00Z");
    const day2 = Date.parse("2026-10-10T12:00:00Z");
    const k1 = hashUserKey("203.0.113.7", day1, "s");
    expect(k1).toMatch(/^[0-9a-f]{32}$/);
    expect(k1).not.toContain("203");
    expect(hashUserKey("203.0.113.7", day1 + 3_600_000, "s")).toBe(k1);
    expect(hashUserKey("203.0.113.7", day2, "s")).not.toBe(k1);
    expect(hashUserKey("203.0.113.8", day1, "s")).not.toBe(k1);
    expect(hashUserKey("203.0.113.7", day1, "other")).not.toBe(k1);
  });

  it("keys IPv6 callers by their /64", () => {
    const day = Date.parse("2026-10-09T12:00:00Z");
    expect(limitIdentity("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:0db8:0001:0002/64");
    expect(limitIdentity("2001:db8:1:2::1")).toBe("2001:0db8:0001:0002/64");
    expect(limitIdentity("2001:DB8:1:2:ffff:ffff:ffff:ffff")).toBe("2001:0db8:0001:0002/64");
    expect(limitIdentity("2001:db8::1")).toBe("2001:0db8:0000:0000/64");
    expect(limitIdentity("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(limitIdentity("203.0.113.7")).toBe("203.0.113.7");
    expect(hashUserKey("2001:db8:1:2:1:2:3:4", day, "s")).toBe(hashUserKey("2001:db8:1:2:ffff::9", day, "s"));
    expect(hashUserKey("2001:db8:1:3:1:2:3:4", day, "s")).not.toBe(hashUserKey("2001:db8:1:2:1:2:3:4", day, "s"));
  });

  it("reads the Netlify client IP header, then x-forwarded-for", () => {
    expect(clientIp(new Request("https://a.test", { headers: { "x-nf-client-connection-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9" } }))).toBe("1.2.3.4");
    expect(clientIp(new Request("https://a.test", { headers: { "x-forwarded-for": "9.9.9.9, 8.8.8.8" } }))).toBe("9.9.9.9");
    expect(clientIp(new Request("https://a.test"))).toBe("unknown");
  });

  it("requires a salt in production, and allows none only locally", () => {
    expect(resolveSalt({ PROXY_USER_SALT: "s3cret" })).toEqual({ ok: true, salt: "s3cret" });
    expect(resolveSalt({})).toEqual({ ok: false });
    expect(resolveSalt({ PROXY_USER_SALT: "", NODE_ENV: "production" })).toEqual({ ok: false });
    expect(resolveSalt({ NETLIFY_DEV: "true" })).toEqual({ ok: true, salt: "" });
    expect(resolveSalt({ NETLIFY_LOCAL_MEMORY_STORE: "1" })).toEqual({ ok: true, salt: "" });
    expect(resolveSalt({ VITEST: "true" })).toEqual({ ok: true, salt: "" });
  });
});

describe("reserveSlot: a queue of one every interval, refused past maxWait", () => {
  for (const [label, make] of [["memory", () => memoryStore()], ["blobs", () => setupKv().kv]] as const) {
    it(`${label}: books back to back, refuses beyond the wait without booking, shares takeSlot's booking`, async () => {
      const kv = make();
      const t = DAY1;
      expect(await kv.reserveSlot("user:u:overpass", t, 1000, 2000)).toBe(t);
      expect(await kv.reserveSlot("user:u:overpass", t, 1000, 2000)).toBe(t + 1000);
      expect(await kv.reserveSlot("user:u:overpass", t, 1000, 2000)).toBe(t + 2000);
      expect(await kv.reserveSlot("user:u:overpass", t, 1000, 2000)).toBeNull();
      expect(await kv.reserveSlot("user:u:overpass", t + 1500, 1000, 2000)).toBe(t + 3000); // the refusal booked nothing
      expect(await kv.takeSlot("user:u:overpass", t + 3500, 1000)).toBe(false);
      expect(await kv.reserveSlot("user:v:overpass", t, 1000, 0)).toBe(t); // free now: no wait needed
    });
  }

  it("blobs: concurrent reservations never share a start", async () => {
    const { kv } = setupKv();
    const got = await Promise.all(Array.from({ length: 6 }, () => kv.reserveSlot("user:u:overpass", DAY1, 1000, 2000)));
    const starts = got.filter((s): s is number => s !== null);
    expect(new Set(starts).size).toBe(starts.length);
    expect(starts.length).toBeLessThanOrEqual(3);
    expect(starts.length).toBeGreaterThanOrEqual(1);
  });
});
