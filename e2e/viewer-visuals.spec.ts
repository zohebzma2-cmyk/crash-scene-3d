// The 3D viewer's visual contract, in a real browser (headless Chromium with SwiftShader WebGL), against the
// fixtures build. Uses the test hook the viewer installs in fixtures builds (window.__csdViewer).
//   - at impact in Top, the pixel masks of A and B (taken with the other hidden) overlap by at most 2 px
//   - stills render at the time asked for, offscreen: impact and final rest differ, the live picture doesn't move
//   - labels never overlap each other, the view controls, the zoom buttons or the caption
//   - a plain wheel scrolls the page (never prevented); ctrl + wheel zooms; the hint shows once; buttons and keys zoom
import { expect, test, type Page } from "@playwright/test";
import { pngDiff } from "./helpers";

const EXAMPLES = ["t-bone-intersection", "highway-rear-end", "parking-lot-backing"] as const;

async function open(page: Page, name: string): Promise<void> {
  await page.goto(`/?example=${name}#review`);
  await page.waitForSelector(".viewer3d canvas", { timeout: 30_000 });
  await page.waitForFunction(() => Boolean((window as unknown as { __csdViewer?: { camera(): unknown } }).__csdViewer?.camera()), undefined, { timeout: 30_000 });
  await page.waitForTimeout(1200);
}

const pickView = async (page: Page, label: string) => { await page.getByRole("radio", { name: label, exact: true }).click(); await page.waitForTimeout(700); };

