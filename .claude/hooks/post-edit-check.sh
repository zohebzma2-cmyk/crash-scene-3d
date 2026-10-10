#!/usr/bin/env bash
# PostToolUse hook: after a TypeScript edit, run the typecheck and the unit
# tests related to the edited file. Silent on success. On failure, prints the
# output to stderr and exits 2 so Claude sees it and fixes it.
set -uo pipefail

input="$(cat)"
file="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')"

case "$file" in
  *.ts|*.tsx) ;;
  *) exit 0 ;;
esac

root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
cd "$root" || exit 0

# Not scaffolded yet: nothing to check.
[ -x node_modules/.bin/tsc ] || exit 0

fail=0
report=""

if ! tsc_out="$(npx --no-install tsc --noEmit -p tsconfig.json 2>&1)"; then
  fail=1
  report+=$'Typecheck failed:\n'"$(printf '%s\n' "$tsc_out" | head -n 40)"$'\n'
fi

if [ -f "$file" ]; then
  if ! test_out="$(npx --no-install vitest related "$file" --run --passWithNoTests 2>&1)"; then
    fail=1
    report+=$'\nRelated unit tests failed:\n'"$(printf '%s\n' "$test_out" | tail -n 60)"$'\n'
  fi
fi

if [ "$fail" -ne 0 ]; then
  printf 'post-edit check for %s\n%s' "$file" "$report" >&2
  exit 2
fi
exit 0
