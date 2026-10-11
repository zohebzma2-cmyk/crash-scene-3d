# "A lot of map requests" on the vehicles step (2026-10-11)

## The report

On the live site's vehicles step, the owner saw "We're getting a lot of map requests right now. Please try again in a moment. Pick the type below." just from typing a year, make and model. That can't happen in normal use.

## Evidence

- **Function logs** (`netlify logs --source functions --since 24h`, read-only): only `Duration: … Memory Usage: …` lines and no warnings or errors. The proxy didn't log a 429, so the logs can't name the route. Every 429 is now logged as `proxy: busy topic=<map|search|vehicles> service=<service> limiter=<user|global>`, with no user key, query or address.
- **The message itself:** "… Pick the type below." is added only by the vehicle card (`apps/web/src/components/VehicleCard.tsx:80`), and only to a failed `/api/vehicles/models` lookup. Before it comes the proxy's one `BUSY_MESSAGE`, which every route used.
- **Reproduction:** `packages/proxy/test/vehicles-busy.test.ts` replays the app's requests on a fake clock, against the real `defaultProviderConfig()` and a fake vPIC. Committed first as `it.fails` (e2185fd), on the deployed code it gave:

  ```
  one claimant (makes, A's claim models, then B typed "chev" … "chevy"):
    claimant /api/vehicles/models?make=Honda&year=2021 → 429
    claimant /api/vehicles/models?make=chevy&year=2019 → 429
  four people opening the step at once, cold make/years:
    u1 /api/vehicles/models?make=Honda&year=2015 → 429
    u3 /api/vehicles/models?make=Chevrolet&year=2017 → 429
    u4 /api/vehicles/models?make=Honda&year=2018 → 429
  ```

## Root cause

Line numbers are at the deployed commit 2deab93.

1. **The limit that refuses: vPIC was on the strict 1 request/second per-user slot, and it refused at once.**
   - `packages/proxy/src/config.ts:46`: `limits: { minIntervalMs: 1000, perUserMinIntervalMs: 1000 }` applied to vPIC too.
   - `packages/proxy/src/upstream.ts:33`: `isBucketService` covered tiles, terrain and Photon, not `vehicles`.
   - `packages/proxy/src/upstream.ts:136`: for vehicles, a second request within a second of the last got an instant `busy`, with no queue.
   - Two ordinary moments send two vPIC requests within a second:
     - Opening the step sends the makes list (`apps/web/src/components/VehiclesStep.tsx:27`) and, 450 ms later, vehicle A's model list for the claim's make (`VehicleCard.tsx:27,72`).
     - A pause longer than 450 ms inside a typed make ("chev" … "y") sends one lookup per pause.
   - Each half-typed make was a new cache key (`apps/web/src/services/vehicles.ts:15`, `handler.ts` `norm(make)`), so these were cold misses that needed the slot.
2. **Global contention: a model list is four vPIC calls in a row, each needing the global 1 req/s slot.**
   - `packages/proxy/src/handler.ts:419` (makes) and `:437` (models) call car, mpv, truck and motorcycle one at a time.
   - Each call waits for `global:vehicles` (`upstream.ts:148`), which takes one call a second.
   - So one cold list holds the global vPIC slot for about 3 s. A second person's request (or one of our own live test runs) polls for at most `MAX_SLOT_WAIT_MS` = 1.2 s per call (`upstream.ts:7,150`) and then gets `busy`.
   - The owner's suspicion was partly right. The global vPIC slot is shared with everyone, including our ~115 live Playwright runs. They hit the vPIC global slot, not a map bucket (each service has its own key). What made it fragile was 1 req/s for a four-call lookup.
3. **The wording: one busy message for every route.**
   - `packages/core/src/contracts/proxy.ts:51` is "We're getting a lot of map requests …".
   - It was used by `busy()` at `upstream.ts:41` for vPIC too, and shown as is by `VehicleCard.tsx:80`.
4. **No retry in the app.** `apps/web/src/services/vehicles.ts:18` called `getJson` once; the first 429 went straight to the card.

**Cache check:**
- **Keys:** the 30-day composite key was already normalised (`norm(make)`, lowercased, with the year).
- **Storage:** it lives in the `csd-proxy-cache` Blobs store, which is shared by every function instance, so repeat lookups were hits that took no slot.
- **What was wrong:** the inner `vpic/…` keys kept the typed case. A list built from expired parts was cached as fresh for 30 days. Neither caused the 429.

