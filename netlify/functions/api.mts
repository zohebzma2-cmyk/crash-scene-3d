// Netlify Function: every /api/* call goes through the proxy. Keys (if any are ever
// needed) live in Netlify env vars here, never in the browser bundle.
//
// Environment variables:
//   PROXY_USER_SALT               REQUIRED in production: secret mixed into the per-user hash.
//                                 Without it every request gets a plain 500 (see resolveSalt).
//   NETLIFY_LOCAL_MEMORY_STORE=1  use the in-memory store instead of Netlify Blobs (local dev, tests)
// The contact in the User-Agent is not configured here: it lives in ProviderConfig (packages/proxy/src/config.ts).
import type { Config } from "@netlify/functions";
import type { ProxyError } from "@csd/core";
import { blobsStore } from "../../packages/proxy/src/blobs";
import { clientIp, createProxy, defaultProviderConfig, hashUserKey, memoryStore } from "../../packages/proxy/src/index";
import { resolveSalt } from "../../packages/proxy/src/userkey";

const now = () => Date.now();
const salt = resolveSalt(process.env);

const handler = salt.ok
  ? createProxy(defaultProviderConfig(), {
      fetch: globalThis.fetch,
      // Blobs (strong consistency, conditional writes) so the 1 req/s limit holds across function instances.
      store: process.env.NETLIFY_LOCAL_MEMORY_STORE === "1" ? memoryStore() : blobsStore(),
      now,
      // SHA-256 of IP (IPv6: its /64) + the UTC date + the secret salt; the raw IP is never stored.
      userKey: (req) => hashUserKey(clientIp(req), now(), salt.salt),
    })
  : null;

const notConfigured: ProxyError = { code: "upstream", message: "This service isn't set up yet. Please try again later." };

export default (req: Request): Promise<Response> | Response => {
  if (handler) return handler(req);
  console.error("proxy: PROXY_USER_SALT is not set; refusing to hash callers with an empty salt");
  return new Response(JSON.stringify(notConfigured), { status: 500, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
};
export const config: Config = { path: "/api/*" };
