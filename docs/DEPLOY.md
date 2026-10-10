# Deploy runbook

> **Nothing has been deployed.** No Netlify site exists for this project yet, no account was touched, and
> nothing was pushed. This page says what to set up and what to check on the first deploy, and every step
> is yours to run. All local checks below were made with `netlify dev --offline` / `netlify serve --offline`,
> unlinked and logged out.

## What ships

| Piece | Where | Notes |
|---|---|---|
| The app | `apps/web` → `apps/web/dist` (`npm run build`) | Static files. Hashed files in `/assets/*`. |
| The proxy | `netlify/functions/api.mts` → route `/api/*` | One function. It claims the route itself (`config.path`), so `netlify.toml` has no redirect rule. |
| Headers | `netlify.toml` | CSP, HSTS and the rest on every path. See below. |

## Node version

- `netlify.toml` sets `NODE_VERSION = "22"` under `[build.environment]`, matching local development (22.x) and `package.json` `engines` (`>=22`).
- Left alone, Netlify's function bundler would pick Node 24 (the CLI's default, seen in `functions:build`'s manifest as `nodejs24.x`). Setting it makes the build and the function both use 22.
- Check on the first deploy (see below) that the function log or the `x-nf-invocation-metadata` response header says Node 22.

## Environment variables

Set these in Netlify under Site configuration → Environment variables. Nothing here goes in the repo, and no `.env` file is needed.

| Variable | Required? | Value | Notes |
|---|---|---|---|
| `PROXY_USER_SALT` | **Yes, in production** | a long random secret (48+ bytes) | Mixed into the per-caller hash used for rate limits (SHA-256 of IP + date + this salt). **If it is missing, every `/api/*` request gets a plain 500** with "This service isn't set up yet" (`resolveSalt` in `packages/proxy/src/userkey.ts`). Mark it as a secret and give it Functions scope at runtime. |
| `NETLIFY_LOCAL_MEMORY_STORE` | Never in production | `1` | Local and test only: uses an in-process store instead of Blobs. It cannot enforce the 1 req/s limit across several function instances. |

There are no provider API keys: OSM tiles, Nominatim, Overpass, Terrarium terrain and NHTSA vPIC need none. The User-Agent contact is the repo URL, held in `packages/proxy/src/config.ts`.

### Generating the salt without anyone else seeing it

Run these in your own terminal. Nothing prints the value.

```sh
# 1. make it and put it on the clipboard (nothing is shown)
openssl rand -base64 48 | tr -d '\n' | pbcopy

# 2. paste it into Netlify: Site configuration > Environment variables > Add a variable
#    Key: PROXY_USER_SALT   Value: (paste)   tick "Contains secret values"   Scopes: Functions (runtime)
#    then clear the clipboard:
pbcopy < /dev/null
```

For a local run, make a throwaway salt inline, so no file holds it:

```sh
PROXY_USER_SALT="$(openssl rand -hex 32)" npx -y netlify-cli@27.9.0 dev --offline --filter @csd/web
```

Rotating the salt is safe at any time. It only changes the hashed caller keys, so everyone's rate-limit bucket starts again.

## Blobs

The proxy keeps its cache, rate-limit slots and token buckets in Netlify Blobs (strong consistency, conditional writes). Blobs is on by default for every site, and no setup is needed.

Stores it creates (names are in `packages/proxy/src/blobs.ts`):

| Store | Holds | Lifetime |
|---|---|---|
| `csd-proxy-cache` | tiles, terrain, vPIC lists (no typed or pinned data) | per entry, 7 to 30 days; kept past expiry for stale-on-error |
| `csd-proxy-slots` | global 1 req/s slots and token buckets | tiny, bounded by the number of services |
| `csd-proxy-geo-YYYYMMDD` | address searches, crossings, Overpass data around a pin: **what people typed or pinned** | one store per UTC day; **at most 7 days** |
| `csd-proxy-user-YYYYMMDD` | per-caller slots and buckets (hashed keys) | one store per UTC day; older ones deleted |

