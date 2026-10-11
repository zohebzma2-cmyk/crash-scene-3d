# 0002. OSM usage policies and our own /api proxy

Status: Accepted, 2026-10-09 (tile rate and contact approved by Zoheb the same day).

## Context
The tool uses OpenStreetMap services (Nominatim, Overpass, tiles) plus Terrarium terrain and NHTSA vPIC. Each has a usage policy: an identifying User-Agent, rate limits, attribution and caching rules. A browser calling them directly cannot hold a User-Agent contact or enforce limits.

## Options considered
- A browser-side `mapProvider` config (the original sketch in DESIGN.md section 9, now marked superseded).
- A server-side proxy with one config value.
- Contact address: `crash-scene@insurifyai.app` was the first idea. It does not exist, so it was not used (PROGRESS.md, "User-Agent contact").
- Tile rate: strict 1 request/s for everything, or token buckets for tiles and terrain. A map view asks for about 20 tiles at once (PROGRESS.md, "Decision for Zoheb (B)").

## Decision
- The browser talks only to its own origin. Every outside call goes through `/api/*` (Netlify Function). CSP is `connect-src 'self'`.
- One `ProviderConfig` value in `packages/proxy` holds URLs, mirrors, User-Agent and contact, timeouts, rate limits and cache times. Switching provider or contact is a one-line change.
- The User-Agent contact is the repo URL, https://github.com/zohebzma2-cmyk/crash-scene-3d, held only in `ProviderConfig`. The proxy sends it on every upstream request; the fixture-capture script sends the same string.
- Nominatim, Overpass and vPIC: 1 request per second, globally and per user. (vPIC changed to token buckets on 2026-10-11, proposed in [0010](0010-vpic-token-buckets-and-test-traffic.md).)
- Exception for tiles and terrain (Zoheb, 2026-10-09): token buckets, per user burst 64 refilling at 16/s, plus a global bucket (burst 256, refill 64/s). Only real upstream calls take a token. Tiles are cached at least 7 days (terrain 30) and revalidated with ETag / If-Modified-Since.
- Attribution is visible on the map and printed under the PDF thumbnail.

## Consequences
- CLAUDE.md rule 6 records the exception.
- The browser never holds a provider key or the contact string.
- A proxy load test against the buckets is on the README "Next version" list.

Sources: 2a42ebc, 8dc3b18, 25112e8, 9ff8c90, CLAUDE.md "Map and geocoding rules" and hard rule 6, DESIGN.md sections 9 and 11, README architecture and privacy sections.
