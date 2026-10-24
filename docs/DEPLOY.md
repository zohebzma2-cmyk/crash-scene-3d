# Deploy runbook

> **Deployed 2026-10-10** to https://crash-scene-3d.netlify.app (Netlify site `crash-scene-3d`) from the repository's `main`, with `npx -y netlify-cli@27.9.0 deploy --prod --build`. `PROXY_USER_SALT` is set as a secret (Functions scope, production context) and was never printed. The rest of this page is the runbook for checking and redeploying.

## What ships

| Piece | Where | Notes |
|---|---|---|
| The app | `apps/web` → `apps/web/dist` (`npm run build`) | Static files. Hashed files in `/assets/*`. |
| The proxy | `netlify/functions/api.mts` → route `/api/*` | One function. It claims the route itself (`config.path`), so `netlify.toml` has no redirect rule. |
| Keep-warm | `netlify/functions/warm.mts` → scheduled `*/5 * * * *` | A scheduled function that pings the site's own `/` and `/api/vehicles/makes` every 5 minutes so the app and the proxy don't go cold between visitors. It calls no upstream provider (makes is cache-served), writes nothing, and swallows every error. Scheduled Functions are available on all Netlify plans; nothing to enable. Check it on the first deploy: Netlify → Functions shows `warm` with a schedule, and its log shows a run every 5 minutes. |
| Headers | `netlify.toml` | CSP, HSTS and the rest on every path. See below. |

## Reliability of the road geometry

The one provider that can be slow on a fresh (uncached) location is Overpass. Three things keep the tool usable:

- **Curated, pre-baked locations.** `examples/<slug>/` ships baked OSM road data + terrain for famous public intersections (NYC 5th & 42nd, Chicago State & Madison, LA Hollywood & Highland, SF Haight & Ashbury) as well as the three NH scenario examples. `/?example=<slug>` renders entirely from this bundled data and never calls Overpass. Re-capture with `node scripts/fetch-curated.mjs` (run by hand, with network).
- **Roads-first live query.** The live `/api/geo/overpass` route asks for roads + buildings in one query with a short 25 s Overpass timeout; if that times out (usually a dense city's heavy building geometry), it retries a roads-only query so the scene still gets its roads. The per-request deadline is 9.3 s (`packages/proxy/src/config.ts`, under Netlify's ~10 s cap), across 7 mirrors.
- **Graceful fallback.** If a live fetch still fails and the pin sits on a bundled example, the app serves that baked data; otherwise it shows the map tiles and the scene with an honest "roads couldn't load" notice and a Retry, never a broken/empty scene.

## Node version

- `netlify.toml` sets `NODE_VERSION = "22"` under `[build.environment]`, matching local development (22.x) and `package.json` `engines` (`>=22`).
- Left alone, Netlify's function bundler would pick Node 24 (the CLI's default, seen in `functions:build`'s manifest as `nodejs24.x`). Setting it makes the build and the function both use 22.
- Check on the first deploy (see below) that the function log or the `x-nf-invocation-metadata` response header says Node 22.

## Environment variables

Set these in Netlify under Site configuration → Environment variables. Nothing here goes in the repo, and no `.env` file is needed.

| Variable | Required? | Value | Notes |
|---|---|---|---|
| `PROXY_USER_SALT` | **Yes, in production** | a long random secret (48+ bytes) | Mixed into the per-caller hash used for rate limits (SHA-256 of IP + date + this salt). **If it is missing, every `/api/*` request gets a plain 500** with "This service isn't set up yet" (`resolveSalt` in `packages/proxy/src/userkey.ts`). Mark it as a secret and give it Functions scope at runtime. |
| `CARIMAGES_API_KEY`, `CARIMAGES_API_SECRET` | Optional | from the CarImages dashboard | Vehicle photos and 3D models (decision 0011). Without either, `/api/vehicles/image` and `/api/vehicles/model` answer their fallback and the app shows its own icons. Secret, Functions scope. Read at call time; never logged or sent to the browser. |
| `LOGO_DEV_SECRET_KEY` | Optional | logo.dev secret key | Maker logos from logo.dev's API when CarImages has none. Secret, Functions scope. (`LOGO_DEV_TOKEN`, the publishable key, is not used.) |
| `NETLIFY_LOCAL_MEMORY_STORE` | Never in production | `1` | Local and test only: uses an in-process store instead of Blobs. It cannot enforce the 1 req/s limit across several function instances. |

