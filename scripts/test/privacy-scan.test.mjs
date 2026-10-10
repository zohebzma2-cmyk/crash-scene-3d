// Tests for scripts/privacy-scan.mjs and .githooks/pre-commit.
// Every fake secret is built at run time from pieces, so no string in this file looks like a real one.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mask, parseTerms, scanText } from "../privacy-scan.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const scanner = join(repoRoot, "scripts/privacy-scan.mjs");
const hook = join(repoRoot, ".githooks/pre-commit");

const rep = (s, n) => s.repeat(n);
const alnum40 = rep("aB3x", 10);
const fake = {
  github: "gh" + "o_" + alnum40,
  githubPat: "github" + "_pat_" + rep("Zq9_", 8),
  aws: "AK" + "IA" + rep("Q7", 8),
  openai: "s" + "k-" + "proj-" + rep("m4Kz", 6),
  anthropic: "s" + "k-" + "ant-" + rep("p8Lw", 6),
  netlify: "nf" + "p_" + rep("c2Vb", 9),
  resend: "r" + "e_" + "Xj3kYvB2" + "_" + rep("L9mQ", 6),
  slack: "xo" + "xb-" + "1234567890-" + rep("aZ", 6),
  keyBlock: "-----BEGIN " + "RSA PRIVATE KEY-----",
  assignment: "api" + "_key = \"" + rep("A1b2", 5) + "\"",
};
// Home-folder paths are assembled here too, so this file passes its own scan.
const who = "some" + "one";
const mac = `/Users/${who}/Developer/x`;
const rules = (text, terms) => scanText(text, "x.txt", terms).map((f) => f.rule);

describe("scanText: secrets", () => {
  for (const [name, value] of Object.entries(fake)) {
    it(`catches ${name}`, () => {
      const found = scanText(`const v = '${value}';`, "a.ts");
      expect(found.map((f) => f.rule)).toContain("secret");
      expect(found[0].line).toBe(1);
    });
  }

  it("never echoes the whole secret", () => {
    for (const value of Object.values(fake)) {
      const out = JSON.stringify(scanText(value, "a.ts"));
      expect(out).not.toContain(value);
      if (value.length > 20) expect(out).not.toContain(value.slice(0, 20));
    }
  });

  it("reports the line number", () => {
    const found = scanText(`one\ntwo\n${fake.aws}\n`, "a.ts");
    expect(found.map((f) => f.line)).toEqual([3]);
  });

  it("ignores ordinary code that only looks similar", () => {
    const ok = [
      "const apiKey = process.env.KEY;",
      "const risk-level = 'low'",
      "task-runner-configuration-for-the-whole-pipeline",
      "re_render_everything_on_every_change_now",
      "sk-this-is-just-a-long-css-class-name",
      "sha512-" + rep("Ab+/", 20),
      "AKIA is an AWS prefix",
      "api_key: 'short'",
    ];
    for (const line of ok) expect(scanText(line, "a.ts"), line).toEqual([]);
  });
});

describe("scanText: home paths", () => {
  it("catches macOS, Linux and Windows home folders", () => {
    expect(rules(`see ${mac}`)).toEqual(["home-path"]);
    expect(rules(`cd /home/${who}/work`)).toEqual(["home-path"]);
    expect(rules(`C:\\Users\\${who}\\Documents`)).toEqual(["home-path"]);
    expect(rules(`"C:\\\\Users\\\\${who}\\\\Documents"`)).toEqual(["home-path"]);
  });

  it("catches agent-style -Users-<name> paths and a bare /Users/<name> at the end", () => {
    expect(rules(`/private/tmp/claude-501/-Users-${who}/scratch`)).toEqual(["home-path"]);
    expect(rules(`~/.claude/projects/-Users-${who}-Developer-x`)).toEqual(["home-path"]);
    expect(rules(`cwd=/Users/${who}`)).toEqual(["home-path"]);
    expect(rules("/private/tmp/claude-501/-Users-Shared/x")).toEqual([]);
    expect(rules("/home/page")).toEqual([]);
  });

  it("does not print any leading character of the user name", () => {
    expect(JSON.stringify(scanText(mac, "a.md"))).not.toContain(who.slice(0, 2));
  });

  it("masks the user name", () => {
    expect(JSON.stringify(scanText(mac, "a.md"))).not.toContain(who);
  });

  it("allows generic placeholders", () => {
    for (const line of ["/Users/Shared/x", "/home/runner/work", "/Users/<name>/x", "/home/user/app", "C:\\Users\\Public\\x", "~/Developer", "/Users/ is the macOS home root"]) {
      expect(scanText(line, "a.md"), line).toEqual([]);
    }
  });
});

