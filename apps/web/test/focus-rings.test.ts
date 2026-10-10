// jsdom can't compute :focus-visible, so the focus-ring rules are checked in the CSS itself.
// (A real-browser check is in test/screens.mjs: mouse click, then Tab.)
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dir = fileURLToPath(new URL("../src/styles/", import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith(".css"));
const css = files.map((f) => ({ f, text: readFileSync(dir + f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "") }));

/** Every rule as { selector, body }, including rules inside @media blocks. */
function rules(text: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push({ selector: (m[1] ?? "").trim(), body: m[2] ?? "" });
  return out;
}
const all = css.flatMap(({ f, text }) => rules(text).map((r) => ({ ...r, f })));

describe("focus rings are keyboard-only", () => {
  it("no rule draws a ring on plain :focus", () => {
    const bad = all.filter((r) => /:focus(?![-\w])/.test(r.selector) && /(outline|box-shadow|border)/.test(r.body) && !/outline:\s*none/.test(r.body));
    expect(bad.map((r) => `${r.f}: ${r.selector}`)).toEqual([]);
  });

  it("the one global ring is :focus-visible with the ring tokens", () => {
    const g = all.find((r) => r.selector === ":focus-visible");
    expect(g?.body).toContain("outline: var(--size-focus-ring) solid var(--color-focus-ring)");
    expect(g?.body).toContain("outline-offset: var(--size-focus-offset)");
  });

  it("every other ring on a focus selector uses :focus-visible and the same tokens", () => {
    const rings = all.filter((r) => /:focus-visible/.test(r.selector) && /outline:/.test(r.body) && r.selector !== ":focus-visible" && !/outline:\s*none/.test(r.body));
    expect(rings.length).toBeGreaterThan(0);
    for (const r of rings) expect(r.body, `${r.f}: ${r.selector}`).toContain("var(--color-focus-ring)");
  });

  it("the step title, which takes focus by script, never draws a ring", () => {
    const h1 = all.find((r) => r.selector.includes('h1[tabindex="-1"]:focus-visible'));
    expect(h1?.selector).toContain('h1[tabindex="-1"]:focus');
    expect(h1?.body).toMatch(/outline:\s*none/);
  });

  it("focus styles use no hard-coded colors or sizes", () => {
    for (const r of all.filter((x) => /:focus/.test(x.selector))) expect(r.body, `${r.f}: ${r.selector}`).not.toMatch(/#[0-9a-f]{3,8}\b|\d+px/i);
  });
});

describe("full size view width", () => {
  it("is not capped by the generic dialog width: it uses the content width token, with a viewport guard", () => {
    const rule = all.filter((r) => r.selector === ".full-size-dialog").map((r) => r.body).join(";");
    expect(rule).toMatch(/max-width:\s*min\(var\(--size-content-max\),\s*calc\(100vw - var\(--space-8\)\)\)/);
    expect(rule).toContain("width: min(100% - var(--space-8), var(--size-content-max))");
    // the generic dialog cap it overrides is narrower than the content width
    const tokens = readFileSync(fileURLToPath(new URL("../../../design/tokens.css", import.meta.url)), "utf8");
    const px = (name: string) => Number(new RegExp(`${name}:\\s*(\\d+)px`).exec(tokens)?.[1]);
    const rem = (name: string) => Number(new RegExp(`${name}:\\s*([\\d.]+)rem`).exec(tokens)?.[1]) * 16;
    expect(px("--size-content-max")).toBeGreaterThan(rem("--size-dialog-max"));
  });
});