## The fix

**Proxy (`packages/proxy`, `packages/core/src/contracts/proxy.ts`):**
- **Own buckets:** vPIC has its own token buckets, `ProviderConfig.vehiclesBurst`, separate from the map's:
  - **Per user:** 24 at once (six cold lists), refilling 1/s, one token per vPIC call. One person can never take more than half the global refill.
  - **All users:** 16 at once, refilling 2/s, one token per vPIC call.
  - **Waiting:** a request waits up to 2.5 s for a token (`VEHICLES_TOKEN_WAIT_MS`) before it is refused.
  - **Cache hits** take no token.
- **Side by side:** the four vPIC kinds are asked at once (`vpicAll`). Each call takes a user token and a global token.
- **Per-topic wording:** busy, timeout and upstream answers are worded per topic (`BUSY_MESSAGES` / `TIMEOUT_MESSAGES` / `UPSTREAM_MESSAGES`):
  - map: "We're getting a lot of map requests right now…";
  - search: "We're getting a lot of searches right now…";
  - vehicles: "The vehicle list is busy right now…".
- **Stale fallback:** an expired list is served stale when vPIC is down or the limit is reached. A list made from expired parts is not cached as fresh. The `vpic/` keys are lowercased.

**App (`apps/web/src/services`, the vehicle card's request behaviour):**
- **One request per make and year:**
  - The typed make is matched to the makes list ("chevy" is Chevrolet; case, spaces and hyphens don't matter), and the model list is asked for under the list's spelling.
  - Lists are cached for the session (memory and sessionStorage), and the model box filters them locally.
  - A make the list doesn't know waits 0.8 s more (`UNKNOWN_MAKE_WAIT_MS`), and typing on cancels the wait. A half-typed "chev" is never asked for; a real make vPIC knows but the list doesn't still is.
- **Retry before any message:** a 429 is retried after its Retry-After until 2.5 s of waiting (`retryBusy` / `getJsonRetrying` in `http.ts`). This covers vehicles, the Nominatim search, the roads around the pin and terrain tiles. Type-ahead and cross streets keep their own one retry (DESIGN.md "Busy").
- **Card wording:** only a real failure is shown, worded for the vehicle list: "The vehicle list is busy right now. Pick the type below."

## Request counts: "2019", "chevy", "silverado" for vehicle B, then A changed the same way

Measured with the same scripted typing (160 ms between keys, a 700 ms pause after "chev") in `apps/web/test/vehicle-lookups.test.tsx`, with the old and the new vehicle service:

| | Requests to /api/vehicles | Refused on a cold proxy (old limits) |
|---|---|---|
| Before | 4: makes, Honda 2021 (A's claim), **chev 2019**, **chevy 2019** | 2 (Honda 2021: 450 ms after makes; chevy: 650 ms after chev) |
| After | 3: makes, Honda 2021, **Chevrolet 2019** (shared by B and A) | 0. Three cold lists are 12 vPIC calls; the per-user bucket holds 24 |

The e2e (`e2e/vehicles-typing.spec.ts`) runs the real proxy code with its real limits behind the page. It sees at most 5 requests (the extra ones are Honda 2019, when the pause after A's year passes the debounce, and Ford 2019), none twice and none refused.

## Our own test and measuring traffic

- **The guard:** any e2e spec that runs against a deployed copy answers the vehicle lookups and map tiles inside the test (`e2e/live-guard.ts`, an auto fixture in `e2e/helpers.ts`; the live search specs use it too):
  - vehicle lookups go to the real proxy code with a fake vPIC;
  - map tiles get a neutral PNG;
  - search, crossing, type-ahead, Overpass and terrain stay live, since that is what the live checks verify.
- **One flow verifies vehicles live:** `e2e/live/vehicles.live.spec.ts` runs the owner's flow once after a deploy that touches the proxy or the vehicles step.
- **Scratch live checks** use `stubNonEssentialApi(page)` from `e2e/live-guard.ts`, and never loop.
- **No test key or bucket:** a dedicated test key would need a Netlify secret and a bypass path in the proxy that could leak. The stub approach is enough:
  - once our runs stop calling vPIC and tiles, what's left (a few searches) fits the same per-user limits a person has;
  - per-user buckets are per IP and day, so our runs only ever spend our own per-user budget;
  - the shared global buckets are what users notice, and the guard keeps our runs out of them.

See [decision 0010](decisions/0010-vpic-token-buckets-and-test-traffic.md).
