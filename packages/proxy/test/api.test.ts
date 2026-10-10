import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProxyError } from "@csd/core";

type Handler = (req: Request) => Promise<Response> | Response;

// The Netlify entry point, loaded fresh for each environment so module-level wiring is exercised.
async function loadEntry(): Promise<{ handler: Handler; path: string }> {
  vi.resetModules();
  // TS (bundler resolution) won't import a .mts path without allowImportingTsExtensions; Vite will.
  // @ts-expect-error TS5097
  const mod = (await import("../../../netlify/functions/api.mts")) as { default: Handler; config: { path: string } };
  return { handler: mod.default, path: mod.config.path };
}

const calls: { url: string; ua: string | null }[] = [];

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), ua: new Headers(init?.headers).get("user-agent") });
    return new Response(JSON.stringify([]), { headers: { "content-type": "application/json" } });
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("netlify/functions/api.mts", () => {
  it("serves a search through the proxy with the memory store, and sends the repo URL as contact", async () => {
    vi.stubEnv("NETLIFY_LOCAL_MEMORY_STORE", "1");
    const { handler, path } = await loadEntry();
    expect(path).toBe("/api/*");
    const res = await handler(new Request("https://app.test/api/geo/search?q=Main%20St", { headers: { "x-nf-client-connection-ip": "203.0.113.5" } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.ua).toContain("https://github.com/zohebzma2-cmyk/crash-scene-3d");
  });

  it("rate-limits the same caller by hashed IP", async () => {
    vi.stubEnv("NETLIFY_LOCAL_MEMORY_STORE", "1");
    const { handler } = await loadEntry();
    const hdr = { "x-nf-client-connection-ip": "203.0.113.5" };
    expect((await handler(new Request("https://app.test/api/geo/search?q=Main%20St", { headers: hdr }))).status).toBe(200);
    expect((await handler(new Request("https://app.test/api/geo/search?q=Elm%20St", { headers: hdr }))).status).toBe(429);
  });

  it("refuses with a plain 500 ProxyError when PROXY_USER_SALT is missing in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VITEST", undefined as unknown as string);
    vi.stubEnv("PROXY_USER_SALT", "");
    vi.stubEnv("NETLIFY_DEV", "");
    vi.stubEnv("NETLIFY_LOCAL_MEMORY_STORE", "");
    const { handler } = await loadEntry();
    const res = await handler(new Request("https://app.test/api/geo/search?q=Main%20St", { headers: { "x-nf-client-connection-ip": "203.0.113.5" } }));
    expect(res.status).toBe(500);
    const err = (await res.json()) as ProxyError;
    expect(err.code).toBe("upstream");
    expect(err.message).not.toMatch(/salt|PROXY_USER/i);
    expect(calls).toHaveLength(0);
  });

  it("runs in production once the salt is set", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VITEST", undefined as unknown as string);
    vi.stubEnv("PROXY_USER_SALT", "a-long-random-secret");
    vi.stubEnv("NETLIFY_LOCAL_MEMORY_STORE", "1"); // memory store stands in for Blobs; the salt is what is under test
    const { handler } = await loadEntry();
    const res = await handler(new Request("https://app.test/api/geo/search?q=Main%20St", { headers: { "x-nf-client-connection-ip": "203.0.113.5" } }));
    expect(res.status).toBe(200);
  });
});
