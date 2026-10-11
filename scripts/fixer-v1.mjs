// The fixer as it was before round A (commit 8dde902), physics and all, for side-by-side benchmark numbers: its
// packages/core/src is unpacked from git into node_modules/.cache/fixer-v1 (ignored by git) the first time it is needed.
import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const BEFORE_SHA = "8dde902";
const root = fileURLToPath(new URL("..", import.meta.url));
export const V1_DIR = `${root}node_modules/.cache/fixer-v1`;
export const V1_CORE = `${V1_DIR}/packages/core/src/index.ts`;

export function ensureV1() {
  if (existsSync(V1_CORE)) return V1_CORE;
  mkdirSync(V1_DIR, { recursive: true });
  execSync(`git archive ${BEFORE_SHA} packages/core/src | tar -x -C "${V1_DIR}"`, { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
  return V1_CORE;
}