The sweep: the first request of each UTC day on a function instance lists the stores and deletes `csd-proxy-geo-*` older than 7 days and `csd-proxy-user-*` from earlier days. It is capped at 1.5 s so it never holds up a request.

**Local status (checked on `netlify dev` / `netlify serve`):** Blobs works in Netlify's local sandbox ("Netlify Blobs running in sandbox mode"). A real search was cached (`x-proxy-cache: miss`, then `hit`), and a tile and a terrain tile were fetched and relayed as PNG. The sandbox may not list or delete stores, so **the daily sweep cannot be proven locally**: check it on the first deploy.

**If Blobs is unavailable:** the function degrades per request, as the code intends (a failing store reads as a cache miss, never a 500). For a stopgap that keeps working, redeploy with `NETLIFY_LOCAL_MEMORY_STORE=1`. The proxy then caches and limits per function instance only, so the 1 req/s rule to Nominatim could be exceeded when several instances are warm. Use it only briefly, and not while traffic is high.

## Local development

The Netlify CLI is **not** a project dependency (it would add 944 packages and 13 audit highs to the lockfile; see `docs/AUDIT.md`). Commands call it through `npx -y netlify-cli@27.9.0`, an exact version more than two weeks old. The first run downloads it into npm's cache. To change the version, edit it in `package.json` (`functions:build`), here and in `CLAUDE.md`.

```sh
npm run dev                                                   # Vite only, :5173 (no function)
npx -y netlify-cli@27.9.0 dev --offline --filter @csd/web --port 8888       # Vite + the function on one origin, :8888
npx -y netlify-cli@27.9.0 serve --offline --filter @csd/web --port 8888     # builds, then serves the built site (production-like)
npm run functions:build                                       # just prove the function bundles (output in .netlify/functions-build)
```

- `--offline` keeps the CLI from contacting Netlify. No login and no link are needed. Don't run `netlify link`, `login`, `init` or `deploy` until you mean to deploy.
- `--filter @csd/web` is needed because the repo is a workspace monorepo. Without it the CLI asks which package to use.
- `netlify dev` starts Vite itself with the `[dev]` command in `netlify.toml`: `npm exec -w @csd/web -- vite --port 4400 --strictPort`, with `targetPort = 4400`. It never uses `:5173`, so it can't collide with `npm run dev` or another tool. `--strictPort` makes it fail loudly if `:4400` is taken. To use another port, pass both: `--target-port 4411 --command "npm exec -w @csd/web -- vite --port 4411 --strictPort"`. (Don't use `npm run dev -- --port N` at the repo root: the port flag doesn't reach Vite.)
- On a bare `netlify dev` the function uses Blobs in sandbox mode and, if `PROXY_USER_SALT` is not set, an empty salt (allowed only under `netlify dev`).
- Netlify's **local** static server ignores the `Cache-Control` rules in `netlify.toml`, so check those on a real deploy (see `--local` below).
- Never run `netlify dev` from a git **worktree nested inside** another checkout: the CLI finds the outer `.git` folder and serves the outer checkout's files. Use a normal clone.

## `verify:headers`

```sh
npm run verify:headers -- http://localhost:8888 --local     # netlify dev / serve
npm run verify:headers -- https://<your-site>.netlify.app   # a real deploy: no --local
```

It exits 1 on any miss and prints a table. It sends only requests the proxy rejects itself, so **no outside service is called**.