test.describe("silhouettes at impact", () => {
  for (const name of EXAMPLES) {
    test(`${name}: A and B overlap by at most 2 px in Top`, async ({ page }) => {
      await open(page, name);
      await pickView(page, "Top");
      const size = await page.evaluate(() => { const c = document.querySelector(".viewer3d canvas")!.getBoundingClientRect(); return { width: Math.round(c.width), height: Math.round(c.height) }; });
      const result = await page.evaluate(async (sz) => {
        type Hook = { captureStill(t: number, v: string, s: { width: number; height: number }): Promise<Uint8Array>; hide(id: string, h: boolean): void };
        const hook = (window as unknown as { __csdViewer: Hook }).__csdViewer;
        const px = async (bytes: Uint8Array) => {
          const bmp = await createImageBitmap(new Blob([bytes as BlobPart]));
          const c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height;
          const g = c.getContext("2d")!; g.drawImage(bmp, 0, 0);
          return g.getImageData(0, 0, c.width, c.height);
        };
        hook.hide("A", true); hook.hide("B", true);
        const bg = await px(await hook.captureStill(0, "top", sz));
        hook.hide("A", false);
        const a = await px(await hook.captureStill(0, "top", sz));
        hook.hide("A", true); hook.hide("B", false);
        const b = await px(await hook.captureStill(0, "top", sz));
        hook.hide("A", false);
        const mask = (img: ImageData) => {
          const m = new Uint8Array(img.width * img.height);
          for (let i = 0; i < m.length; i++) {
            const d = Math.abs(img.data[i * 4]! - bg.data[i * 4]!) + Math.abs(img.data[i * 4 + 1]! - bg.data[i * 4 + 1]!) + Math.abs(img.data[i * 4 + 2]! - bg.data[i * 4 + 2]!);
            const r = img.data[i * 4]!, gr = img.data[i * 4 + 1]!, bl = img.data[i * 4 + 2]!;
            const saturated = Math.max(r, gr, bl) - Math.min(r, gr, bl) > 80;   // body paint (blue, orange); grey ground and shadows are not
            m[i] = d > 120 && saturated ? 1 : 0;
          }
          return m;
        };
        const ma = mask(a), mb = mask(b);
        let both = 0, na = 0, nb = 0, minX = 1e9, maxX = -1, minY = 1e9, maxY = -1;
        for (let i = 0; i < ma.length; i++) {
          na += ma[i]!; nb += mb[i]!;
          if (ma[i] && mb[i]) { both++; const x = i % bg.width, y = Math.floor(i / bg.width); minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
        }
        // Depth of the overlap: its area over its longest side (a strip 2 px deep along a 100 px contact is 200 px).
        const side = both ? Math.max(maxX - minX + 1, maxY - minY + 1) : 1;
        return { both, na, nb, depth: both / side };
      }, size);
      expect(result.na).toBeGreaterThan(100);   // the vehicle is drawn (a long highway crash on a phone is small)
      expect(result.nb).toBeGreaterThan(100);
      expect(result.depth).toBeLessThanOrEqual(2);
    });
  }
});

test.describe("stills", () => {
  test("impact and final rest differ, each is drawn at its own time, and the live picture is untouched", async ({ page }) => {
    await open(page, "t-bone-intersection");
    await pickView(page, "Wide");
    // Let the picture settle (the impact effects play out) before taking the reference.
    let live0 = await page.locator(".viewer3d canvas").screenshot();
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(700);
      const again = await page.locator(".viewer3d canvas").screenshot();
      if (again.equals(live0)) break;
      live0 = again;
    }
    const out = await page.evaluate(async () => {
      type Hook = { captureStill(t: number, v: string, s: { width: number; height: number }): Promise<Uint8Array> };
      const hook = (window as unknown as { __csdViewer: Hook }).__csdViewer;
      const max = Number(document.querySelector("[role=slider]")!.getAttribute("aria-valuemax"));
      const sz = { width: 960, height: 466 };
      const px = async (bytes: Uint8Array) => {
        const bmp = await createImageBitmap(new Blob([bytes as BlobPart]));
        const c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height;
        const g = c.getContext("2d")!; g.drawImage(bmp, 0, 0);
        return g.getImageData(0, 0, c.width, c.height).data;
      };
      const diff = (x: Uint8ClampedArray, y: Uint8ClampedArray) => { let n = 0; for (let i = 0; i < x.length; i += 4) if (Math.abs(x[i]! - y[i]!) + Math.abs(x[i + 1]! - y[i + 1]!) + Math.abs(x[i + 2]! - y[i + 2]!) > 60) n++; return n / (x.length / 4); };
      const impact = await px(await hook.captureStill(0, "wide", sz));
      const impact2 = await px(await hook.captureStill(0, "wide", sz));
      const rest = await px(await hook.captureStill(max, "wide", sz));
      return { same: diff(impact, impact2), apart: diff(impact, rest), max };
    });
    expect(out.max).toBeGreaterThan(0);
    expect(out.same).toBeLessThan(0.002);
    expect(out.apart).toBeGreaterThan(0.005);
    const live1 = await page.locator(".viewer3d canvas").screenshot();
    // Pixel-compared, not byte-compared: on the 2.6x phone canvas SwiftShader's antialiasing differs by a few
    // pixels between two renders of the same frame, so byte equality failed on every phone run with no visible change.
    const moved = await pngDiff(page, live0, live1);
    expect(moved, `share of live pixels changed by taking the stills: ${moved}`).toBeLessThan(0.001);
  });

  test("the still carries the vehicle letters and names (color is not the only cue)", async ({ page }) => {
    await open(page, "t-bone-intersection");
    const n = await page.evaluate(async () => {
      type Hook = { captureStill(t: number, v: string, s: { width: number; height: number }): Promise<Uint8Array> };
      const hook = (window as unknown as { __csdViewer: Hook }).__csdViewer;
      const bytes = await hook.captureStill(0, "wide", { width: 960, height: 466 });
      const bmp = await createImageBitmap(new Blob([bytes as BlobPart]));
      const c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height;
      const g = c.getContext("2d")!; g.drawImage(bmp, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      // The label pill is the surface color: count near-white or near-dark-surface pixels in long horizontal runs.
      let runs = 0;
      for (let y = 0; y < c.height; y++) {
        let run = 0;
        for (let x = 0; x < c.width; x++) {
          const i = (y * c.width + x) * 4;
          const light = d[i]! > 250 && d[i + 1]! > 250 && d[i + 2]! > 250;
          run = light ? run + 1 : 0;
          if (run === 40) runs++;
        }
      }
      return runs;
    });
    expect(n).toBeGreaterThan(10);
  });
});

test.describe("labels", () => {
  for (const name of EXAMPLES) {
    for (const view of ["Top", "Wide"] as const) {
      test(`${name} ${view}: no label overlaps another, the controls or the caption`, async ({ page }) => {
        await open(page, name);
        await pickView(page, view);
        const rects = await page.evaluate(() => {
          const root = document.querySelector(".viewer3d")!.getBoundingClientRect();
          const rel = (el: Element) => { const r = el.getBoundingClientRect(); return { x: r.left - root.left, y: r.top - root.top, w: r.width, h: r.height }; };
          return {
            labels: [...document.querySelectorAll(".viewer3d-label")].map((e) => ({ id: (e as HTMLElement).dataset.label!, ...rel(e) })),
            fixed: [...document.querySelectorAll(".view-controls, .viewer3d-controls, .viewer3d-legend, .scene-caption")].map(rel).filter((r) => r.w > 0),
            view: { w: root.width, h: root.height },
          };
        });
        expect(rects.labels.length).toBeGreaterThan(0);
        const hit = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        for (const l of rects.labels) {
          expect(l.x).toBeGreaterThanOrEqual(-1);
          expect(l.x + l.w).toBeLessThanOrEqual(rects.view.w + 1);
          for (const f of rects.fixed) expect(hit(l, f), `${l.id} overlaps a control`).toBe(false);
        }
        for (let i = 0; i < rects.labels.length; i++) for (let j = i + 1; j < rects.labels.length; j++) expect(hit(rects.labels[i]!, rects.labels[j]!), `${rects.labels[i]!.id} overlaps ${rects.labels[j]!.id}`).toBe(false);
      });
    }
  }

  test("at final rest the labels say Stopped, never ~0", async ({ page }) => {
    await open(page, "t-bone-intersection");
    await page.locator("[role=slider]").focus();
    await page.keyboard.press("End");
    await page.waitForTimeout(700);
    const text = await page.locator(".viewer3d-label").allTextContents();
    expect(text.join(" ")).toContain("Stopped");
    expect(text.join(" ")).not.toMatch(/~\s*0/);
  });

  test("clicking a label selects that vehicle", async ({ page }) => {
    await open(page, "t-bone-intersection");
    await page.locator("button.viewer3d-label").first().click();
    await expect(page.locator(".summary-item[data-selected]")).toHaveCount(1);
  });
});

test.describe("aftermath labels", () => {
  for (const name of EXAMPLES) {
    test(`${name}: vehicle labels and measurement pills in the Aftermath view keep apart (gap, no overlap, clear of the controls)`, async ({ page, isMobile }) => {
      await open(page, name);
      await page.getByRole("button", { name: "Aftermath" }).click();
      await page.waitForTimeout(1800);
      const rects = await page.evaluate(() => {
        const root = document.querySelector(".viewer3d")!.getBoundingClientRect();
        const rel = (el: Element) => { const r = el.getBoundingClientRect(); return { x: r.left - root.left, y: r.top - root.top, w: r.width, h: r.height }; };
        return {
          labels: [...document.querySelectorAll(".viewer3d-label")].map((e) => ({ id: (e as HTMLElement).dataset.label!, ...rel(e) })),
          fixed: [...document.querySelectorAll(".view-controls, .viewer3d-controls, .viewer3d-legend, .scene-caption")].map(rel).filter((r) => r.w > 0),
        };
      });
      expect(rects.labels.some((l) => l.id.startsWith("v-"))).toBe(true);
      if (!isMobile) expect(rects.labels.some((l) => l.id.startsWith("m-"))).toBe(true);   // phones keep the numbers in the Measure tab
      const apart = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }, gap: number) => a.x >= b.x + b.w + gap || b.x >= a.x + a.w + gap || a.y >= b.y + b.h + gap || b.y >= a.y + a.h + gap;
      for (let i = 0; i < rects.labels.length; i++) for (let j = i + 1; j < rects.labels.length; j++) expect(apart(rects.labels[i]!, rects.labels[j]!, 7), `${rects.labels[i]!.id} / ${rects.labels[j]!.id}`).toBe(true);
      for (const l of rects.labels) for (const f of rects.fixed) expect(apart(l, f, 0), `${l.id} / control`).toBe(true);
    });
  }
});

