#!/usr/bin/env node
// Privacy scanner: blocks secrets, home-folder paths and your own private terms from the repo.
// No dependencies. Needs Node 22+ and git.
//
//   node scripts/privacy-scan.mjs                 scan what is staged (added lines only); the pre-commit hook runs this
//   node scripts/privacy-scan.mjs --tree [ref]    scan every text file of a ref (default HEAD); /release-check runs this
//   node scripts/privacy-scan.mjs --terms <file>  read the private terms from this file instead of .privacy-terms
//
// Exit code 0 = clean, 1 = something found (or the scan could not run: it fails closed).
// Output is "path:line: [rule] what", and a secret is always masked, never printed in full.
//
// Rules
//   secret        known token shapes (GitHub, AWS, OpenAI/Anthropic, Netlify, Resend, Slack, Google, Stripe),
//                 private key blocks, and api_key = "..." assignments
//   home-path     /Users/<name>, /home/<name>/, C:\Users\<name>\, and the -Users-<name> form of agent paths
//                 (a few placeholder names are fine, see PLACEHOLDER_HOMES). File names are checked too, with private-term.
//   private-term  anything listed in .privacy-terms (untracked, one entry per line; see .privacy-terms.example)
//   terms-file    .privacy-terms itself must never be committed
//   unscanned     (tree mode) a text file over 5 MB; the scan fails rather than skip it
//
// Escape hatch: FIXTURE_ALLOW below is the only one. It is a list of exact paths + the one rule that may
// fire there. It is empty because nothing needs it: tests build fake tokens at run time.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Exact repo paths where one rule is allowed, e.g. { path: "x/fixture.txt", rule: "secret" }. Keep it empty if you can. */
export const FIXTURE_ALLOW = [];

/** Folder names after /Users/, /home/ or C:\Users\ that are generic, not a person. */
const PLACEHOLDER_HOMES = new Set([
  "shared", "runner", "user", "username", "yourname", "you", "name", "example", "default", "public", "all users", "guest",
]);

const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Token shapes. `needsDigit` skips snake_case identifiers that merely start the same way. */
const SECRET_RULES = [
  { id: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { id: "github-pat", re: /\bgithub_pat_[A-Za-z0-9_]{22,}/g },
  { id: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: "openai-anthropic-key", re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, needsDigit: true },
  { id: "netlify-token", re: /\bnfp_[A-Za-z0-9]{30,}\b/g },
  { id: "resend-key", re: /\bre_[A-Za-z0-9]{6,}_[A-Za-z0-9]{16,}\b/g, needsDigit: true },
  { id: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { id: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: "stripe-key", re: /\b[sr]k_live_[A-Za-z0-9]{16,}/g },
  { id: "private-key-block", re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g },
  { id: "api-key-assignment", re: /api[_-]?key['"]?\s*[:=]\s*['"][A-Za-z0-9]{16,}/gi },
];

// Each regex captures the folder name. /Users/<name> counts even at the end of a string; /home/<name> needs a
// trailing slash (a bare /home/page is just a web route). The -Users-<name> form is how Claude Code names a
// project folder and how agent scratch paths are written (e.g. .../-Users-<name>-Developer-x).
const HOME_RES = [
  /\/Users\/([A-Za-z0-9._-]+)/g,
  /\/home\/([A-Za-z0-9._-]+)(?=[/\\])/g,
  /[A-Za-z]:\\{1,2}Users\\{1,2}([A-Za-z0-9._][A-Za-z0-9._ -]*?)(?=[/\\])/g,
  /(?<![A-Za-z0-9])-Users-([A-Za-z0-9._]+)/g,
];

/** First 4 characters, then a length: enough to tell which token it was, not enough to use it. */
export function mask(text) {
  const head = text.slice(0, 4).replace(/[^\x20-\x7e]/g, "?");
  return `${head}*** (${text.length} chars)`;
}

/**
 * Load private terms from text. A line is a literal (case-insensitive) unless it is written /like this/ or
 * /like this/flags, which makes it a regular expression. Blank lines and lines starting with # are ignored.
 * Throws a plain Error naming the line of a bad regex (never its content).
 */
export function parseTerms(text) {
  const terms = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const m = /^\/(.+)\/([a-z]*)$/.exec(line);
    try {
      const re = m
        ? new RegExp(m[1], m[2].includes("g") ? m[2] : m[2] + "g")
        : new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      terms.push({ n: i + 1, re });
    } catch {
      throw new Error(`.privacy-terms line ${i + 1} is not a valid regular expression`);
    }
  });
  return terms;
}

/** Scan one text. Returns [{ file, line, rule, detail }]. `terms` comes from parseTerms. */
export function scanText(text, file, terms = []) {
  const found = [];
  const allowed = new Set(FIXTURE_ALLOW.filter((a) => a.path === file).map((a) => a.rule));
  const add = (line, rule, detail) => {
    if (!allowed.has(rule)) found.push({ file, line, rule, detail });
  };
  text.split(/\r?\n/).forEach((line, i) => {
    const n = i + 1;
    for (const rule of SECRET_RULES) {
      for (const m of line.matchAll(rule.re)) {
        if (rule.needsDigit && !/[0-9]/.test(m[0])) continue;
        add(n, "secret", `${rule.id}: ${mask(m[0])}`);
      }
    }
    for (const re of HOME_RES) {
      for (const m of line.matchAll(re)) {
        if (PLACEHOLDER_HOMES.has(m[1].toLowerCase())) continue;
        add(n, "home-path", `home folder path (user name of ${m[1].length} characters)`);
      }
    }
    for (const t of terms) {
      t.re.lastIndex = 0;
      if (t.re.test(line)) add(n, "private-term", `matches entry on line ${t.n} of .privacy-terms`);
    }
  });
  return found;
}

// ---- git plumbing -------------------------------------------------------------------------------

function git(args, opts = {}) {
  return execFileSync("git", ["-c", "core.quotepath=off", ...args], { maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], ...opts });
}

function isBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}

