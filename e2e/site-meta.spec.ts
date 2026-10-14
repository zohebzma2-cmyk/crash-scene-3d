// Link previews and the files crawlers ask for (once, in desktop Chromium: these are plain HTTP checks):
//   - the page has a description, Open Graph tags and a large Twitter card, with an og:image that is a real
//     1200 x 630 PNG built into the site (no outside host)
//   - /favicon.ico is a real icon (the InsurifyAI mark at 16, 32 and 48 px), not the host's default
//   - /robots.txt is ours, and keeps crawlers off the /api/ proxy
// The preview server sends these with the page's headers (nosniff checked here; e2e/csp.spec.ts checks the CSP).
import { expect, test } from "./helpers";

const SITE = "https://crash-scene-3d.netlify.app";

/** Plain HTTP checks: the desktop Chromium project runs them; the others skip. */
const once = (): void => test.skip(test.info().project.name !== "desktop", "HTTP checks: once is enough");

test("the page describes itself for link previews, as an illustration", async ({ page }) => {
  once();
  await page.goto("/");
  const meta = (sel: string) => page.locator(`head meta[${sel}]`).getAttribute("content");
  const description = await meta('name="description"');
  expect(description).toMatch(/3D illustration/);
  expect(await meta('property="og:type"')).toBe("website");
  expect(await meta('property="og:title"')).toBe("Crash scene illustration · InsurifyAI");
  expect(await meta('property="og:description"')).toBe(description);
  expect(await meta('property="og:url"')).toBe(`${SITE}/`);
  expect(await meta('property="og:image"')).toBe(`${SITE}/og.png`);
  expect([await meta('property="og:image:width"'), await meta('property="og:image:height"')]).toEqual(["1200", "630"]);
  expect(await meta('property="og:image:alt"')).toMatch(/Illustration only/);
  expect(await meta('name="twitter:card"')).toBe("summary_large_image");
  expect(await meta('name="twitter:image"')).toBe(`${SITE}/og.png`);
  // Product wording: always an illustration; the preview tags never borrow the disclaimer's "reconstruction".
  const all = await page.locator("head meta[content]").evaluateAll((els) => els.map((e) => e.getAttribute("content") ?? "").join(" "));
  expect(all).not.toMatch(/reconstruct/i);
});

test("og.png is a 1200 x 630 PNG on our own origin", async ({ request }) => {
  once();
  const res = await request.get("/og.png");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toBe("image/png");
  expect(res.headers()["x-content-type-options"]).toBe("nosniff");
  const png = await res.body();
  expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
});

test("/favicon.ico is a real icon with the mark at 16, 32 and 48 px", async ({ request }) => {
  once();
  const res = await request.get("/favicon.ico");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toMatch(/^image\/(x-icon|vnd\.microsoft\.icon)/);
  const ico = await res.body();
  expect([ico.readUInt16LE(0), ico.readUInt16LE(2)]).toEqual([0, 1]);
  const sizes = Array.from({ length: ico.readUInt16LE(4) }, (_, i) => ico.readUInt8(6 + 16 * i));
  expect(sizes).toEqual([16, 32, 48]);
});

test("/robots.txt is ours and keeps crawlers off the proxy", async ({ request }) => {
  once();
  const res = await request.get("/robots.txt");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toMatch(/^text\/plain/);
  const text = await res.text();
  expect(text).toMatch(/^User-agent: \*$/m);
  expect(text).toMatch(/^Disallow: \/api\/$/m);
});