test.describe("zoom and scroll", () => {
  test("a plain wheel is never prevented and shows the hint once; ctrl + wheel zooms", async ({ page, isMobile }) => {
    test.skip(isMobile === true, "no wheel on a phone");
    await open(page, "t-bone-intersection");
    await page.evaluate(() => { (window as unknown as { __prevented: boolean[] }).__prevented = []; window.addEventListener("wheel", (e) => (window as unknown as { __prevented: boolean[] }).__prevented.push(e.defaultPrevented), { passive: true }); });
    const box = (await page.locator(".viewer3d canvas").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const cam = () => page.evaluate(() => (window as unknown as { __csdViewer: { camera(): { zoom: number; position: number[] } } }).__csdViewer.camera());
    const before = await cam();
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(300);
    await expect(page.locator(".viewer3d-hint")).toHaveText("Use Ctrl + scroll or pinch to zoom");
    expect(await page.evaluate(() => (window as unknown as { __prevented: boolean[] }).__prevented)).toEqual([false]);
    expect(await cam()).toEqual(before);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -240);
    await page.keyboard.up("Control");
    await page.waitForTimeout(300);
    const prevented = await page.evaluate(() => (window as unknown as { __prevented: boolean[] }).__prevented);
    expect(prevented[prevented.length - 1]).toBe(true);
    expect((await cam())!.zoom).toBeGreaterThan(before!.zoom);
    await page.waitForTimeout(3200);
    await expect(page.locator(".viewer3d-hint")).toHaveText("");
    await page.mouse.wheel(0, 120);                                   // not shown a second time
    await page.waitForTimeout(300);
    await expect(page.locator(".viewer3d-hint")).toHaveText("");
  });

  test("zoom buttons, reset and keys work", async ({ page }) => {
    await open(page, "t-bone-intersection");
    const cam = () => page.evaluate(() => (window as unknown as { __csdViewer: { camera(): { zoom: number; position: number[] } } }).__csdViewer.camera()!);
    const z0 = (await cam()).zoom;
    await page.getByRole("button", { name: "Zoom in" }).click();
    expect((await cam()).zoom).toBeGreaterThan(z0);
    await page.getByRole("button", { name: "Zoom out" }).click();
    await page.getByRole("button", { name: "Zoom out" }).click();
    expect((await cam()).zoom).toBeLessThan(z0);
    await page.getByRole("button", { name: "Reset view" }).click();
    await page.waitForTimeout(500);
    expect((await cam()).zoom).toBeCloseTo(z0, 3);
    // One focus target: clicking the picture, then the timeline and view keys and the camera keys all answer.
    await page.locator(".viewer3d canvas").click({ position: { x: 20, y: 200 } });
    await page.keyboard.press("2");
    await expect(page.getByRole("radio", { name: "Wide", exact: true })).toBeChecked();
    await page.waitForTimeout(500);
    const w0 = await cam();
    await page.keyboard.press("+");
    const w1 = await cam();
    expect(Math.hypot(...w1.position.map((v, i) => v - (w0.position[i] ?? 0)))).toBeGreaterThan(0.5);
    await page.keyboard.press("i");
    await expect(page.locator("[role=slider]")).toHaveAttribute("aria-valuetext", "At impact");
    expect(await page.locator("[tabindex='0'][role=application]").count()).toBe(1);
  });
});
