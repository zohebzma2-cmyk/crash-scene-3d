import { vi } from "vitest";
import { defaultProviderConfig, createProxy, memoryStore, type KvStore } from "../src";

export const START = Date.parse("2026-10-09T12:00:00Z");
export const config = defaultProviderConfig();
/** Overpass mirrors in the order the config tries them, as host names and URLs (so tests don't hard-code the order). */
export const MIRROR_URLS = config.overpass.urls;
export const MIRROR_HOSTS = MIRROR_URLS.map((u) => new URL(u).host);

export interface Call { url: string; method: string; headers: Headers; body: string | undefined }
export type Upstream = (call: Call, signal: AbortSignal | undefined) => Response | Promise<Response>;

export const jsonResponse = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
/** A fetch that never answers and rejects when aborted. */
export const hang: Upstream = (_c, signal) => new Promise<Response>((_res, rej) => signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));

export function setup(upstream: Upstream) {
  const calls: Call[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input), method: init?.method ?? "GET", headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    return upstream(call, init?.signal ?? undefined);
  }) as typeof globalThis.fetch;
  const inner = memoryStore();
  const slotCalls: string[] = [];
  const tokenCalls: string[] = [];
  const setKeys: string[] = [];
  const store: KvStore = {
    get: (k) => inner.get(k),
    set: (k, v, c, t, m) => { setKeys.push(k); return inner.set(k, v, c, t, m); },
    delete: (k) => inner.delete(k),
    takeSlot: (k, n, i) => { slotCalls.push(k); return inner.takeSlot(k, n, i); },
    reserveSlot: (k, n, i, w) => { slotCalls.push(k); return inner.reserveSlot(k, n, i, w); },
    takeToken: (k, n, l) => { tokenCalls.push(k); return inner.takeToken(k, n, l); },
  };
  const proxy = createProxy(config, { fetch, store, now: () => Date.now(), userKey: (req) => req.headers.get("x-user") ?? "user-1" });
  const get = (path: string, user = "user-1") => proxy(new Request(`https://app.test${path}`, { headers: { "x-user": user } }));
  return { calls, store, slotCalls, tokenCalls, setKeys, proxy, get };
}

/** Advance fake time until the promise settles (or `maxMs` pass). */
export async function settle<T>(p: Promise<T>, maxMs = 30_000): Promise<T> {
  let done = false;
  const wrapped = p.finally(() => { done = true; });
  for (let t = 0; t < maxMs && !done; t += 50) await vi.advanceTimersByTimeAsync(50);
  return wrapped;
}

export const nominatimRows = [
  { lat: "42.7654", lon: "-71.4676", display_name: "Nashua, Hillsborough County, New Hampshire, United States", name: "Nashua", type: "city", addresstype: "city", address: { city: "Nashua", state: "New Hampshire" } },
];
