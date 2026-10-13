// A warm function instance outlives the Blobs access token of the request that opened a store (drafts, 2026-10-12:
// "Failed to decode token: Token expired" on every cache and rate-limit call). perCallStore opens the store again for
// every call, so each call carries the token of the invocation it runs in.
import { describe, expect, it } from "vitest";
import { perCallStore, type BlobStoreLike } from "../src/blobs";

/** A fake Netlify Blobs: each opened store is bound to the token current when it was opened; a rotated token kills it. */
function fakeBlobs() {
  let token = 1;
  const data = new Map<string, string>();
  let opened = 0;
  const open = (): BlobStoreLike => {
    opened++;
    const mine = token;
    const check = () => { if (mine !== token) throw new Error("Netlify Blobs has generated an internal error (Failed to decode token: Token expired)"); };
    return {
      getWithMetadata: (async (key: string) => { check(); const v = data.get(key); return v == null ? null : { data: v, etag: `"${v}"`, metadata: {} }; }) as BlobStoreLike["getWithMetadata"],
      set: async (key, value) => { check(); data.set(key, String(value)); return { modified: true, etag: `"${String(value)}"` }; },
      delete: async (key) => { check(); data.delete(key); },
    };
  };
  return { open, rotate: () => { token++; }, opened: () => opened };
}

describe("perCallStore", () => {
  it("keeps working after the token the store was first opened with expires", async () => {
    const blobs = fakeBlobs();
    const kept = blobs.open();
    const fresh = perCallStore(blobs.open);
    await fresh.set("k", "v1");
    blobs.rotate();
    // A store kept from an earlier invocation fails, as on the drafts…
    await expect(kept.getWithMetadata("k", { type: "text" })).rejects.toThrow(/Token expired/);
    // …the per-call one reads, writes and deletes with the current token.
    expect((await fresh.getWithMetadata("k", { type: "text" }))?.data).toBe("v1");
    await fresh.set("k", "v2");
    expect((await fresh.getWithMetadata("k", { type: "text" }))?.data).toBe("v2");
    await fresh.delete("k");
    expect(await fresh.getWithMetadata("k", { type: "text" })).toBeNull();
  });

  it("opens the store once per call and passes the arguments through unchanged", async () => {
    const blobs = fakeBlobs();
    const seen: unknown[] = [];
    const store = perCallStore(() => {
      const s = blobs.open();
      return { ...s, set: (k, d, o) => { seen.push([k, d, o]); return s.set(k, d, o); } };
    });
    await store.set("a", "1", { onlyIfNew: true, metadata: { x: 1 } });
    await store.getWithMetadata("a", { type: "text" });
    expect(blobs.opened()).toBe(2);
    expect(seen).toEqual([["a", "1", { onlyIfNew: true, metadata: { x: 1 } }]]);
  });
});
