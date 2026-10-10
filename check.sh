#!/usr/bin/env bash
# Everything that must pass before asking to push. Exits non-zero on the first failure.
set -euo pipefail
cd "$(dirname "$0")"
step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
step "typecheck";            npx --no-install tsc --noEmit -p tsconfig.json
step "lint";                 npx --no-install eslint .
step "stylelint";            npx --no-install stylelint "apps/web/src/**/*.css" --allow-empty-input
step "design tokens";        (cd design/prototype && npm run -s check)
step "unit tests";           npx --no-install vitest run
step "build";                npm run -s build
step "e2e (chromium + webkit @xb)"; npx --no-install playwright test
printf '\n\033[32mcheck.sh: all green\033[0m\n'