describe("scanText: private terms", () => {
  it("matches literals case-insensitively and regex entries", () => {
    const terms = parseTerms("# comment\n\nplaceholder word\n/ab+c\\d/\n");
    expect(rules("The PLACEHOLDER Word is here", terms)).toEqual(["private-term"]);
    expect(rules("xx abbbc7 yy", terms)).toEqual(["private-term"]);
    expect(rules("nothing here", terms)).toEqual([]);
  });

  it("treats regex metacharacters in a plain line literally", () => {
    const terms = parseTerms("1.5 (test)");
    expect(rules("1.5 (test)", terms)).toEqual(["private-term"]);
    expect(rules("1x5 test", terms)).toEqual([]);
  });

  it("never prints the term", () => {
    const terms = parseTerms("zzsecretterm");
    const out = JSON.stringify(scanText("a zzsecretterm b", "a.md", terms));
    expect(out).not.toContain("zzsecretterm");
    expect(out).toContain("line 1 of .privacy-terms");
  });

  it("reports a bad regex by line without printing it", () => {
    expect(() => parseTerms("fine\n/(unclosed/")).toThrow(/line 2/);
  });
});

describe("mask", () => {
  it("keeps four characters and a length", () => {
    expect(mask("abcdefghij")).toBe("abcd*** (10 chars)");
  });
});

