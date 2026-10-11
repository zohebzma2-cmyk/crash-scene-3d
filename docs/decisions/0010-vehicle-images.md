# 0010. Vehicle photos, 3D models and maker logos

Status: Built on branch `roundB/images` (2026-10-11), not merged or deployed. Needs the owner's say-so before any deploy, and a check with the real keys after it (see "Only checkable after a deploy").

## Context
Round B asks for a stock photo of each vehicle on its card, the maker's logo where the make shows, the photo in the PDF and the 3D stills, and the provider's 3D model (GLB) made available for the viewer. The keys are Netlify secrets: `CARIMAGES_API_KEY`, `CARIMAGES_API_SECRET`, `LOGO_DEV_TOKEN`, `LOGO_DEV_SECRET_KEY`. Hard rules 2 and 6 hold: no key in the repo or the browser, and the browser talks only to its own origin (CSP `connect-src 'self'`, `img-src 'self' blob: data:`).

## Providers
- **CarImages** (https://carimagesapi.com/docs): photos (8 angles), 3D models (GLB), maker logos, a make/model/generation catalog, and motorcycles on plans that include them.
- **logo.dev** (https://www.logo.dev/docs): maker logos, the fallback when CarImages has none.

### What the docs say (read 2026-10-11) and where they differed from the brief
- **Auth.** REST calls take the key and the secret. The live API's own 401 says: "pass ?api_key=ci_xxx or Authorization: Bearer ci_xxx, plus your api_secret via the X-Api-Secret header". We use the two headers, so **the key is never in a URL**. The docs page itself only shows `?api_key=`.
- **Quota.** Free plan: 5,000 requests a month, 60 a minute. "Each call counts one request against your monthly quota", catalog calls included.
- **`/image`** "never returns JSON errors": for an unknown make or model, an exceeded quota or the rate limit it serves a placeholder image, and no header marks it (the only documented headers are `X-CI-Library` and `X-CI-View`). `/api/v1/signed-url` answers 429 JSON on quota.
- **Free plan is WebP only** ("Upgrade to Pro or Business for PNG and JPG") and watermarked. The PDF can't embed WebP, so the app converts to PNG in the browser.
- **`/brand-logo?make=`**: no auth; it answers **302 to a signed CDN URL** (not PNG directly) and **404 JSON** for an unknown make, not a placeholder (probed without a key). `/api/v1/makes/{slug}/logo` is public too (200 PNG, 404 when none).
- **Catalog.** `/api/v1/makes`, `/makes/{make}/models`, `/makes/{make}/models/{model}` (generations with `year_start`, `year_end`, `views` and `images` with `png`/`webp`/`jpg` and `sizes` "200"…"1200"; `images` is null when a generation has none), `/vehicles/{make}/{model}/{gen}/image` (`views` keyed by angle).
- **3D model** `/api/v1/vehicles/{make}/{model}/{gen}/model`: "JSON with the model URL + `watermarked` / `fallback` flags"; "A car with no 3D yet returns a clean masked-placeholder model instead of an error". No JSON example is published.
- **`/api/v1/libraries`**: `your_access: { plan, car, moto }`. The docs also say cars and motorcycles are "both available through the full REST API" on every plan; we still ask `libraries` rather than assume.
- **logo.dev** (https://www.logo.dev/docs/platform/fair-use): "Load Logo.dev CDN images in your users' browsers and apps. Don't fetch them from a script or a crawler." Not fair use: "an API that proxies Logo.dev requests". "To store logos yourself, download them through the Logo.dev API" (https://www.logo.dev/docs/platform/self-hosting): `GET https://api.logo.dev/v2/brands/logo?domain=…` with `Authorization: Bearer <secret key>` returns a temporary download `url`. **So the brief's "logo.dev CDN (token)" step is not built**: fetching `img.logo.dev/{domain}?token=` from our server breaks logo.dev's fair use, and loading it in the browser breaks our CSP. `LOGO_DEV_TOKEN` (the publishable key) is not used; `LOGO_DEV_SECRET_KEY` is.

### Terms
CarImages Terms & Conditions (https://carimagesapi.com/terms, last updated May 6, 2026):
- Section 10: the license is "restricted to use within your own applications, in accordance with the limits and features of your plan". Not allowed: "Redistribute the images as a standalone image library or dataset", "Use the images outside the scope of your API plan", "Use the images for any purpose without an active subscription".
- Section 10, on termination: "Remove all cached, downloaded, or stored images from your applications, websites, servers". **Caching is allowed while subscribed, and must be purged when the subscription ends**: every media entry lives in one Blobs store, `csd-proxy-media`, so it can be wiped in one go.
- Section 8: no reselling or redistributing "access to the API or API keys", no scraping "beyond normal API usage".
- Section 9: quotas and rate limits per the pricing page; requests over them may be "throttled or rejected".
- Hotlinking/proxying and attribution: not addressed. The watermark (free tier, baked into the 3D mesh) is the provider's and is not removed.

logo.dev attribution (https://www.logo.dev/docs/platform/attribution): "A commercial project on the free Community plan must show a visible link to Logo.dev": `<a href="https://logo.dev">Logos provided by Logo.dev</a>`, on the production site, on a public page, visible. The Vehicles step shows that link whenever a logo.dev logo is on the page (MakeLogo.tsx `LogoCredit`). Trademarks: "Use a logo to identify a brand, not to imply endorsement."

## Decision
### Routes (packages/proxy/src/media.ts)
| Route | Answers | Fallback chain |
|---|---|---|
| `GET /api/vehicles/image?make=&model=&year=&view=&width=&type=` | 200 WebP (PNG/JPEG on paid plans), `X-Vehicle-Image: exact`, `X-Vehicle-View: <angle served>` | CarImages catalog: makes → models of the make → generations of the model (by year, within 2 years) → the angle's picture (another angle: one more catalog call; not available → front 3/4) → download from `cdn.carimagesapi.com`. Otherwise **204** with `X-Media-Fallback: no-make / no-model / no-image / quota / busy / upstream / not-configured / moto-not-in-plan` and `X-Vehicle-Image: none` or `make-only` (the make is known, this model isn't; no other model's photo is ever shown for it). |
| `GET /api/vehicles/model?make=&model=&year=` | 200 `model/gltf-binary`, `X-Vehicle-Model-Watermarked: true/false` | Same catalog chain → the model JSON → download (must start with `glTF` v2, at most 15 MB). `fallback: true` (the masked placeholder) counts as "no model". Otherwise **200 JSON `{ "fallback": true, "reason": … }`**. |
| `GET /api/logos/make?name=` | 200 PNG, `X-Logo-Source: carimages / logodev` | 1. CarImages `/brand-logo` (no key); 2. logo.dev API (secret key) for the make's domain from a 70-make table, else logo.dev search when its top result's name is the make itself; 3. CarImages `/api/v1/makes/{slug}/logo`; 4. **204**. The source found is remembered for a year; "nobody has it" for 7 days; a transient failure is never remembered. |

Parameters are strict (unknown or repeated ones get 400). Aliases ("chevy", "vw", "mercedes", …) resolve to the catalog name.

- **We never call `/image`.** It is the endpoint that answers unknown cars and quota with an unmarked placeholder. The catalog answers unknown makes and models as data and quota as a 429. As a second guard, if the same bytes ever come back for two different vehicles they are treated as a placeholder: the hash is remembered, both copies are dropped, and that picture answers the fallback from then on.
- **Motorcycles**: `/api/v1/libraries` is asked once a day (cached); when the plan has no motorcycles, `type=moto` answers `moto-not-in-plan` with no further call. With motorcycles: the moto catalog's thumbnail.
- **Keys**: read at call time through `ProxyDeps.secret` (the function reads `Netlify.env`, else `process.env`). They go upstream only as `Authorization: Bearer` and `X-Api-Secret` headers, on calls made with `redirect: "error"` so a redirect can never carry them elsewhere, and never to the CDN hosts. Credential parameters (`api_key`, `token`, …) are stripped from every catalog link before it is kept, and a link that still contains a secret is dropped. A key that isn't printable ASCII of a sane length counts as not set and is never echoed. Missing keys: the routes answer the fallback (`not-configured`, `no-store`) and log one line, once per instance, that names no key. The logo route still works without keys (steps 1 and 3 need none).
- **Quota strategy**: own token buckets per service (CarImages per user 8 at once refilling 0.2/s, all users 20 refilling 0.5/s, under the 60/min limit; logo.dev smaller), separate from the map buckets. A rolling 24 h soft cap in Blobs (a bucket of `dailyCap` refilled at `dailyCap` a day; default 120 for CarImages, about 3,700 a month at most against the 5,000; 60 for logo.dev) spends one token per keyed call; past it the routes answer `quota` at once. A provider 429 starts a 15-minute cooldown shared by all instances. Cache hits never spend anything.
- **Caching**: photos 30 days, GLB 30 days, logos 1 year, catalog 7 days, libraries 1 day; browsers keep at most 7 days. Stale-while-error: an expired copy is served when the provider fails or the cap is reached. An expired catalog link (a 4xx on the download of a cached link) refreshes the catalog once.
- **The app** asks only after a model is picked from the vPIC list (photo) or a make the makes list knows (logo), and after typing settles (600 ms); once per URL per session. Pictures arrive as bytes and are shown through `blob:` URLs. Every failure shows our own type icon (photo) or car icon (logo), never error text. `viewFor(camera)`: Top → side, Driver A/B → front, Wide and Aftermath → front 3/4 (the default).
- **Exports**: `buildExports(req, canvas, media?)` takes an optional `VehicleMediaProvider`, injected like the canvas. The app gives only photos this session already showed (as PNG; WebP converted in the browser), so saving never spends a call; each answer waits at most 3 s. The PDF vehicles table gains a fixed-width photo cell only when a photo exists; the stills get a card per vehicle (letter and photo) along the bottom of the frame.
- **3D**: the GLB is only made available by URL (`vehicleModelUrl`). The viewer's own models are unchanged (roundB/colors owns the viewer). A GLB must be shown with its watermark when the header says so.

## Privacy
Only the make and model text and the model year leave the proxy (as catalog slugs and query text), and the make name for logos. No claim number, names, VINs, plates, positions, speeds or scene data, no user identifiers and no cookies. Upstream requests carry our User-Agent only.

## Options considered
- **`/image` with signed URLs**: one call per photo, but unknown cars and quota come back as unmarked placeholders, and the signed URL carries the key in its query string.
- **logo.dev's CDN with the publishable token through our server**: simplest, but against logo.dev's fair use; in the browser it would break the CSP.
- **Showing another model of the same make** when the model is unknown ("make-only" photo): rejected; on a claim, a photo of a different vehicle is misleading. The route says `make-only` so the app knows, and shows our icon.

## Only checkable after a deploy with real keys
- The real JSON shapes: generations' `images`/`sizes`, the `views` answer, the 3D model JSON (no example is published), `libraries.your_access`, logo.dev's `/v2/brands/logo` and `/v2/search`. The parsers are tolerant, and a shape we don't recognise reads as "no photo", but the happy path is only tested against our fake.
- That `Authorization: Bearer` + `X-Api-Secret` is accepted on every catalog route with our key, and that no domain allowlist blocks server-side calls (the docs say the secret skips the domain check).
- Whether catalog image URLs need the key to download (we strip `api_key`; if the CDN needs it, downloads fail and the photo falls back), and how long their signatures last (a cached link that expired refreshes the catalog once).
- Whether CDN downloads count against the quota (we count only keyed API calls).
- The 429 body and headers on quota, and the 60/min limit.
- Netlify's response size limit for a large GLB (we cap at 15 MB; a synchronous function response may be limited to 6 MB).
- The Blobs media store `csd-proxy-media` and the rolling daily cap across function instances.
- The logo.dev credit showing on production when a logo.dev logo is used.

Sources: packages/proxy/src/{media,make-domains,upstream,config}.ts, apps/web/src/services/{media,media-fixtures}.ts, apps/web/src/components/{MakeLogo,VehiclePhoto}.tsx, packages/exports/src/{index,pdf,png}.ts, packages/proxy/test/media.test.ts, apps/web/test/media.test.tsx, packages/exports/test/photos.test.ts, e2e/media.spec.ts.