OSM tiles, Nominatim, Overpass, Terrarium terrain and NHTSA vPIC need no keys; only the optional media providers above do. If the CarImages subscription ever ends, its terms require deleting the stored images: empty the Blobs store `csd-proxy-media` (it holds only photos, models, logos and their catalog). The User-Agent contact is the repo URL, held in `packages/proxy/src/config.ts`.

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
| `csd-proxy-slots` | global 1 req/s slots (Nominatim, Overpass) and token buckets (tiles, terrain, type-ahead, vPIC) | tiny, bounded by the number of services |
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

The CSP in the page itself is tested separately, in real browsers: `e2e/csp-steps.spec.ts` (Chromium and WebKit, also runnable against a deployed `BASE_URL`) and `e2e/csp.spec.ts` load the built app and every step under the policy and fail on any violation. Run it with `npm run e2e`, or against a running copy with `BASE_URL= (or CSP_BASE_URL= for csp.spec.ts) http://localhost:8888`.

## First-deploy checklist

Do this on the first deploy (a deploy preview is fine), in this order.

1. **Variables.** `PROXY_USER_SALT` is set (secret, Functions scope). Without it `/api/*` answers 500 "This service isn't set up yet."
2. **Build.** The deploy log shows Node 22, `vite build` succeeding, and `Packaging Functions ... api.mts`.
3. **Headers.** `npm run verify:headers -- https://<deploy-url>` (no `--local`) passes, including the three `Cache-Control` rows.
4. **App.** Open `/` and `/?example=t-bone-intersection`; step through all four steps. Open the browser console: no CSP errors. Run the every-step CSP spec against it, on WebKit (Safari's engine) and Chromium: `BASE_URL=https://<deploy-url> E2E_FULL=1 npx playwright test e2e/csp-steps.spec.ts --project=webkit-desktop --project=desktop` (it needs no fixtures; `e2e/csp.spec.ts` needs the fixtures build).
5. **Blobs stores.** After one search, one map view and one vehicle lookup, Netlify → Blobs shows `csd-proxy-cache`, `csd-proxy-slots`, `csd-proxy-geo-<today>` and `csd-proxy-user-<today>`. Geo entries appear **only** in the dated stores.
6. **The sweep.** The next UTC day (and a week later) the old `csd-proxy-user-*` store is gone, and `csd-proxy-geo-*` stores older than 7 days are gone. If not, read the function log for "listStores" errors. (Not provable locally.)
7. **Rate limits.**
   - Send two searches less than a second apart from one browser: the second answers `429` with JSON `{"code":"busy", ..., "retryAfterS": ...}` and a `Retry-After` header.
   - A single map view (about 20 tiles at once) loads fully, with no `429`s. Tiles and terrain use token buckets: per user burst 64, refill 16/s, plus a global cap.
   - Vehicle lookups (vPIC) use their own token buckets: per user 12 refilling 1/s and all users 16 refilling 2/s, both counted in vPIC calls (a model list is four), with at most 2.5 s of waiting per call. Typing two vehicles never sees a busy message: `e2e/live/vehicles.live.spec.ts` checks this once (see "Our own test traffic").
   - Every `429` the proxy sends (not a stale copy served instead) is logged once as `proxy: busy topic=… service=… limiter=user|global` (no user data). Read it with `npx -y netlify-cli@27.9.0 logs --source functions --since 1h`.
   - Do not hammer the real providers to test this; two quick requests are enough.
8. **Upstream identity.** A search works end to end (Nominatim returns a result). If a provider answers 403, the User-Agent contact in `ProviderConfig` is the first thing to check.
9. **Privacy spot check.** Function logs contain no addresses, coordinates or raw IPs.
10. **Media (only with the keys set, and with the owner's go-ahead).** Pick a common model on the Vehicles step: the card shows the maker logo and a photo, and the browser's network panel shows only `/api/vehicles/image` and `/api/logos/make` on our origin. The function log has at most the one "keys are not set" line and no key. Netlify → Blobs shows `csd-proxy-media`. The full list of what to check is in docs/decisions/0011-vehicle-images.md, "Only checkable after a deploy".
11. **No source maps.** `apps/web/vite.config.ts` turns `build.sourcemap` on only for `--mode development` and for `VITE_FIXTURES=1` (the e2e build), so a production `npm run build` writes no `.map` files (checked: 0). On the deploy, `curl -sI https://<deploy-url>/assets/<the main js file>.map` must not return 200. Never set `VITE_FIXTURES=1` in the Netlify build environment: it also turns source maps on (and bundles the fixtures).

## Our own test traffic

The proxy's global buckets and slots are shared by everyone, and our own runs count against them. On 2026-10-10, about 115 live Playwright runs spent the same vPIC budget real people needed (docs/PROXY-BUSY.md). The rules:

- **Stubbed against a deployed copy:** any e2e spec run with a `BASE_URL` that isn't this machine answers the vehicle lookups and map tiles inside the test. `/api/vehicles/*` goes to the real proxy code with a fake vPIC; `/api/geo/tile/*` gets a neutral PNG. This is `e2e/live-guard.ts`, made automatic for every spec through `e2e/helpers.ts`, and the live search specs use it too.
- **Kept live:** search, crossing, type-ahead, Overpass and terrain, which the live checks are there to verify.
- **One flow verifies vehicle lookups live:** `e2e/live/vehicles.live.spec.ts`. Run it once after a deploy that touches the proxy or the vehicles step.
- **The release smoke is deliberately unstubbed** (`npm run smoke`, "Release safety" below): it exists to verify the real search, lookups and media, so it is run **once** per draft and once after a promote, never looped. It is the one script that may spend the media budget on purpose.
- **Scratch and measuring scripts against the live site** call `stubNonEssentialApi(page)` from `e2e/live-guard.ts` on every page they open. They make a handful of requests and never loop.
- **No** `--repeat-each`, no loops, and no live suites side by side. Everything from one machine is one proxy user.
- `E2E_LIVE_API=all` turns the guard off. It is for a deliberate full live check by the owner only. `E2E_LIVE_GUARD=1` forces the guard on, to test the guard against a local build.
- **There is no test key or test bucket**, on purpose:
  - it would need a Netlify secret and a bypass path in the proxy;
  - once our runs stop calling vPIC and tiles, they fit the same per-user limits a person has;
  - the per-user buckets are per IP and day, so our runs only ever spend our own per-user budget.

## Release safety: draft → smoke → promote

Nothing goes to production untested. Every release is a draft deploy first, smoked with `npm run smoke`, and only then promoted. All of this is run by hand by the owner (hard rule 3: no push, publish or deploy without asking Zoheb).

### 1. Draft deploy

From the commit you mean to ship (a clean checkout, `git status` empty, `./check.sh` green):

```sh
NETLIFY_SITE_ID=<site id> npx -y netlify-cli@27.9.0 deploy --build          # no --prod: a draft URL
```

The CLI prints a draft URL of the form `https://<deploy-id>--crash-scene-3d.netlify.app`. The build runs the same `netlify.toml` command as production, with the **deploy-preview** context's variables (see "Draft environment" below). Note the commit: `git rev-parse HEAD`.

### 2. Smoke

```sh
SMOKE_SHA=$(git rev-parse --short HEAD) npm run smoke -- https://<deploy-id>--crash-scene-3d.netlify.app
```

`scripts/smoke.mjs` walks the whole flow **once** like a person, on Chromium at 1440 and WebKit at 390 (one after the other, never side by side), against the real deployment with nothing stubbed:

| Check | What passes |
|---|---|
| `load` | the page loads with no console error, page error or CSP violation (counted for the whole run in `no-errors`); a first-visit "See what happened" dialog, if one appears, is dismissed and noted, never asserted |
| `location`, `location-streets` | "Main Street and Park Street, Nashua NH" searched and picked; the pin lands on the Nashua crossing; both streets are found at the pin |
| `vehicle-A`, `vehicle-B` | 2019 Chevrolet Silverado 1500 and 2021 Honda Accord typed key by key; each field's ranked suggestion appears and Enter takes it |
| `logo-A/B`, `photo-A/B` | each card shows the real maker logo (`data-make-logo="logo"`) and a real stock photo (`data-photo="photo"`, image decoded), not the fallback icon |
| `review-ready`, `review-canvas`, `glb` | the 3D view reports ready, the canvas is not one colour, and `/api/vehicles/model` answered `model/gltf-binary` for at least one vehicle |
| `review-play`, `review-aftermath`, `review-measure` | the timeline plays through the impact mark; Aftermath switches on; the Measure tab (when present) lists its rows |
| `save-*` | "Looks right: save it" → "Save to my device" (the second-tap "Download your files" case is handled) gives one ZIP with the PDF, both stills, the diagram and the scene JSON; the PDF prints the JSON's SHA-256; the PDF holds an image (the stock photo) |
| `example-*` | `/?example=<name>#review` reaches ready for all three examples |

It writes `report.md` and `report.json` (plus the ZIP, a Review screenshot and a screenshot of every failure) to `--out <dir>`, default `smoke-out/` (gitignored), prints the table, and exits 1 on any FAIL.

**Media on a draft.** The CarImages and logo.dev keys are set for the **production** context only, so on a draft the logo, photo, GLB and PDF-photo checks still run and are reported, but a miss shows as `SKIP (not tested on draft (keys production-only))` and does not fail the run. This is automatic for any `*--crash-scene-3d.netlify.app` host and can be forced with `--draft`. Against production they are required. (A local `vite preview`, which has no `/api` at all, runs with `--allow-no-media`: the location and vehicle lookups are SKIP there too, and the flow borrows an example's pin.)

Budget: one search, one crossing, the roads and terrain at the pin, about four vPIC lookups and three media calls per engine. Run it **once** per draft (twice at most if the first run was cut short), never in a loop, and not while another live run is going (one machine is one proxy user: "Our own test traffic").

### 3. Promote

Only when the smoke is green, and only the **same commit** the draft was built from:

```sh
git rev-parse HEAD                                                            # must equal the drafted SHA
NETLIFY_SITE_ID=<site id> npx -y netlify-cli@27.9.0 deploy --build --prod     # production build of that commit
git push origin <sha>:main                                                    # the repo's main matches what is live
```

Then one gentle production smoke (media now **required**), and `npm run verify:headers -- https://crash-scene-3d.netlify.app` (no `--local`):

```sh
SMOKE_SHA=<sha> npm run smoke -- https://crash-scene-3d.netlify.app
```

### 4. Rollback

Netlify keeps every production deploy. If the production smoke fails: Netlify → Deploys → pick the last known-good deploy → **Publish deploy** (a restore; no rebuild). The site is back on the old files within seconds. Then fix forward: a new draft, a new smoke, a new promote. Keep `main` pointing at what is live: do not push a commit to `main` whose deploy was rolled back without a follow-up fix.

### Draft environment (one-time, owner only)

Today the `deploy-preview` context has only `PROXY_USER_SALT`; `CARIMAGES_API_KEY`, `CARIMAGES_API_SECRET` and `LOGO_DEV_SECRET_KEY` are production-only, which is why media is SKIP-on-miss on a draft. To test media on drafts too, set the same keys for the deploy-preview context. In your own terminal, read each value without echoing it, then set it; nothing prints and nothing lands in a file or the shell history (`read -s`):

```sh
read -s V && npx -y netlify-cli@27.9.0 env:set CARIMAGES_API_KEY "$V" --context deploy-preview --secret --site c40e798a-02e1-4a71-8199-47bec1beeed0; unset V
read -s V && npx -y netlify-cli@27.9.0 env:set CARIMAGES_API_SECRET "$V" --context deploy-preview --secret --site c40e798a-02e1-4a71-8199-47bec1beeed0; unset V
read -s V && npx -y netlify-cli@27.9.0 env:set LOGO_DEV_SECRET_KEY "$V" --context deploy-preview --secret --site c40e798a-02e1-4a71-8199-47bec1beeed0; unset V
```

Draft deploys made with `netlify deploy` (no `--prod`) build with the deploy-preview context. Once the keys are there, make media **required** on a draft too with `npm run smoke -- https://<deploy-id>--crash-scene-3d.netlify.app --require-media` (it overrides the draft auto-detection; it contradicts `--allow-no-media`). Until then the SKIP-on-miss default is right.

## Known limits

- `netlify.toml` headers apply to static files. Whether Netlify also adds them to function responses can differ between local and production; the proxy sets its own `content-type`, `cache-control` and `nosniff` on every response, so it does not depend on it. A CSP on a JSON or PNG response is harmless either way.
- A platform-level failure (for example a 502 from Netlify itself, before the function runs) is not ours to shape and may be an HTML page.
- `/api` with no trailing slash is not routed to the function. The app never requests it.
