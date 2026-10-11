# Decisions

One short record per judgment call made in this build. Each says what was decided, what else was considered, and where it is recorded. Dates are from the notes and commits.

- [0001](0001-typed-speed-is-impact-speed.md) The typed speed is the speed at impact: worked back over 5 s, braking over the last 1.5 s.
- [0002](0002-osm-policies-and-own-proxy.md) OSM usage policies and our own /api proxy: one origin, one ProviderConfig, repo-URL contact, rate limits and the tile token-bucket exception.
- [0003](0003-no-bulk-tiles.md) No bulk tiles: the 204 cached tiles were removed; test mode draws the map from cached road data.
- [0004](0004-photon-typeahead-nominatim-on-submit.md) Photon for type-ahead; Nominatim on submit only.
- [0005](0005-zone-fallback-vs-honest-refusal.md) Zone fallback versus honest refusal, and the one-tap fixes.
- [0006](0006-one-zip-download.md) One ZIP download, with a second tap as fallback.
- [0007](0007-review-depth-by-risk.md) Full Opus review only for physics and security-sensitive code; visual changes by screenshot.
- [0008](0008-feature-freeze.md) Feature freeze after impact and aftermath; new ideas go to README "Next version".
- [0009](0009-fixer-learning.md) The one-tap fixer learns on the device only (kinds of fix picked, local, clearable) plus a regression corpus in the repo; cross-user learning only as a future opt-in.
