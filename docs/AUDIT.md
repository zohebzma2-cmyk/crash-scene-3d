# npm audit triage

Run on 2026-10-09 with `npx -y npm@11.20.0 audit --json` and `... audit --omit=dev --json`, on the
lockfile of branch `chore/deploy-prep`. That lockfile is identical to `main`'s: this branch adds no
dependency. The Netlify CLI is called through exact-pinned `npx -y netlify-cli@27.9.0`, so it is never
installed in the workspace and never enters the lockfile.

## Result

| Run | info | low | moderate | high | critical | total |
|---|---|---|---|---|---|---|
| `npm audit` (everything) | 0 | 0 | 0 | 6 | 0 | 6 |
| `npm audit --omit=dev` (what ships) | 0 | 0 | 0 | **0** | 0 | **0** |

**Nothing that ships is affected.** All 6 sit in one dev-only tree, `stylelint`.

- The browser bundle (`apps/web`) and the function bundle (`netlify/functions/api.mts`) contain none of these packages.
- The function package holds `@netlify/blobs`, `@netlify/otel`, `@netlify/runtime-utils` and `zod`, plus the workspace code that esbuild inlines.

No dependency was changed because of this audit. The rule was to apply only safe patch or minor upgrades
for items that are reachable in production, and there are none. `npm audit fix --force` was not run, and
should not be: it suggests `stylelint@7.7.0`, a downgrade by ten major versions.

## The advisory

All 6 entries come from one advisory.

| Package (installed) | Severity | Advisory | Shipped in | Reachable from our code? | Fixed in | Recommendation |
|---|---|---|---|---|---|---|
| `braces` 3.0.3 | high (7.5) | [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm): stack exhaustion on deeply nested brace patterns | dev only: `stylelint` → `micromatch` → `braces` | No. It needs an attacker-chosen glob pattern. `stylelint` only expands the pattern we write (`apps/web/src/**/*.css`). | Nothing yet: 3.0.3 is the latest release and the range is `<=3.0.3` | **Accept.** Re-run the audit when `braces` publishes a fix. Do not override to a pre-release. |

## All 6 entries

| Package | Severity | Direct? | Shipped in | Fix |
|---|---|---|---|---|
| `braces` | high | no | dev only | none yet |
| `micromatch` | high | no | dev only | follows `braces` |
| `fast-glob` | high | no | dev only | follows `braces` |
| `globby` | high | no | dev only | follows `braces` |
| `stylelint` | high | **yes** | dev only | follows `braces` |
| `stylelint-declaration-strict-value` | high | **yes** | dev only | follows `stylelint` |

This was already so on `main` (PROGRESS.md notes "`npm audit` reports issues in the dev tree").

## The Netlify CLI

A trial that installed `netlify-cli@27.9.0` as a devDependency added 944 packages and 13 more highs,
none reachable from our code and none shipped:

- `node-forge` 1.4.0, GHSA-86w9-cpqp-85rv. No fix was published.
- `sharp` 0.34.5, three libvips, libheif and librsvg advisories. Fixed in 0.35.0, 0.35.4 and 0.35.5.
- Packages that only carry those, and `braces` again, through `@netlify/*`.

It was dropped: `npx -y netlify-cli@27.9.0` fetches it on demand into npm's cache. That keeps the lockfile and this report
free of it. The cost is that `npx` downloads it the first time and its own advisories are not tracked here, so
if you use it, treat it as a local tool: don't run `netlify dev --https` (the `node-forge` path) on a shared network.

## What "reachable" means here

- **Browser bundle:** `npm audit --omit=dev` reports 0. None of these packages is imported by `apps/web`.
- **Function bundle:** esbuild inlines the workspace code and leaves two npm packages external (`@netlify/blobs`, `zod`).
- **Dev tools:** `stylelint` reads our CSS files and takes no input from the internet.

## Re-check

Run both audits again before each deploy. Anything that appears in `--omit=dev` is a blocker: fix it before
shipping, with an exact pinned version at least two weeks old.
