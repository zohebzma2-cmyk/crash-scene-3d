// Netlify Function: every /api/* call goes through the proxy. Keys live in Netlify env vars here,
// never in the browser bundle.
//
// Environment variables:
//   PROXY_USER_SALT               REQUIRED in production: secret mixed into the per-user hash.
//                                 Without it every request gets a plain 500 (see resolveSalt).
//   CARIMAGES_API_KEY             optional: vehicle photos and 3D models (CarImages). With
//   CARIMAGES_API_SECRET          either missing, those routes answer their fallback.
//   LOGO_DEV_SECRET_KEY           optional: maker logos from logo.dev's API (after CarImages' own).
//   (LOGO_DEV_TOKEN, logo.dev's publishable key, is not used: see SecretName in packages/proxy/src/types.ts.)
//   NETLIFY_LOCAL_MEMORY_STORE=1  use the in-memory store instead of Netlify Blobs (local dev, tests)
// The keys are read when a request needs them (deps.secret) and are never logged, stored or sent to the browser.
// The contact in the User-Agent is not configured here: it lives in ProviderConfig (packages/proxy/src/config.ts).
import type { Config } from "@netlify/functions";
import type { ProxyError } from "@csd/core";
import { blobsStore } from "../../packages/proxy/src/blobs";
import { clientIp, createProxy, defaultProviderConfig, hashUserKey, memoryStore, type SecretName } from "../../packages/proxy/src/index";
import { resolveSalt } from "../../packages/proxy/src/userkey";

const now = () => Date.now();
const salt = resolveSalt(process.env);

/** Netlify.env when the runtime has it, else process.env; read at call time, never copied anywhere. */
function readSecret(name: SecretName): string | undefined {
  const netlify = (globalThis as { Netlify?: { env?: { get(n: string): string | undefined } } }).Netlify;
  return netlify?.env?.get(name) ?? process.env[name] ?? undefined;
}

const handler = salt.ok
  ? createProxy(defaultProviderConfig(), {
      fetch: globalThis.fetch,
      // Blobs (strong consistency, conditional writes) so the 1 req/s limit holds across function instances.
      store: process.env.NETLIFY_LOCAL_MEMORY_STORE === "1" ? memoryStore() : blobsStore(),
      now,
      // SHA-256 of IP (IPv6: its /64) + the UTC date + the secret salt; the raw IP is never stored.
      userKey: (req) => hashUserKey(clientIp(req), now(), salt.salt),
      secret: readSecret,
    })
  : null;

const notConfigured: ProxyError = { code: "upstream", message: "This service isn't set up yet. Please try again later." };

export default (req: Request): Promise<Response> | Response => {
  if (handler) return handler(req);
  console.error("proxy: PROXY_USER_SALT is not set; refusing to hash callers with an empty salt");
  return new Response(JSON.stringify(notConfigured), { status: 500, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
};
export const config: Config = { path: "/api/*" };