| Check | Where | Expected |
|---|---|---|
| The same values as `netlify.toml` | the file | every header below, plus the `/assets/*` and `/index.html` rules and `NODE_VERSION` |
| `Content-Security-Policy` | `/`, `/index.html`, an `/assets/*` file | the exact strict policy (`default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`), with `frame-ancestors 'none'` |
| `X-Content-Type-Options` | same | `nosniff` |
| `Referrer-Policy` | same | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | same | exact list; camera, microphone and geolocation denied |
| `Cross-Origin-Opener-Policy` | same | `same-origin` |
| `X-Frame-Options` | same | `DENY` |
| `Strict-Transport-Security` | same | `max-age=63072000; includeSubDomains` (at least a year) |
| `Cache-Control` | `/`, `/index.html` | `no-cache` |
| `Cache-Control` | the hashed `/assets/*` file linked from `/` | `public, max-age=31536000, immutable` |
| Proxy errors | bad search, bad tile and terrain shapes, unknown route (404), POST (405) | status, `application/json`, `Cache-Control: no-store`, `nosniff`, body `{code, message}` with friendly text, never HTML, no stack or path |

`--local` marks the three static-file `Cache-Control` rows as SKIP, because Netlify's local server sets its own value. **Run without `--local` on the real site**, where all three must pass. `--dev` also skips the `/assets/*` row for a plain Vite dev server (which has none).

The CSP in the page itself is tested separately, in a real browser: `e2e/csp.spec.ts` loads the built app and every step under the policy and fails on any violation. Run it with `npm run e2e`, or against a running copy with `CSP_BASE_URL=http://localhost:8888`.

## First-deploy checklist

Do this on the first deploy (a deploy preview is fine), in this order.

1. **Variables.** `PROXY_USER_SALT` is set (secret, Functions scope). Without it `/api/*` answers 500 "This service isn't set up yet."
2. **Build.** The deploy log shows Node 22, `vite build` succeeding, and `Packaging Functions ... api.mts`.
3. **Headers.** `npm run verify:headers -- https://<deploy-url>` (no `--local`) passes, including the three `Cache-Control` rows.
4. **App.** Open `/` and `/?example=t-bone-intersection`; step through all four steps. Open the browser console: no CSP errors. Run the CSP spec against it: `CSP_BASE_URL=https://<deploy-url> npx playwright test e2e/csp.spec.ts`. (`--project` desktop is enough.)
5. **Blobs stores.** After one search, one map view and one vehicle lookup, Netlify → Blobs shows `csd-proxy-cache`, `csd-proxy-slots`, `csd-proxy-geo-<today>` and `csd-proxy-user-<today>`. Geo entries appear **only** in the dated stores.
6. **The sweep.** The next UTC day (and a week later) the old `csd-proxy-user-*` store is gone, and `csd-proxy-geo-*` stores older than 7 days are gone. If not, read the function log for "listStores" errors. (Not provable locally.)
7. **Rate limits.**
   - Send two searches less than a second apart from one browser: the second answers `429` with JSON `{"code":"busy", ..., "retryAfterS": ...}` and a `Retry-After` header.
   - A single map view (about 20 tiles at once) loads fully, with no `429`s. Tiles and terrain use token buckets: per user burst 64, refill 16/s, plus a global cap.
   - Do not hammer the real providers to test this; two quick requests are enough.
8. **Upstream identity.** A search works end to end (Nominatim returns a result). If a provider answers 403, the User-Agent contact in `ProviderConfig` is the first thing to check.
9. **Privacy spot check.** Function logs contain no addresses, coordinates or raw IPs.
10. **No source maps.** `apps/web/vite.config.ts` turns `build.sourcemap` on only for `--mode development` and for `VITE_FIXTURES=1` (the e2e build), so a production `npm run build` writes no `.map` files (checked: 0). On the deploy, `curl -sI https://<deploy-url>/assets/<the main js file>.map` must not return 200. Never set `VITE_FIXTURES=1` in the Netlify build environment: it also turns source maps on (and bundles the fixtures).

## Known limits

- `netlify.toml` headers apply to static files. Whether Netlify also adds them to function responses can differ between local and production; the proxy sets its own `content-type`, `cache-control` and `nosniff` on every response, so it does not depend on it. A CSP on a JSON or PNG response is harmless either way.
- A platform-level failure (for example a 502 from Netlify itself, before the function runs) is not ours to shape and may be an HTML page.
- `/api` with no trailing slash is not routed to the function. The app never requests it.
