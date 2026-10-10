// "Save to my device" really downloads: one ZIP holding the PDF, the pictures and the scene file. For each
// example the test catches the real download, unpacks the ZIP and checks EVERY file in it:
//   - the ZIP: exactly the expected names, nothing else (no folders, no stray files)
//   - the scene file: parses with the app's own schema (parseSceneFile), is canonical JSON, and its SHA-256 is
//     the fingerprint printed everywhere else
//   - the PDF: 1 or 2 pages, brand fonts embedded, the long disclaimer and the full fingerprint on every page,
//     the save time in the text and in CreationDate
//   - every PNG: decodes with the exports package's own PNG reader, exact size (stills 1920 x 1080, diagram
//     1600 x 1600, DESIGN.md section 8), and a footer band in the warning tint along the bottom
//   - the footer TEXT of every PNG: the stills and diagram carry no tEXt chunks (packages/exports/src/png.ts
//     draws the stamp as pixels), so the text is read where it is drawn: an init script records every fillText
//     on each canvas and, when the canvas is encoded, the SHA-256 of the PNG it produced. Each downloaded PNG is
//     matched to its canvas by hash, so the text checked is the text inside that exact file: the short
//     disclaimer, "Fingerprint <short>", the local stamp and the UTC stamp (= the scene file's createdAt).
//   - one timestamp across all files of the save.
// Tagged @xb: runs on Chromium and WebKit.
import { createHash } from "node:crypto";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { expect, test, type Page } from "@playwright/test";
import { canonicalJson } from "../packages/core/src/canonical";
import { DISCLAIMER_LONG, DISCLAIMER_SHORT } from "../packages/core/src/contracts/exports";
import { parseSceneFile } from "../packages/core/src/contracts/scene";
import { unzipStored } from "../packages/exports/src/zip";
import { decodePng } from "../packages/exports/src/png-decode";
import { pngText } from "../packages/exports/src/png-meta";
import { color } from "../packages/exports/src/style";

test.use({ acceptDownloads: true });

const EXAMPLES = ["t-bone-intersection", "highway-rear-end", "parking-lot-backing"] as const;
const CLAIM: Record<(typeof EXAMPLES)[number], string> = {
  "t-bone-intersection": "CLM-EX-1001", "highway-rear-end": "CLM-EX-1002", "parking-lot-backing": "CLM-EX-1003",
};

interface Drawn { w: number; h: number; sha: string; texts: string[] }

/** Records the text drawn on every 2D canvas and the SHA-256 of each PNG a canvas is encoded to. */
async function recordCanvasText(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const texts = new WeakMap<object, string[]>();
    const out: Array<{ w: number; h: number; sha: string; texts: string[] }> = [];
    (window as unknown as { __e2eDrawn: typeof out }).__e2eDrawn = out;
    const hook = (proto: { fillText: (t: string, x: number, y: number, m?: number) => void; canvas: unknown } | undefined) => {
      if (!proto) return;
      const orig = proto.fillText;
      proto.fillText = function (this: { canvas: object }, t: string, x: number, y: number, m?: number) {
        const list = texts.get(this.canvas) ?? [];
        list.push(String(t));
        texts.set(this.canvas, list);
        return m === undefined ? orig.call(this, t, x, y) : orig.call(this, t, x, y, m);
      };
    };
    hook(globalThis.OffscreenCanvasRenderingContext2D?.prototype as never);
    hook(globalThis.CanvasRenderingContext2D?.prototype as never);
    const hex = async (b: Blob) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", await b.arrayBuffer()))].map((x) => x.toString(16).padStart(2, "0")).join("");
    if (globalThis.OffscreenCanvas) {
      const orig = OffscreenCanvas.prototype.convertToBlob;
      OffscreenCanvas.prototype.convertToBlob = async function (this: OffscreenCanvas, opts?: ImageEncodeOptions) {
        const blob = await orig.call(this, opts);
        out.push({ w: this.width, h: this.height, sha: await hex(blob), texts: texts.get(this) ?? [] });
        return blob;
      };
    }
    const origToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (this: HTMLCanvasElement, cb: BlobCallback, type?: string, q?: number) {
      const { width: w, height: h } = this;
      const drawnHere = texts.get(this) ?? [];
      return origToBlob.call(this, (b) => {
        if (!b) { cb(b); return; }
        void hex(b).then((sha) => { out.push({ w, h, sha, texts: drawnHere }); cb(b); });
      }, type, q);
    };
  });
}

