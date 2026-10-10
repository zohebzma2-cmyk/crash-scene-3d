---
description: Run every pre-release gate (check.sh, privacy scan of HEAD, private-term and coordinate grep) and print a pass/fail table. Never pushes or deploys.
allowed-tools: Bash(./check.sh:*), Bash(node scripts/privacy-scan.mjs:*), Bash(sh scripts/grep-private.sh:*), Bash(git status:*), Bash(git log:*), Bash(git rev-parse:*)
---

# release-check

Run the gates below in order. Run every one even if an earlier one fails, then print the table. Do not fix anything during the run.

**This command never pushes, merges, publishes, deploys or creates a repository.** It does not run `git push`, `gh`, `npm publish`, `netlify`, `vercel`, `wrangler` or `firebase`. If everything passes, say so and stop: whether to push is Zoheb's call (CLAUDE.md hard rule 3). Never read `.env` files or `~/.ssh`. Never print the contents of `.privacy-terms`.

## Gates

1. **check.sh**: run `./check.sh` (typecheck, lint, stylelint, design tokens, unit tests, build, e2e). Record pass/fail and the first failing step.
2. **Privacy scan of HEAD**: run `node scripts/privacy-scan.mjs --tree HEAD`. It looks for secrets, home-folder paths and the terms in `.privacy-terms`. Exit 0 = pass. Its output is already masked; copy the `file:line: [rule]` lines into the report.
3. **Private terms and coordinates**: run `sh scripts/grep-private.sh HEAD`. This is a second, independent `git grep` of the committed tree for every entry of `.privacy-terms` (street, town, name, and coordinate patterns you put there as regex lines). Exit 0 = pass, 1 = fail; the output lists `file:line` only, never the term. The "coordinate pairs to eyeball" list is advisory: it passes, but read each line and say if any point is not a made-up spot on a public road. If there is no `.privacy-terms` file, mark this gate and gate 2's private-term part as **WARN: no terms file** (not PASS), because nothing private was checked.
4. **Clean tree**: run `git status --short`. Uncommitted changes are not covered by gates 2 and 3 (they scan `HEAD`). If anything is modified or untracked, mark **WARN** and name the files; for staged changes also run `node scripts/privacy-scan.mjs`.

## Report

Print exactly one table, then one line saying whether it is clear to ask Zoheb about pushing.

| Gate | Result | Detail |
|---|---|---|
| check.sh | PASS / FAIL | first failing step, or "all green" |
| privacy scan (HEAD) | PASS / FAIL | count, or the masked `file:line: [rule]` lines |
| private terms + coordinates | PASS / FAIL / WARN | `file:line` list, or "no terms file" |
| clean tree | PASS / WARN | modified or untracked files |

Any FAIL means not ready. A WARN means ready only after Zoheb has seen it. The commit SHA being checked (`git log -1 --format=%h`) goes in the line under the table.
