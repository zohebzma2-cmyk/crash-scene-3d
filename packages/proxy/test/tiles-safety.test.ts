import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROXY_ROUTES, type ProxyError } from "@csd/core";
import { START, settle, setup } from "./helpers";

beforeEach(() => { vi.useFakeTimers({ now: START }); });
afterEach(() => { vi.useRealTimers(); });

const DAY_MS = 86_400_000;
const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG = new Uint8Array([...SIG, 1, 2, 3, 4]);
const TILE = `${PROXY_ROUTES.tile}/15/9878/12070.png`;
const KEY = "tile/15/9878/12070";
const png = (headers: Record<string, string> = {}, bytes: Uint8Array = PNG, status = 200) =>
  new Response(bytes as BodyInit, { status, headers: { "content-type": "image/png", ...headers } });

describe("only a real 200 PNG is cached or relayed", () => {
  it("refuses an HTML body labelled image/png", async () => {
    const t = setup(() => png({ etag: '"x"' }, new TextEncoder().encode("<html>rate limited</html>")));
    const res = await settle(t.get(TILE));
    expect(res.status).toBe(502);
    expect(await t.store.get(KEY)).toBeNull();
  });

  it("refuses a 0-byte 200 with an ETag, so a later 304 can't keep it alive", async () => {
    const t = setup(() => png({ etag: '"empty"' }, new Uint8Array(0)));
    const res = await settle(t.get(TILE));
    expect(res.status).toBe(502);
    expect(await t.store.get(KEY)).toBeNull();
  });

  it("refuses a 206 partial body even when it starts like a PNG", async () => {
    const t = setup(() => png({ "content-range": "bytes 0-11/9999" }, PNG, 206));
    const res = await settle(t.get(TILE));
    expect(res.status).toBe(502);
    expect(await t.store.get(KEY)).toBeNull();
  });

  it("refuses a 204 too", async () => {
    const t = setup(() => new Response(null, { status: 204, headers: { "content-type": "image/png" } }));
    expect((await settle(t.get(TILE))).status).toBe(502);
    expect(await t.store.get(KEY)).toBeNull();
  });

  it("drops a stored empty entry (even with an ETag) and fetches the full tile instead of revalidating it", async () => {
    const t = setup((c) => (c.headers.get("if-none-match") ? new Response(null, { status: 304 }) : png({ etag: '"v1"' })));
    await t.store.set(KEY, new Uint8Array(0), "image/png", 30 * 86_400, { etag: '"empty"', fetchedAt: String(START) });
    await vi.advanceTimersByTimeAsync(31 * DAY_MS); // expired, so a conditional request would be sent
    const res = await settle(t.get(TILE));
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.headers.get("if-none-match")).toBeNull(); // a full fetch, not a revalidation
    expect((await t.store.get(KEY))!.value).toEqual(PNG);
  });

  it("drops a stored HTML entry that is still 'fresh' instead of serving it", async () => {
    const t = setup(() => png());
    await t.store.set(KEY, new TextEncoder().encode("<html>"), "image/png", 7 * 86_400, { fetchedAt: String(START) });
    const res = await settle(t.get(TILE));
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    expect(t.calls).toHaveLength(1);
  });
});

describe("Cache-Control: no-store, every case", () => {
  it("passes no-store on to the browser instead of a public max-age, and stores nothing", async () => {
    const t = setup(() => png({ etag: '"v1"', "cache-control": "no-store" }));
    const res = await settle(t.get(TILE));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await t.store.get(KEY)).toBeNull();
  });

  it("does not answer the browser's If-None-Match with a cacheable 304 when upstream said no-store", async () => {
    const t = setup(() => png({ etag: '"v1"', "cache-control": "no-store" }));
    const res = await t.proxy(new Request(`https://app.test${TILE}`, { headers: { "x-user": "u", "if-none-match": '"v1"' } }));
    await vi.advanceTimersByTimeAsync(100);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("deletes a stored copy when a later 200 says no-store", async () => {
    let noStore = false;
    const t = setup(() => (noStore ? png({ "cache-control": "no-store" }) : png({ etag: '"v1"' })));
    await settle(t.get(TILE, "u1"));
    expect(await t.store.get(KEY)).not.toBeNull();
    noStore = true;
    await vi.advanceTimersByTimeAsync(8 * DAY_MS);
    const res = await settle(t.get(TILE, "u2"));
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await t.store.get(KEY)).toBeNull();
  });

  it("deletes the stored copy when a 304 says no-store, serves it once, and never re-stores it", async () => {
    let noStore = false;
    const t = setup((c) => (c.headers.get("if-none-match") ? new Response(null, { status: 304, headers: noStore ? { "cache-control": "no-store" } : {} }) : png({ etag: '"v1"' })));
    await settle(t.get(TILE, "u1"));
    noStore = true;
    await vi.advanceTimersByTimeAsync(8 * DAY_MS);
    const res = await settle(t.get(TILE, "u2"));
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await t.store.get(KEY)).toBeNull();
    // Next request has nothing to revalidate: a full fetch.
    await settle(t.get(TILE, "u3"));
    expect(t.calls.at(-1)!.headers.get("if-none-match")).toBeNull();
  });

  it("still caches normally when a 304 carries no no-store", async () => {
    const t = setup((c) => (c.headers.get("if-none-match") ? new Response(null, { status: 304 }) : png({ etag: '"v1"' })));
    await settle(t.get(TILE, "u1"));
    await vi.advanceTimersByTimeAsync(8 * DAY_MS);
    const res = await settle(t.get(TILE, "u2"));
    expect(res.headers.get("cache-control")).toBe("public, max-age=604800");
    expect(await t.store.get(KEY)).not.toBeNull();
  });

  it("answers error JSON, never a cached tile, when an upstream 200 is junk and nothing is stored", async () => {
    const t = setup(() => png({}, new Uint8Array([1, 2, 3])));
    const res = await settle(t.get(TILE));
    expect(((await res.json()) as ProxyError).code).toBe("upstream");
  });
});