/**
 * Scan a file NAME (not its content) with the home-path and private-term rules.
 * Findings have line 0 and are printed without a line number.
 */
export function scanName(file, terms = []) {
  return scanText(file, file, terms)
    .filter((f) => f.rule === "home-path" || f.rule === "private-term")
    .map((f) => ({ ...f, line: 0, detail: `${f.detail} (in the file name)` }));
}

/**
 * Added lines of the staged change: [{ file, lines: [[lineNo, text], ...] }].
 * Real binary files have no added lines in a diff, so there is no extension filter: a text file called
 * notes.ttf is scanned. The prefixes are forced so a user's diff.noprefix / diff.mnemonicPrefix cannot change
 * the header format, and `+++` is only a header before the first hunk (a line "++ x" is added as "+++ x").
 * As a backstop, every staged file git calls text must have been parsed, or this throws (fail closed).
 */
export function stagedAdditions() {
  const flags = ["--cached", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-relative", "--diff-filter=ACMR"];
  const diff = git(["diff", ...flags, "--src-prefix=a/", "--dst-prefix=b/", "-U0"]).toString("utf8");
  const files = [];
  let cur = null;
  let inHeader = false;
  let lineNo = 0;
  for (const row of diff.split("\n")) {
    if (row.startsWith("diff --git ")) {
      cur = null;
      inHeader = true;
    } else if (inHeader && row.startsWith("+++ ")) {
      let p = row.slice(4).replace(/\t$/, "");
      if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
      cur = p.startsWith("b/") ? { file: p.slice(2), lines: [] } : null;
      if (cur) files.push(cur);
    } else if (row.startsWith("@@")) {
      inHeader = false;
      const m = /\+(\d+)/.exec(row);
      lineNo = m ? Number(m[1]) : 0;
    } else if (!inHeader && cur && row.startsWith("+")) {
      cur.lines.push([lineNo++, row.slice(1)]);
    }
  }
  // numstat -z: "<added>\t<deleted>\t<path>\0"; a binary file shows "-\t-". Text files with added lines must be in `files`.
  const seen = new Set(files.map((f) => f.file));
  for (const rec of git(["diff", ...flags, "--numstat", "-z"]).toString("utf8").split("\0").filter(Boolean)) {
    const [added, , ...path] = rec.split("\t");
    if (added === "-") {
      // git calls it binary (real binary content, or a .gitattributes `binary` / `-diff` entry): check the staged blob's
      // content, and scan the whole file when it is really text, so an attribute can't hide a text file from the hook.
      const p = path.join("\t");
      const buf = git(["cat-file", "blob", `:${p}`]);
      if (!isBinary(buf)) files.push({ file: p, lines: buf.toString("utf8").split(/\r?\n/).map((t, i) => [i + 1, t]) });
      continue;
    }
    if (Number(added) > 0 && !seen.has(path.join("\t"))) {
      throw new Error("a staged text file could not be read from the diff; commit is blocked rather than skipped (check your git diff settings)");
    }
  }
  return files;
}

/** Names of every staged added/changed file, binary or not. */
export function stagedNames() {
  return git(["diff", "--cached", "--name-only", "-z", "--no-renames", "--no-relative", "--diff-filter=ACMR"]).toString("utf8").split("\0").filter(Boolean);
}

/**
 * Files of a ref: [{ file, text }] for text, [{ file, problem }] for a file that cannot be scanned (too large), or
 * [{ file, skip: true }] for a binary file (a NUL byte in the first 8 KB, by content, never by extension) or a submodule
 * entry (type "commit", no blob): their contents aren't scanned but their names are. Any other read error throws.
 */
export function* treeFiles(ref) {
  const rows = git(["ls-tree", "-r", "-z", ref]).toString("utf8").split("\0").filter(Boolean);
  for (const row of rows) {
    const tab = row.indexOf("\t");
    const [, type, sha] = row.slice(0, tab).split(" ");
    const file = row.slice(tab + 1);
    // Submodules and binary files have no text to scan, but their names are still checked (skip: true).
    if (type === "commit") { yield { file, skip: true }; continue; }
    const buf = git(["cat-file", "blob", sha]);
    if (isBinary(buf)) { yield { file, skip: true }; continue; }
    if (buf.length > MAX_FILE_BYTES) yield { file, problem: `text file over ${MAX_FILE_BYTES / 1024 / 1024} MB was not scanned` };
    else yield { file, text: buf.toString("utf8") };
  }
}

/** .privacy-terms of this checkout, else of the main checkout (worktrees do not share untracked files). */
export function findTermsFile() {
  if (process.env.PRIVACY_TERMS_FILE) return process.env.PRIVACY_TERMS_FILE;
  const top = git(["rev-parse", "--show-toplevel"]).toString().trim();
  const here = resolve(top, ".privacy-terms");
  if (existsSync(here)) return here;
  const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"]).toString().trim();
  const main = resolve(dirname(common), ".privacy-terms");
  return existsSync(main) ? main : null;
}

// ---- command line -------------------------------------------------------------------------------

function main(argv) {
  let mode = "staged";
  let ref = "HEAD";
  let termsPath;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--tree") {
      mode = "tree";
      if (argv[i + 1] && !argv[i + 1].startsWith("--")) ref = argv[++i];
    } else if (argv[i] === "--terms") {
      termsPath = argv[++i];
      if (!termsPath) throw new Error("--terms needs a file");
    } else if (argv[i] === "--staged") {
      mode = "staged";
    } else {
      throw new Error(`unknown argument ${argv[i]} (use --staged, --tree [ref] or --terms <file>)`);
    }
  }
  termsPath ??= findTermsFile();
  let terms = [];
  if (termsPath) terms = parseTerms(readFileSync(termsPath, "utf8"));
  else console.error("privacy-scan: no .privacy-terms file found, so the private-term check is skipped (see .privacy-terms.example).");

  const findings = [];
  let files = 0;
  const termsFile = (file) => ({ file, line: 1, rule: "terms-file", detail: "this file holds your private terms and must never be committed" });
  if (mode === "staged") {
    for (const name of stagedNames()) findings.push(...scanNameOrTerms(name, terms));
    for (const f of stagedAdditions()) {
      files++;
      if (f.file === ".privacy-terms") continue;
      findings.push(...scanText(f.lines.map(([, t]) => t).join("\n"), f.file, terms).map((x) => ({ ...x, line: f.lines[x.line - 1][0] })));
    }
  } else {
    for (const f of treeFiles(ref)) {
      files++;
      findings.push(...scanNameOrTerms(f.file, terms));
      if (f.skip) continue;
      if (f.problem) findings.push({ file: f.file, line: 0, rule: "unscanned", detail: f.problem });
      else if (f.file !== ".privacy-terms") findings.push(...scanText(f.text, f.file, terms));
    }
  }
  function scanNameOrTerms(name, t) {
    return name === ".privacy-terms" ? [termsFile(name)] : scanName(name, t);
  }

  for (const f of findings) console.error(`${f.file}${f.line ? `:${f.line}` : ""}: [${f.rule}] ${f.detail}`);
  if (findings.length) {
    console.error(`privacy-scan: ${findings.length} problem${findings.length === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"}. Remove them or replace with placeholders.`);
    return 1;
  }
  console.log(`privacy-scan: clean (${files} ${mode === "staged" ? "staged " : ""}file${files === 1 ? "" : "s"}${mode === "tree" ? ` at ${ref}` : ""}${terms.length ? `, ${terms.length} private term${terms.length === 1 ? "" : "s"} checked` : ""}).`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`privacy-scan: could not scan: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
