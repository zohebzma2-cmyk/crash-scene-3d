#!/bin/sh
# Second, independent look for private terms: git grep the committed tree for every entry of
# .privacy-terms, plus a review list of coordinate pairs in non-test source and docs.
# Used by /release-check. Read-only. Never prints a term or the matching text, only file:line.
#
#   sh scripts/grep-private.sh [ref]      (default HEAD)
#
# Exit 0 = nothing found, 1 = a private term matched, 2 = could not run.
# A plain line of .privacy-terms is a literal, case-insensitive match; /regex/flags is a regular
# expression (same format as scripts/privacy-scan.mjs). Coordinates you must never publish go in
# .privacy-terms as regex entries (for example /12\.3456\d*/); see .privacy-terms.example.
ref="${1:-HEAD}"
git rev-parse --verify -q "$ref^{commit}" >/dev/null || { echo "grep-private: '$ref' is not a commit in this repository" >&2; exit 2; }
top=$(git rev-parse --show-toplevel) || exit 2
terms="${PRIVACY_TERMS_FILE:-}"
if [ -z "$terms" ]; then
  terms="$top/.privacy-terms"
  if [ ! -f "$terms" ]; then
    common=$(git rev-parse --path-format=absolute --git-common-dir) || exit 2
    terms="$(dirname "$common")/.privacy-terms"
  fi
fi

status=0
if [ -f "$terms" ]; then
  # -P handles \s and \d like the Node scanner; fall back to -E where git has no PCRE.
  git grep -P -q -e . "$ref" -- README.md >/dev/null 2>&1
  if [ $? -le 1 ]; then flavor=-P; else flavor=-E; fi
  n=0
  hits=0
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    line=$(printf '%s' "$line" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
    case "$line" in ''|'#'*) continue ;; esac
    case "$line" in
      /*/*)
        body=${line#/}; flags=${body##*/}; body=${body%/*}
        case "$flags" in *i*) ci=-i ;; *) ci= ;; esac
        out=$(git grep -nI $ci $flavor -e "$body" "$ref" -- . ':(exclude).privacy-terms' 2>/dev/null)
        ;;
      *)
        out=$(git grep -nIiF -e "$line" "$ref" -- . ':(exclude).privacy-terms' 2>/dev/null)
        ;;
    esac
    rc=$?
    if [ "$rc" -gt 1 ]; then
      echo "grep-private: git grep failed on line $n of .privacy-terms (a pattern git cannot use?); nothing was verified" >&2
      exit 2
    fi
    found=$(printf '%s' "$out" | cut -d: -f2,3)
    if [ -n "$found" ]; then
      hits=$((hits + 1)); status=1
      printf 'private term (line %s of .privacy-terms) found at:\n' "$n"
      printf '%s\n' "$found" | sed 's/^/  /'
    fi
  done < "$terms"
  [ "$status" -eq 0 ] && echo "private terms: none of the entries in .privacy-terms appear in $ref"
else
  echo "private terms: no .privacy-terms file, so nothing to grep (copy .privacy-terms.example)"
fi

# Coordinate pairs outside tests and examples (tests and examples use made-up points on public roads).
out=$(git grep -nIE -e '-?[0-9]{1,3}\.[0-9]{4,}[ ]*,[ ]*-?[0-9]{1,3}\.[0-9]{4,}' "$ref" -- \
  apps/web/src 'packages/*/src' netlify e2e scripts README.md CLAUDE.md DESIGN.md PROGRESS.md docs ':(exclude)scripts/test' 2>/dev/null)
rc=$?
if [ "$rc" -gt 1 ]; then echo "grep-private: the coordinate grep failed; nothing was verified" >&2; exit 2; fi
coords=$(printf '%s' "$out" | cut -d: -f2,3)
if [ -n "$coords" ]; then
  echo "coordinate pairs to eyeball (not a failure; confirm each is a made-up point on a public road):"
  printf '%s\n' "$coords" | sed 's/^/  /'
else
  echo "coordinates: no coordinate pairs in non-test source or docs"
fi
exit "$status"
