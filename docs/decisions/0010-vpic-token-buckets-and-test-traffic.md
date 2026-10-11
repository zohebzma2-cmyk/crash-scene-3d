# 0010. vPIC token buckets, per-topic busy messages, and our own live test traffic

Status: Proposed, 2026-10-11 (asked for by the owner after the vehicles-step "map requests" report; the CLAUDE.md hard rule 6 wording is his to update).

## Context
- **The bug:** typing a make and model on the live vehicles step showed "We're getting a lot of map requests right now…".
- **Two causes** (docs/PROXY-BUSY.md):
  - vPIC was on the strict 1 req/s per-user slot, which refuses at once;
  - a model list is four vPIC calls, serialised on a 1 req/s global slot.
- **The wording:** the only busy message talked about the map.
- **Our own traffic:** about 115 live Playwright runs that evening shared the same global budget.

## Options considered
- **Queue vPIC per user** (like Overpass's 2 s reservation) and keep 1 req/s globally. This was rejected: a cold model list would still take 3+ s, and several people at once would still time out on the global slot.
- **Token buckets for vPIC,** like tiles and type-ahead. This was chosen.
- **For our test traffic:**
  - a dedicated test key with its own bucket, which needs a Netlify secret and a bypass path in the proxy;
  - or stubbing the routes a live spec isn't there to check. This was chosen.

## Decision
- **Buckets:** `ProviderConfig.vehiclesBurst`, separate from the map's buckets:
  - **Per user:** capacity 8, refill 1/s, one token per proxy request.
  - **Global:** capacity 16, refill 2/s, one token per vPIC call.
  - **Waiting:** up to 2.5 s for a token.
  - **Cache:** 30 days, shared through Blobs; hits take no token.
- **What changes from rule 6:** the per-user long-run rate stays 1 a second. The global long-run rate to vPIC goes from 1 to 2 calls a second, plus a burst of 16. With the 30-day shared cache, real traffic stays far below that.
- **Messages:** busy, timeout and upstream messages are per topic (map, search, vehicle list). A vehicle lookup never says "map".
- **App etiquette:** one request per make and year, under the makes list's spelling; session cache; a retry after Retry-After up to 2.5 s before any message.
- **Live runs:** e2e specs against a deployed copy answer `/api/vehicles/*` and `/api/geo/tile/*` inside the test (`e2e/live-guard.ts`). Only `e2e/live/vehicles.live.spec.ts` verifies vehicles live, once after a relevant deploy. There is no test key.

## Consequences
- **CLAUDE.md hard rule 6** should list vPIC next to tiles and terrain in its exception, for example: "NHTSA vPIC uses token buckets too: per user 8 refilling 1/s, all users 16 refilling 2/s per vPIC call." That is the owner's edit to make.
- **Logs:** every 429 is logged with its topic, service and limiter, so the next report can be traced from the function log.
- **Load test:** the README "Next version" proxy load test should include the vPIC buckets.
