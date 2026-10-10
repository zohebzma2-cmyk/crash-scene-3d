# crash-scene-3d

> **Resuming work?** Read `PROGRESS.md` and `git log --oneline -20` first, and pick up exactly where they say. Commit after every passing step with a clear message, and update `PROGRESS.md` at each milestone and before any long step.

## Goal
A browser-based 3D reconstruction of a vehicle crash scene built from a few inputs: vehicles, positions, speeds, headings and impact point. It exists to **illustrate** what happened. It is not an expert analysis tool.

## Stack and layout
npm workspaces (install with `npx -y npm@11.20.0 install`; npm 10 crashes on Vitest's peer set):

| Path | What | Rules |
|---|---|---|
| `packages/core` | Contracts (zod Scene v3, RoadNetwork, SimulationResult, exports, proxy), physics, projection, streets at the pin, lane paths, placement, formatter, canonical JSON + SHA-256, presets | Pure TS. No DOM, no three, no React. SI units. Runs server-side later. |
| `packages/mapdata` | Overpass parsing to RoadNetwork, "X and Y" crossings, merged street segments, Terrarium decoding | Pure TS, fetch injected |
| `packages/exports` | PDF (pdf-lib, fonts embedded), PNGs (2D canvas, brand fonts), scene file | Canvas injected |
| `packages/proxy` + `netlify/functions/api.mts` | `/api/*` proxy for Nominatim, Overpass, tiles, Terrarium, NHTSA vPIC | Server-only; one ProviderConfig value |
| `apps/web` | Vite + React + react-three-fiber/drei + react-leaflet; the 4-step flow and the 3D viewer | Text only, never HTML |
| `examples/` | 3 made-up scenes on real public roads, with cached OSM road data (Overpass) + terrain | Tests never call live APIs |
| `design/` | Locked design: tokens, icons, prototype, before/after | Reference; don't edit without Zoheb |

Versions are pinned to releases at least two weeks old. TypeScript 6.0.3, because typescript-eslint doesn't support TS 7 yet.

## Commands
| Task | Command |
|---|---|
| Dev server | `npm run dev` (Vite, :5173) |
| Proxy locally | `npx -y netlify-cli@27.9.0 dev --offline --filter @csd/web` (asks first; :8888; see docs/DEPLOY.md) |
| Check headers | `npm run verify:headers -- http://localhost:8888 --local` |
| Unit tests | `npm test` |
| Typecheck / lint | `npm run typecheck`, `npm run lint` |
| Build / preview | `npm run build`, `npm run preview` (:4173) |
| E2E | `npm run e2e` (fixture mode) |
| Everything | `./check.sh` |

## Coding conventions
- Physics lives in pure functions under `packages/core/src/physics/` with **no Three.js imports**.
- Physics uses SI units only: meters, seconds, kilograms, radians, m/s.
- Conversion to scene units and degrees happens only at the rendering boundary, in one helper module.
- Ambiguous numbers carry a branded type or a suffix: `_m`, `_s`, `_mps`, `_rad`, `_deg`.
- Examples live in `examples/<name>/` (scene.json, osm.json, terrain/, ATTRIBUTION.md). Each one is loadable at `/?example=<name>`.
- Never put user or scene data into the DOM with `innerHTML`. Use `textContent` or DOM APIs.
- Dispose Three.js geometries, materials and textures when a scene is torn down. No allocations in the render loop.
- Edit `.ts`/`.tsx` files with the Edit/Write tools, not sed, so the post-edit typecheck/test hook fires.
- Run the `reviewer` subagent on the diff before committing anything non-trivial.
- **Every displayed number comes from the physics.** Distances, speeds, times and positions in the UI, PDF and PNGs are read from the simulation result through one formatter (DESIGN.md section 14). Numbers in DESIGN.md, the prototype and the design frames are sample data. Never copy them into app code or tests' expected values.

## Design contract
- The UI implements DESIGN.md and the design frames exactly. Read DESIGN.md before any UI work.
- Every color, font size, spacing, radius, shadow, duration and z-index is a `var(--…)` token from `design/tokens.css` (later `src/styles/tokens.css`). No hex, rgb, px font sizes or magic numbers in components.
- Three.js colors come from the token reader that resolves CSS variables. There are no color literals in scene code.
- A design change updates `design/tokens.css`, DESIGN.md, the Claude Design canvas and the prototype in the same commit. `npm run check:tokens` in `design/prototype` guards the tokens.
- At scaffold time, `npm run check` gains stylelint (`color-no-hex`, `declaration-strict-value` for color, spacing, radius and font-size) plus an ESLint rule banning color literals in `src/scene/`, so this is enforced.

## Map and geocoding rules (OSM usage policies)
- One `ProviderConfig` value (packages/proxy) holds the tile URL, the attribution, the geocoder URL and the User-Agent with its contact (the repo URL, https://github.com/zohebzma2-cmyk/crash-scene-3d). Switching provider or contact is a one-line change.
- Type-ahead uses Photon through `/api/geo/suggest` (debounced ~300 ms, ≥3 chars, cached, token-bucket limited, biased to the claim location / map view). Nominatim is the on-submit fallback only, never as-you-type, at most 1 request per second. Never reverse geocode. Intersections use `/api/geo/cross-streets` (Overpass).
- Tiles: visible attribution on the map and in the PDF. Load only the area in view; no bulk download or pre-fetching. No OSM tiles are stored in the repo: test mode (fixtures) draws the map locally from the examples' cached road data.
- PDF map thumbnail: drawn from tiles already loaded in the visible map, never by fetching tiles in a loop.
- User-Agent: the browser never calls a provider directly. The proxy sends `ProviderConfig.userAgent` on every upstream request, and scripts that call providers (fixture capture) send the same string.

## Hard rules
1. **Synthetic data only.** No real people, names, plates, VINs, claim numbers, addresses, photos or case files. **Exception (decided 2026-10-09):** public road geometry and street names from OSM are allowed in examples and tests, never house numbers or personal data.
2. **No API keys, tokens or secrets in the repo.** If one is ever needed, it goes in `.env` (gitignored) and is never read into the session.
3. **Never push, merge, publish or deploy without asking Zoheb first.** Local commits are fine.
4. **The physics is an illustration, not an expert reconstruction.** Every screen and every export carries the disclaimer from DESIGN.md section 3. Never describe output as an accident reconstruction, expert opinion, evidence of fault or testimony.
5. **Exports stay in the browser.** PNG, PDF and scene JSON are generated client-side and saved to the device. Nothing is uploaded. Every export carries the disclaimer, a timestamp and the SHA-256 fingerprint (DESIGN.md section 8).
6. **The browser only talks to its own origin.** Every outside call (Nominatim, Overpass, OSM tiles, Terrarium terrain, NHTSA vPIC) goes through the `/api/*` proxy, with caching, a 1 request/second limit (global and per user), timeouts and fallbacks. **Exception (Zoheb, 2026-10-09):** map tiles and terrain use token buckets, per user burst 64 refilling at 16/s plus a global cap, and tiles are cached at least 7 days while honoring OSM's cache headers. CSP `connect-src 'self'`. Provider details and any future keys live server-side in one `ProviderConfig` value.

## Guardrails
Enforced checks that go with the hard rules above (added 2026-10-10; nothing above changed):
- **Pre-commit hook** `.githooks/pre-commit` runs `scripts/privacy-scan.mjs` on the staged added lines and blocks the commit on a secret (GitHub, AWS, OpenAI/Anthropic, Netlify, Resend, Slack and similar tokens, private key blocks, `api_key = "..."`), a home-folder path (`/Users/<name>/`, `/home/<name>/`, `C:\Users\<name>\`) or a private term. **Turn it on once per clone:** `git config core.hooksPath .githooks` (git does not enable hooks by itself; agents must not run `git config` in a shared checkout without Zoheb's say-so). `git commit --no-verify` skips it; use that only in an emergency and run `/release-check` after.
- **`.privacy-terms`** is an untracked, git-ignored file in the repo root (one term per line, `/regex/i` for a regular expression, `#` comments). Put in it what must never reach the repo: the real address, town, names, coordinates, client names. Copy `.privacy-terms.example` to start. The file itself must never be committed, quoted in a commit message, or pasted into chat. In a worktree the scanner also looks in the main checkout.
- **`/release-check`** (`.claude/commands/release-check.md`) runs `./check.sh`, `node scripts/privacy-scan.mjs --tree HEAD`, the `.privacy-terms` and coordinate grep (`scripts/grep-private.sh`) and the clean-tree check, then prints a pass/fail table. It never pushes, deploys or creates a repo.
- Scanner tests: `scripts/test/privacy-scan.test.mjs` (run by `npm test`). Tests build fake tokens at run time; never commit a string that looks like a real secret.