describe("staged and tree scans in a throwaway repo", () => {
  const dir = mkdtempSync(join(tmpdir(), "privacy-scan-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  const git = (...args) => execFileSync("git", args, { cwd: dir, env, stdio: "pipe" });
  const run = (...args) => spawnSync("node", [scanner, ...args], { cwd: dir, env: { ...env, PRIVACY_TERMS_FILE: join(dir, "terms.txt") }, encoding: "utf8" });
  const runHook = () => spawnSync("sh", [hook], { cwd: dir, env: { ...env, PRIVACY_TERMS_FILE: join(dir, "terms.txt") }, encoding: "utf8" });
  const stage = (name, content) => {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), content);
    git("add", "--", name);
  };

  beforeEach(() => {
    rmSync(join(dir, ".git"), { recursive: true, force: true });
    git("init", "-q");
    writeFileSync(join(dir, "terms.txt"), "# test terms\nzzprivate-thing\n");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("passes a clean staged file", () => {
    stage("ok.txt", "hello world\n");
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("clean");
  });

  it("blocks a staged secret, with file:line, and masks it", () => {
    stage("src/a.ts", `// ok\nconst t = "${fake.github}";\n`);
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("src/a.ts:2: [secret] github-token");
    expect(r.stderr).not.toContain(fake.github);
  });

  it("blocks a staged home path", () => {
    stage("notes.md", `path: ${mac}\n`);
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("notes.md:1: [home-path]");
    expect(r.stderr).not.toContain(who);
  });

  it("blocks a staged private term from the terms file", () => {
    stage("notes.md", "fine\nhas a ZZPrivate-Thing inside\n");
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("notes.md:2: [private-term] matches entry on line 2 of .privacy-terms");
    expect(r.stderr).not.toContain("zzprivate");
  });

  it("only looks at added lines", () => {
    writeFileSync(join(dir, "old.txt"), `${fake.aws}\n`);
    git("add", "old.txt");
    git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", "old");
    writeFileSync(join(dir, "old.txt"), `${fake.aws}\nsecond line\n`);
    git("add", "old.txt");
    expect(run().status).toBe(0);
  });

  it("skips binary files", () => {
    writeFileSync(join(dir, "b.bin"), Buffer.concat([Buffer.from([0, 1, 2, 3]), Buffer.from(fake.aws)]));
    git("add", "b.bin");
    expect(run().status).toBe(0);
  });

  it("blocks a committed .privacy-terms file", () => {
    stage(".privacy-terms", "anything\n");
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("[terms-file]");
  });

  it("regression: a .gitattributes binary or -diff entry can't hide a staged text file", () => {
    writeFileSync(join(dir, ".gitattributes"), "*.svg binary\n*.lock -diff\n");
    git("add", ".gitattributes");
    stage("i.svg", `<svg data-export="${mac}/a.png"/>\n`);
    stage("p.lock", `cache: ${mac}\n`);
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("i.svg:1: [home-path]");
    expect(r.stderr).toContain("p.lock:1: [home-path]");
  });

  it("regression: --tree checks the names of binary files", () => {
    writeFileSync(join(dir, "zzprivate-thing-photo.png"), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));
    git("add", "zzprivate-thing-photo.png");
    git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", "x");
    const r = run("--tree", "HEAD");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("zzprivate-thing-photo.png");
  });

  it("scans a whole ref with --tree", () => {
    stage("a.ts", `const t = "${fake.netlify}";\n`);
    git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", "x");
    const bad = run("--tree", "HEAD");
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("a.ts:1: [secret] netlify-token");
    expect(run("--tree").status).toBe(1);
  });

  it("the pre-commit hook blocks and passes with the same rules", () => {
    stage("a.ts", `const t = "${fake.slack}";\n`);
    const bad = runHook();
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("Commit blocked");
    git("reset", "-q");
    stage("clean.ts", "export const a = 1;\n");
    expect(runHook().status).toBe(0);
  });

  it("fails closed on a bad terms file", () => {
    writeFileSync(join(dir, "terms.txt"), "/(oops/\n");
    stage("a.txt", "x\n");
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("could not scan");
  });

  it("regression: still scans with diff.noprefix or diff.mnemonicPrefix set", () => {
    for (const key of ["diff.noprefix", "diff.mnemonicPrefix"]) {
      git("config", key, "true");
      stage(`p-${key}.ts`, `const t = "${fake.github}";\n`);
      const r = run();
      expect(r.status, key).toBe(1);
      expect(r.stderr).toContain("[secret] github-token");
      git("reset", "-q");
      git("config", "--unset", key);
    }
  });

  it("regression: an added line starting with '++ ' does not hide the rest of the file", () => {
    stage("plus.md", `++ hi\nnext\nconst t = "${fake.aws}";\n`);
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("plus.md:3: [secret] aws-access-key");
  });

  it("regression: a text file with a binary-looking extension is scanned (staged and tree)", () => {
    stage("notes.ttf", `const t = "${fake.anthropic}";\n`);
    expect(run().stderr).toContain("notes.ttf:1: [secret]");
    git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", "x");
    const t = run("--tree");
    expect(t.status).toBe(1);
    expect(t.stderr).toContain("notes.ttf:1: [secret]");
  });

  it("scans file names for home paths and private terms", () => {
    stage("zzprivate-thing-notes.md", "harmless\n");
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("zzprivate-thing-notes.md: [private-term]");
    expect(r.stderr).toContain("(in the file name)");
  });

  it("tree mode refuses to skip a text file over 5 MB", () => {
    stage("big.txt", "a".repeat(80) + "\n" + ("abcdefghij".repeat(10) + "\n").repeat(52000));
    git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", "big");
    const r = run("--tree");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("big.txt: [unscanned]");
  });
});

describe("scripts/grep-private.sh", () => {
  const dir = mkdtempSync(join(tmpdir(), "grep-private-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  const git = (...args) => execFileSync("git", args, { cwd: dir, env, stdio: "pipe" });
  const sh = (terms, ...args) => {
    writeFileSync(join(dir, "terms.txt"), terms);
    return spawnSync("sh", [join(repoRoot, "scripts/grep-private.sh"), ...args], { cwd: dir, env: { ...env, PRIVACY_TERMS_FILE: join(dir, "terms.txt") }, encoding: "utf8" });
  };
  beforeEach(() => {
    rmSync(join(dir, ".git"), { recursive: true, force: true });
    git("init", "-q");
    writeFileSync(join(dir, "a.md"), "line one\nthe zzprivate-thing is here\n");
    git("add", "a.md");
    git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", "x");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("passes when no term matches, fails with file:line and no term text when one does", () => {
    expect(sh("nothing-like-this\n").status).toBe(0);
    const r = sh("# c\nZZPRIVATE-thing\n/is\\s+here/\n");
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("a.md:2");
    expect(r.stdout).not.toContain("zzprivate");
  });

  it("regression: a bad ref or an unusable regex exits 2 instead of reporting 'none found'", () => {
    const badRef = sh("x\n", "no-such-ref");
    expect(badRef.status).toBe(2);
    expect(badRef.stdout).not.toContain("none of the entries");
    const badRe = sh("fine\n/(unclosed/\n");
    expect(badRe.status).toBe(2);
    expect(badRe.stderr).toContain("line 2");
    expect(badRe.stdout).not.toContain("none of the entries");
  });
});
