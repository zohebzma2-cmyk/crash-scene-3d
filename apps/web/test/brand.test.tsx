// @vitest-environment jsdom
// The header shows the official InsurifyAI mark (an <img> from our own origin) and the wordmark as text.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { flush, renderApp } from "./helpers";
import { makeServices } from "./fakes";

let app: { unmount: () => void } | null = null;
afterEach(() => { app?.unmount(); app = null; });

describe("header logo", () => {
  it("renders the mark image and the text InsurifyAI, named InsurifyAI", async () => {
    app = await renderApp(makeServices().services);
    await flush();
    const logo = document.querySelector<HTMLAnchorElement>("header.app-header a.logo");
    expect(logo).not.toBeNull();
    expect(logo!.getAttribute("aria-label")).toBe("InsurifyAI");
    const img = logo!.querySelector("img.logo-mark");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("alt")).toBe("");
    // A file on our own origin (CSP img-src 'self'), not inline SVG or a third-party URL.
    expect(img!.getAttribute("src")).toMatch(/^\/[^/]*insurifyai-mark\.svg$/);
    expect(logo!.querySelector("svg")).toBeNull();
    expect(logo!.textContent).toBe("InsurifyAI");
    const word = logo!.querySelector(".logo-word")!;
    expect(word.firstChild?.textContent).toBe("Insurify");
    expect(word.querySelector("span")?.textContent).toBe("AI");
  });

  it("the old drawn shield is gone from the header", async () => {
    app = await renderApp(makeServices().services);
    expect(document.querySelector("header.app-header svg.logo-mark")).toBeNull();
  });
});

describe("no color literals in the web app", () => {
  const dir = join(process.cwd(), "apps/web/src");
  const files = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? files(join(d, f)) : [join(d, f)]));
  it("components and stylesheets use tokens only", () => {
    for (const f of files(dir).filter((x) => /\.(tsx?|css)$/.test(x) && !x.includes("/viewer/"))) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b|\brgba?\(\s*\d|\bhsla?\(\s*\d/);
    }
  });
});