async function toSaveStep(page: Page, example: string) {
  await page.goto(`/?example=${example}`);
  const saveIt = page.getByRole("button", { name: /looks right: save it/i });
  await expect(saveIt).toBeVisible({ timeout: 30_000 });
  // The stills are taken from the 3D view: wait for its ready signal (the 2D fallback also sets it).
  await expect(page.locator(".viewer-canvas")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
  await saveIt.click();
  await expect(page.getByRole("heading", { level: 1, name: /what do you want to save/i })).toBeVisible({ timeout: 30_000 });
}

/** Click save; if building outlasted the tap window the app asks for one more tap. Returns the download. */
async function clickSave(page: Page) {
  const first = page.waitForEvent("download", { timeout: 45_000 }).catch(() => null);
  await page.getByRole("button", { name: /save to my device/i }).click();
  const dl = await Promise.race([first, page.getByRole("button", { name: /download your files/i }).waitFor({ timeout: 45_000 }).then(() => null)]);
  if (dl) return dl;
  const second = page.waitForEvent("download", { timeout: 30_000 });
  await page.getByRole("button", { name: /download your files/i }).click();
  return second;
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const hexToRgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];

for (const example of EXAMPLES) {
  test(`@xb save downloads one zip and every file in it checks out: ${example}`, async ({ page }, info) => {
    await recordCanvasText(page);
    await toSaveStep(page, example);
    const download = await clickSave(page);
    const claim = CLAIM[example];
    const base = `crash-scene-${claim}`;
    expect(download.suggestedFilename()).toBe(`${base}.zip`);
    const zipPath = info.outputPath(download.suggestedFilename());
    await download.saveAs(zipPath);
    const { readFile } = await import("node:fs/promises");
    const files = unzipStored(new Uint8Array(await readFile(zipPath)));
    const byName = new Map(files.map((f) => [f.name, f.bytes]));

    // ---- The ZIP: exactly these five files, no folders, no duplicates, nothing else.
    const expected = [`${base}-diagram.png`, `${base}-final-rest.png`, `${base}-impact.png`, `${base}.json`, `${base}.pdf`].sort();
    expect(files.map((f) => f.name).sort(), "the zip holds exactly the five files of one save").toEqual(expected);
    for (const f of files) {
      expect(f.name, "no folders or paths inside the zip").not.toMatch(/[/\\]/);
      expect(f.bytes.byteLength, `${f.name} is not empty`).toBeGreaterThan(100);
    }

    // ---- The scene file: the app's own schema, canonical form, fingerprint.
    const json = byName.get(`${base}.json`)!;
    const parsed = parseSceneFile(json);
    expect(parsed.ok ? [] : parsed.errors, "the scene file parses with the app's own schema").toEqual([]);
    const text = new TextDecoder().decode(json);
    expect(text, "the scene file is canonical JSON").toBe(canonicalJson(JSON.parse(text)));
    const sha = sha256(json);
    const short = sha.slice(0, 16).match(/.{4}/g)!.join(" ");
    const scene = JSON.parse(text) as { disclaimer: string; claim: { number: string }; createdAt: string; schemaVersion: number };
    expect(scene.claim.number).toBe(claim);
    expect(scene.schemaVersion).toBe(3);
    expect(scene.disclaimer).toBe(DISCLAIMER_LONG);
    expect(scene.createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    const stampLocal = await page.evaluate((iso) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short" }).format(new Date(iso)), scene.createdAt);
    // (Formatted in the page, not in Node: Node's ICU says "Oct 10, 2026 at 12:13 AM", browsers say "Oct 10, 2026, 12:13 AM".)

    // ---- The PDF: pages, embedded brand fonts, disclaimer + fingerprint on every page, the save time.
    const pdfBytes = byName.get(`${base}.pdf`)!;
    expect(new TextDecoder().decode(pdfBytes.subarray(0, 5))).toBe("%PDF-");
    const pdf = await getDocument({ data: pdfBytes.slice(), disableFontFace: true, useSystemFonts: false }).promise;
    // One page, or two when the assumptions don't fit at 8 pt (Zoheb's rule: never cut, move them to page 2).
    expect(pdf.numPages).toBeGreaterThanOrEqual(1);
    expect(pdf.numPages).toBeLessThanOrEqual(2);
    const pageTexts: string[] = [];
    const fonts = new Set<string>();
    for (let n = 1; n <= pdf.numPages; n++) {
      const p = await pdf.getPage(n);
      const tc = await p.getTextContent();
      pageTexts.push(tc.items.map((it) => ("str" in it ? it.str : "")).join(" ").replace(/\s+/g, " "));
      const ops = await p.getOperatorList();
      for (let i = 0; i < ops.fnArray.length; i++) {
        if (ops.fnArray[i] !== OPS.setFont) continue;
        const id = (ops.argsArray[i] as [string])[0];
        const font = p.commonObjs.get(id) as { name?: string; missingFile?: boolean };
        expect(font.missingFile, `font ${font.name} is embedded`).toBe(false);
        if (font.name) fonts.add(font.name.replace(/^[A-Z]{6}\+/, ""));
      }
    }
    const all = pageTexts.join(" ");
    expect([...fonts].some((f) => /PlusJakartaSans/i.test(f)), [...fonts].join(", ")).toBe(true);
    expect([...fonts].some((f) => /JetBrainsMono/i.test(f)), [...fonts].join(", ")).toBe(true);
    for (const [i, pt] of pageTexts.entries()) {
      expect(pt, `page ${i + 1}: disclaimer`).toContain(DISCLAIMER_LONG.replace(/\s+/g, " ").slice(0, 60));
      expect(pt.replace(/ /g, ""), `page ${i + 1}: full fingerprint`).toContain(sha);
    }
    expect(all).toContain(short);
    expect(all).toContain(`${base}.json`);
    expect(all, "the PDF prints the save time (UTC)").toContain(scene.createdAt);
    expect(all, "the PDF prints the save time (local)").toContain(stampLocal);
    const meta = await pdf.getMetadata();
    const created = (meta.info as { CreationDate?: string }).CreationDate;
    expect(created, "the PDF has a CreationDate").toBeTruthy();
    {
      const m = /^D:(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(Z|[+-]\d\d'?\d\d'?)?/.exec(created!);
      expect(m, `PDF CreationDate ${created}`).toBeTruthy();
      const [, y, mo, d, h, mi, s, tz] = m!;
      let ms = Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s!);
      if (tz && tz !== "Z") { const sign = tz[0] === "-" ? -1 : 1; const [th, tm] = tz.slice(1).replace(/'/g, "").match(/\d\d/g)!; ms -= sign * (+th! * 60 + +tm!) * 60_000; }
      expect(new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z"), "PDF CreationDate = the scene file's createdAt").toBe(scene.createdAt);
    }
    if (pdf.numPages === 2) {
      expect(pageTexts[0]).toMatch(/continued on page 2/i);
      expect(pageTexts[1]).toMatch(/A ?S ?S ?U ?M ?P ?T ?I ?O ?N ?S/i);
    }
    await pdf.cleanup();

    // ---- Every PNG: decodes, exact size, footer band, and the footer text drawn into that very file.
    const drawn = await page.evaluate(() => (window as unknown as { __e2eDrawn: Drawn[] }).__e2eDrawn);
    const tint = hexToRgb(color("color-warning-tint"));
    const sizes: Record<string, { width: number; height: number }> = {
      [`${base}-diagram.png`]: { width: 1600, height: 1600 },
      [`${base}-impact.png`]: { width: 1920, height: 1080 },
      [`${base}-final-rest.png`]: { width: 1920, height: 1080 },
    };
    const captions: Record<string, string> = { [`${base}-impact.png`]: "Moment of impact", [`${base}-final-rest.png`]: "Final rest", [`${base}-diagram.png`]: "Top-down diagram" };
    for (const [name, size] of Object.entries(sizes)) {
      const bytes = byName.get(name)!;
      const img = await decodePng(bytes);
      expect({ width: img.width, height: img.height }, `${name} size`).toEqual(size);
      expect(img.rgba.length).toBe(size.width * size.height * 4);
      // Not one flat color.
      const colors = new Set<number>();
      for (let i = 0; i < img.rgba.length; i += 4 * 997) colors.add((img.rgba[i]! << 16) | (img.rgba[i + 1]! << 8) | img.rgba[i + 2]!);
      expect(colors.size, `${name} has a real picture in it`).toBeGreaterThan(20);
      // The footer band: the last rows are mostly the warning tint (text sits on it).
      const row = img.height - 4;
      let tinted = 0;
      for (let x = 0; x < img.width; x++) {
        const o = (row * img.width + x) * 4;
        if (Math.abs(img.rgba[o]! - tint[0]) + Math.abs(img.rgba[o + 1]! - tint[1]) + Math.abs(img.rgba[o + 2]! - tint[2]) < 12) tinted++;
      }
      expect(tinted / img.width, `${name}: footer band along the bottom`).toBeGreaterThan(0.9);
      // Metadata: stills and the diagram write no tEXt chunks (only the PDF's map thumbnail does). If one ever
      // appears, it must not contradict the save.
      for (const [k, v] of Object.entries(pngText(bytes))) expect(`${k}=${v}`, `${name}: unexpected tEXt chunk`).toMatch(/^csd-/);

      // The text drawn into this exact file.
      const rec = drawn.find((d) => d.sha === sha256(bytes));
      expect(rec, `${name}: the canvas that made this file was seen (hash match)`).toBeTruthy();
      expect({ w: rec!.w, h: rec!.h }).toEqual({ w: size.width, h: size.height });
      const t = rec!.texts.join(" ").replace(/\s+/g, " ");
      expect(t, `${name}: caption`).toContain(captions[name]!);
      expect(t, `${name}: short disclaimer`).toContain(DISCLAIMER_SHORT);
      expect(t, `${name}: fingerprint`).toContain(`Fingerprint ${short}`);
      expect(t, `${name}: local timestamp`).toContain(stampLocal);
      expect(t, `${name}: UTC timestamp = the scene file's createdAt`).toContain(scene.createdAt);
      // One save, one time: no other ISO time is printed on the picture.
      const isoTimes = new Set(t.match(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ/g) ?? []);
      expect([...isoTimes], `${name}: a single timestamp`).toEqual([scene.createdAt]);
    }

    // ---- The page's stamp shows the same save.
    const stamp = page.getByTestId("stamp");
    await expect(stamp).toContainText(stampLocal);
    await expect(stamp).toContainText(short);
  });
}
