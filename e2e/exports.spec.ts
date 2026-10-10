// 3. Exports for each example: file names, fingerprint = SHA-256 of the scene file, the PDF's words,
// PNG sizes, and one timestamp shared by every file of one save. Files never leave the browser
// except through the download, which Playwright catches.
import type { Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { unzipStored } from "../packages/exports/src/zip";
import {
  DISCLAIMER_LONG_START, EXAMPLES, LONG_DISCLAIMER, expect, flat, openExample, pdfText, pngDiff, pngSize, saveFiles, sha256, test,
  type ExampleName,
} from "./helpers";


/** Canonical JSON as DESIGN.md section 8 defines it: keys sorted, no whitespace. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

async function claimOf(name: ExampleName): Promise<string> {
  const scene = JSON.parse(await readFile(new URL(`../examples/${name}/scene.json`, import.meta.url), "utf8")) as { claim: { number: string } };
  return scene.claim.number;
}

/** Review → "Looks right: save it" (takes the 3D stills) → Save with PDF + pictures. */
async function saveAll(page: Page, claim: string): Promise<Map<string, { bytes: Buffer }>> {
  await page.getByRole("button", { name: "Looks right: save it" }).click();
  await expect(page.locator("#app")).toHaveAttribute("data-step", "export");
  await expect(page.locator("input[name=fmt][value=pdf]")).toBeChecked();
  await expect(page.locator("input[name=fmt][value=png]")).toBeChecked();
  // One save = one download: crash-scene-<claim>.zip with every file in it.
  const saved = await saveFiles(page);
  expect(saved.name).toBe(`crash-scene-${claim}.zip`);
  const out = new Map<string, { bytes: Buffer }>();
  for (const [n, bytes] of saved.files) out.set(n, { bytes });
  return out;
}

for (const name of EXAMPLES) {
  test.describe(`exports for ${name}`, () => {
    test("files, fingerprint, PDF words, PNG sizes and one timestamp", async ({ page, pageErrors }) => {
      const claim = await claimOf(name);
      await openExample(page, name);
      const files = await saveAll(page, claim);
      const base = `crash-scene-${claim}`;
      expect([...files.keys()].sort()).toEqual([`${base}-diagram.png`, `${base}-final-rest.png`, `${base}-impact.png`, `${base}.json`, `${base}.pdf`].sort());

      // The scene file: canonical JSON, and its SHA-256 is the fingerprint.
      const jsonBytes = files.get(`${base}.json`)!.bytes;
      const jsonText = jsonBytes.toString("utf8");
      const scene = JSON.parse(jsonText) as { createdAt: string; schemaVersion: number; disclaimer: string; claim: { number: string } };
      expect(jsonText, "the scene file is saved in canonical form").toBe(canonical(scene));
      expect(scene.schemaVersion).toBe(3);
      expect(scene.claim.number).toBe(claim);
      expect(scene.disclaimer).toBe(LONG_DISCLAIMER);
      expect(scene.createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
      const hex = sha256(jsonBytes);
      const short = hex.slice(0, 16).match(/.{4}/g)!.join(" ");

      // The PDF: fingerprint (full + short), disclaimer, speed wording, "about", and the timestamp.
      const pdf = await pdfText(files.get(`${base}.pdf`)!.bytes);
      const text = flat(pdf.pages.join("\n"));
      const squashed = text.replace(/\s+/g, "");
      expect(squashed, "full fingerprint in the PDF").toContain(hex);
      const printed = /How to check this file.*?([0-9a-f]{64})/.exec(squashed.replace(/Howtocheckthisfile/, "How to check this file"));
      expect(printed?.[1], "the 64-character fingerprint printed after 'How to check this file'").toBe(hex);
      expect(text).toContain(short);
      expect(text).toContain(DISCLAIMER_LONG_START);
      expect(squashed).toContain(LONG_DISCLAIMER.replace(/\s+/g, ""));
      expect(text).toContain("Speed at impact, as entered");
      expect(text).toMatch(/\babout\b/);
      expect(text).toContain(scene.createdAt);
      const created = pdf.info.CreationDate as string | undefined;
      if (created) {
        // D:YYYYMMDDHHmmSS[Z|+hh'mm'] — compare as instants.
        const m = /^D:(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(Z|[+-]\d\d'?\d\d'?)?/.exec(created);
        expect(m, `PDF CreationDate ${created}`).toBeTruthy();
        const [, y, mo, d, h, mi, s, tz] = m!;
        let ms = Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s!);
        if (tz && tz !== "Z") { const sign = tz[0] === "-" ? -1 : 1; const [th, tm] = tz.slice(1).replace(/'/g, "").match(/\d\d/g)!; ms -= sign * (+th! * 60 + +tm!) * 60_000; }
        expect(new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z")).toBe(scene.createdAt);
      }

      // The PNGs: 1920×1080 for the stills, 1600×1600 for the diagram.
      expect(pngSize(files.get(`${base}-impact.png`)!.bytes)).toEqual({ width: 1920, height: 1080 });
      expect(pngSize(files.get(`${base}-final-rest.png`)!.bytes)).toEqual({ width: 1920, height: 1080 });
      expect(pngSize(files.get(`${base}-diagram.png`)!.bytes)).toEqual({ width: 1600, height: 1600 });

      // One timestamp and one fingerprint for the whole save: the page's stamp shows the same ones.
      // (The PNG footers carry the same stamp as pixels; they aren't OCR'd here.)
      const local = await page.evaluate((iso) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short" }).format(new Date(iso)), scene.createdAt);
      const stamp = page.getByTestId("stamp");
      await expect(stamp).toContainText(local);
      await expect(stamp).toContainText(short);
      expect(text).toContain(local);
      expect(pageErrors()).toEqual([]);
    });

    test("the impact and final-rest stills show different moments", async ({ page }) => {
      const claim = await claimOf(name);
      await openExample(page, name);
      // Leave the picture somewhere that is neither impact nor Wide, as a claimant might.
      await page.getByRole("slider", { name: "Timeline" }).focus();
      await page.keyboard.press("Home");
      await page.locator(".viewer-canvas").focus();
      await page.keyboard.press("1");
      const files = await saveAll(page, claim);
      const impact = files.get(`crash-scene-${claim}-impact.png`)!.bytes;
      const rest = files.get(`crash-scene-${claim}-final-rest.png`)!.bytes;
      // Only the 3D part, below the caption badge and above the footer band (rows 120–933).
      const changed = await pngDiff(page, impact, rest, [120, 933]);
      // The vehicles move between impact and final rest: a real pair differs well beyond noise.
      expect(changed, `share of pixels that differ: ${changed}`).toBeGreaterThan(0.002);

    });

    test("the stills don't depend on where the claimant left the picture", async ({ page }) => {
      const claim = await claimOf(name);
      const takeFrom = async (key: string, view: string) => {
        await page.goto("about:blank");
        await openExample(page, name);
        await page.getByRole("slider", { name: "Timeline" }).focus();
        await page.keyboard.press(key);
        await page.locator(".viewer-canvas").focus();
        await page.keyboard.press(view);
        const f = await saveAll(page, claim);
        return { impact: f.get(`crash-scene-${claim}-impact.png`)!.bytes, rest: f.get(`crash-scene-${claim}-final-rest.png`)!.bytes };
      };
      const a = await takeFrom("Home", "1");   // Top, 5 s before impact
      const b = await takeFrom("i", "2");      // Wide, at impact
      // Only the 3D part (rows 120-933); the footer carries each save's own time.
      const d1 = await pngDiff(page, a.impact, b.impact, [120, 933]);
      const d2 = await pngDiff(page, a.rest, b.rest, [120, 933]);
      // Regression guard, fixed 2026-10-09 (still depends on the live view): on integ/m2 658a90b the final-rest still taken while the live view
      // is Top has no street names painted on the road (WATER STREET / MAIN STREET), while one taken from Wide
      // has them (t-bone, about 0.5-0.7% of pixels). The lead's uncommitted m2 tree (viewer/still-camera.ts,
      // StreetNames.tsx, capture.ts) already fixes it; the trial on :4190 passes. Flip to a plain test once committed.
      expect(d1, `impact stills from two different live views differ by ${d1}`).toBeLessThan(0.002);
      expect(d2, `final-rest stills from two different live views differ by ${d2}`).toBeLessThan(0.002);
    });
  });
}

test("a slow save asks for one more tap, then delivers the same single ZIP", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "CPU throttling goes through the Chrome DevTools Protocol (Chromium only)");
  // Browsers only start a download shortly after a tap; past about 3 s the app asks for "Download your files".
  // A 20x CPU slowdown (Chromium DevTools) makes the build outlast that window.
  const claim = await claimOf("parking-lot-backing");
  await openExample(page, "parking-lot-backing");
  await page.getByRole("button", { name: "Looks right: save it" }).click();
  await expect(page.locator("#app")).toHaveAttribute("data-step", "export");
  await expect(page.locator(".preview-frame")).not.toContainText("Making the preview", { timeout: 60_000 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 20 });
  const downloads: string[] = [];
  page.on("download", (d) => downloads.push(d.suggestedFilename()));
  await page.getByRole("button", { name: "Save to my device" }).click();
  const again = page.getByRole("button", { name: "Download your files" });
  await expect(again).toBeVisible({ timeout: 120_000 });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  expect(downloads, "nothing is downloaded before the second tap").toEqual([]);
  // (The "Your files are ready" toast times out after --duration-toast, so under the slowdown it can be gone already.)
  await expect(again).toBeEnabled();
  await expect(page.getByRole("button", { name: "Save to my device" })).toHaveCount(0);
  const dl = page.waitForEvent("download");
  await again.click();
  const download = await dl;
  expect(download.suggestedFilename()).toBe(`crash-scene-${claim}.zip`);
  const files = unzipStored(new Uint8Array(await readFile(await download.path())));
  expect(files.map((f) => f.name).sort()).toEqual([`crash-scene-${claim}-diagram.png`, `crash-scene-${claim}-final-rest.png`, `crash-scene-${claim}-impact.png`, `crash-scene-${claim}.json`, `crash-scene-${claim}.pdf`].sort());
  await page.waitForTimeout(600);
  expect(downloads).toHaveLength(1);
  await expect(again).toHaveCount(0);
});
