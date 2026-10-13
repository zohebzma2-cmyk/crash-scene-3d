// Round B colours and catalog models (Chromium and WebKit, 1440 and 390):
//   - pick Red for A on the Vehicles step: the mini map marker, the 3D body, the diagram PNG and the PDF table show it
//   - a vehicle with a catalog model (fixtures mode: the synthetic GLBs) swaps in without a frame where it is missing,
//     tinted to the picked colour, from our own origin, with no CSP violation; the baked-texture one is recoloured
//     by the shader in both engines
// Screenshots: COLORS_SHOTS=<dir> saves them there.
import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { FACTORY_COLORS } from "@csd/core";
import { boxes, crossIntersections, exampleSceneFile, expect, fillDefaultClaim, freshStart, isPhone, openExample, pdfText, saveFiles, searchAndPick, test, toReview, waitForViewer, watchCsp, enterVehicle } from "./helpers";

const RED = FACTORY_COLORS.find((c) => c.name === "Red")!;
const BLUE = FACTORY_COLORS.find((c) => c.name === "Blue")!;
const SHOTS = process.env.COLORS_SHOTS;

async function shot(page: Page, name: string, project: string): Promise<void> {
  // caret: "initial" — hiding the caret makes Playwright inject a <style>, which the page's CSP refuses (WebKit reports it).
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/colors-${name}-${project}.png`, caret: "initial" });
}

type Hue = "red" | "blue";
/** Pixels of the 3D canvas in a hue family (lit and shaded), counted in the page. */
async function canvasHue(page: Page, hue: Hue): Promise<number> {
  return page.evaluate(async (h) => {
    const c = document.querySelector<HTMLCanvasElement>(".viewer3d canvas")!;
    const bmp = await createImageBitmap(c);
    const w = 320, hh = Math.max(1, Math.round((bmp.height / bmp.width) * 320));
    const off = new OffscreenCanvas(w, hh);
    const ctx = off.getContext("2d")!;
    ctx.drawImage(bmp, 0, 0, w, hh);
    const px = ctx.getImageData(0, 0, w, hh).data;
    let n = 0;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i]!, g = px[i + 1]!, b = px[i + 2]!;
      if (h === "red" ? r > 70 && r > 1.8 * g && r > 1.8 * b : b > 70 && b > 1.5 * r && b > 1.15 * g) n++;
    }
    return n;
  }, hue);
}

/** How many pixels of a hue vehicle `id` adds to the picture: count with it shown, then hidden. */
async function hueFromVehicle(page: Page, id: string, hue: Hue): Promise<{ shown: number; hidden: number }> {
  await page.waitForTimeout(400);
  const shown = await canvasHue(page, hue);
  await page.evaluate((v) => (window as unknown as { __csdViewer: { hide(id: string, h: boolean): void } }).__csdViewer.hide(v, true), id);
  await page.waitForTimeout(400);
  const hidden = await canvasHue(page, hue);
  await page.evaluate((v) => (window as unknown as { __csdViewer: { hide(id: string, h: boolean): void } }).__csdViewer.hide(v, false), id);
  return { shown, hidden };
}

/** Pixels of a PNG close to a hex colour, decoded by the browser (an <img>: connect-src is 'self'). */
async function pngNear(page: Page, bytes: Uint8Array, hex: string, tol = 28): Promise<number> {
  return page.evaluate(async ([b64, hx, t]) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = new OffscreenCanvas(img.naturalWidth, img.naturalHeight);
    const x = c.getContext("2d")!;
    x.drawImage(img, 0, 0);
    const px = x.getImageData(0, 0, c.width, c.height).data;
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hx.slice(i, i + 2), 16));
    let n = 0;
    for (let i = 0; i < px.length; i += 4) if (Math.abs(px[i]! - r!) <= t && Math.abs(px[i + 1]! - g!) <= t && Math.abs(px[i + 2]! - b!) <= t) n++;
    return n;
  }, [Buffer.from(bytes).toString("base64"), hex, tol] as const);
}

const rgbOf = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;

test("@xb pick Red for A: the mini map, the 3D body, the diagram PNG and the PDF table all show it", async ({ page, pageErrors }, info) => {
  test.setTimeout(150_000);
  await fillDefaultClaim(page);
  const picker = page.locator('[data-paint-picker="A"]');
  await expect(picker.getByRole("radiogroup")).toBeVisible();
  await picker.getByRole("radio", { name: "Red" }).click();
  await expect(picker.getByRole("radio", { name: "Red" })).toHaveAttribute("aria-checked", "true");
  // The mini map: A's disc is the paint; its ring and letter badge keep A's token colour.
  const marker = page.locator(".veh-marker.v-a");
  await expect(marker).toHaveCSS("background-color", rgbOf(RED.hex));
  await expect(page.locator(".veh-marker.v-b")).not.toHaveCSS("background-color", rgbOf(RED.hex));
  await picker.scrollIntoViewIfNeeded();
  await shot(page, "picker", info.project.name);
  await page.locator(".map-frame-sm").scrollIntoViewIfNeeded();
  await shot(page, "minimap", info.project.name);

  await toReview(page);
  await waitForViewer(page);
  const red = await hueFromVehicle(page, "A", "red");
  expect(red.shown - red.hidden, `red pixels from A (${JSON.stringify(red)})`).toBeGreaterThan(isPhone(page) ? 20 : 60);
  await shot(page, "review", info.project.name);

  await page.getByRole("button", { name: "Looks right: save it" }).click();
  await expect(page.locator("#app")).toHaveAttribute("data-step", "export");
  const { files } = await saveFiles(page);
  const diagram = [...files].find(([n]) => n.endsWith("-diagram.png"))?.[1];
  const pdf = [...files].find(([n]) => n.endsWith(".pdf"))?.[1];
  expect(diagram && pdf).toBeTruthy();
  expect(await pngNear(page, diagram!, RED.hex), "red in the diagram PNG").toBeGreaterThan(300);
  const text = (await pdfText(pdf!)).pages.join(" ").replace(/\s+/g, " ");
  expect(text).toMatch(/Honda Accord · Red/);
  expect(pageErrors(), pageErrors().join(" | ")).toEqual([]);
});

async function openSceneFile(page: Page, mutate: (f: Awaited<ReturnType<typeof exampleSceneFile>>) => void, before?: () => Promise<void>): Promise<void> {
  await openExample(page, "t-bone-intersection");
  await before?.();
  await page.getByRole("button", { name: "Looks right: save it" }).click();
  await expect(page.locator("#app")).toHaveAttribute("data-step", "export");
  const file = await exampleSceneFile("t-bone-intersection");
  mutate(file);
  await page.locator("#open-scene").setInputFiles({ name: "scene.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(file)) });
  await expect(page.locator("#app")).toHaveAttribute("data-step", "review");
  await waitForViewer(page);
}

/** Counts, every animation frame, frames where vehicle `id`'s group exists but has no visible mesh (a flash of nothing). */
async function watchBlank(page: Page, id: string): Promise<void> {
  await page.evaluate((v) => {
    const w = window as unknown as { __blank: { frames: number; blank: number }; __csdViewer?: { three(): { groups: Record<string, { traverseVisible(f: (o: { isMesh?: boolean }) => void): void }> } | null } };
    w.__blank = { frames: 0, blank: 0 };
    const tick = () => {
      const g = w.__csdViewer?.three()?.groups[v];
      if (g) {
        let meshes = 0;
        g.traverseVisible((o) => { if (o.isMesh) meshes++; });
        w.__blank.frames++;
        if (meshes === 0) w.__blank.blank++;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, id);
}

const models = (page: Page) => page.evaluate(() => (window as unknown as { __csdViewer?: { models(): Record<string, { tint: string; watermarked: boolean }> } }).__csdViewer?.models() ?? {});

test("@xb a catalog model swaps in for our model without a frame of nothing, tinted to the picked colour, from our own origin", async ({ page, pageErrors }, info) => {
  test.setTimeout(150_000);
  const violations = await watchCsp(page);
  const glbRequests: string[] = [];
  page.on("request", (r) => { if (/\.glb(\?|$)/.test(r.url()) || r.url().includes("/api/vehicles/model")) glbRequests.push(r.url()); });
  await openSceneFile(page, (f) => {
    Object.assign(f.vehicles[0]!, { make: "Synthetic", model: "Box car", color: { name: "Red", hex: RED.hex } });
  }, () => watchBlank(page, "A"));
  await expect.poll(async () => (await models(page)).A?.tint, { timeout: 30_000, message: "A's catalog model never arrived" }).toBe("material");
  await page.waitForTimeout(500);
  const blank = await page.evaluate(() => (window as unknown as { __blank: { frames: number; blank: number } }).__blank);
  expect(blank.frames).toBeGreaterThan(10);
  expect(blank.blank, "frames where A had no visible model").toBe(0);
  // Fitted to A's footprint: the catalog model sits where our model was.
  const red = await hueFromVehicle(page, "A", "red");
  expect(red.shown - red.hidden, `red pixels from A's catalog model (${JSON.stringify(red)})`).toBeGreaterThan(isPhone(page) ? 20 : 60);
  await expect(page.locator(".viewer3d-model-note")).toContainText("watermarked previews");
  const origin = new URL(page.url()).origin;
  expect(glbRequests.length).toBeGreaterThan(0);
  for (const u of glbRequests) expect(new URL(u).origin).toBe(origin);
  expect(glbRequests.some((u) => u.includes("/api/"))).toBe(false);   // fixtures mode never calls /api
  expect(await violations()).toEqual([]);
  expect(pageErrors(), pageErrors().join(" | ")).toEqual([]);
  await shot(page, "glb-box", info.project.name);   // after the CSP check: WebKit reports Playwright's own screenshot styles
});

test("@xb a catalog model with the paint baked into its texture is recoloured by the shader (both engines compile it)", async ({ page, pageErrors }, info) => {
  test.setTimeout(150_000);
  const violations = await watchCsp(page);
  const consoleErrors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  await openSceneFile(page, (f) => {
    Object.assign(f.vehicles[1]!, { make: "Synthetic", model: "Baked car", color: { name: "Blue", hex: BLUE.hex } });
  });
  await expect.poll(async () => (await models(page)).B?.tint, { timeout: 30_000, message: "B's catalog model never arrived" }).toBe("texture");
  const blue = await hueFromVehicle(page, "B", "blue");
  expect(blue.shown - blue.hidden, `blue pixels from B's recoloured model (${JSON.stringify(blue)})`).toBeGreaterThan(isPhone(page) ? 20 : 60);
  // The baked red is gone from B: what red is left in the picture isn't B's.
  const red = await hueFromVehicle(page, "B", "red");
  expect(red.shown - red.hidden, `red pixels left on B (${JSON.stringify(red)})`).toBeLessThan(isPhone(page) ? 15 : 40);
  expect(consoleErrors.filter((e) => /shader|WebGL|THREE/i.test(e))).toEqual([]);
  expect(await violations()).toEqual([]);
  expect(pageErrors(), pageErrors().join(" | ")).toEqual([]);
  await shot(page, "glb-baked", info.project.name);
});

test("@xb the colour picker passes axe (keyboard, names, contrast) with a near-white custom paint and with Black", async ({ page }) => {
  await fillDefaultClaim(page);
  const picker = page.locator('[data-paint-picker="A"]');
  // Keyboard: the group is one tab stop; arrows move the choice.
  await picker.getByRole("radio", { name: "Not sure of the colour" }).focus();
  await page.keyboard.press("Home");
  await expect(picker.getByRole("radio", { name: "White" })).toHaveAttribute("aria-checked", "true");
  await expect(picker.getByRole("radio", { name: "White" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(picker.getByRole("radio", { name: "Black" })).toHaveAttribute("aria-checked", "true");
  for (const step of ["black", "near-white", "near-white, dark theme"]) {
    if (step === "near-white") {
      await picker.getByRole("radio", { name: "Custom" }).click();
      await picker.locator("input[type=color]").fill("#fdfdfc");
    }
    if (step.endsWith("dark theme")) {
      await page.getByRole("button", { name: "Switch to the dark theme" }).click();
      // The check mark on the near-white swatch stays dark in the dark theme (its ink is a light-dark() pair).
      const ink = await picker.locator(".is-custom").evaluate((el) => getComputedStyle(el).color);
      const [r, g, b] = ink.match(/\d+(\.\d+)?/g)!.map(Number);
      expect(r! + g! + b!, `ink ${ink}`).toBeLessThan(150);
    }
    const res = await new AxeBuilder({ page }).include('[data-paint-picker="A"]').include(".map-frame-sm").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`), step).toEqual([]);
  }
  // Every swatch is a 44 px target.
  for (const b of await picker.getByRole("radio").all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
});

// Vehicles step fixes (2026-10-11), item 4: under 480 px the fourteen swatches are one row that scrolls sideways, with
// a fade at an end that has more past it; the arrow keys still move the choice and keep it in view. Desktop keeps the grid.
test("@xb on a phone the colours are one scrolling row (44 px targets, faded ends, arrow keys); on desktop a grid", async ({ page, pageErrors }) => {
  await freshStart(page, "/#vehicles");
  const picker = page.locator('[data-paint-picker="A"]');
  const radios = picker.getByRole("radio");
  await expect(radios).toHaveCount(14);
  // Measured in one go: the page may still be scrolling to the step's title between separate measurements.
  const boxes14 = await picker.evaluate((el) => [...el.querySelectorAll('[role="radio"]')].map((r) => { const b = r.getBoundingClientRect(); return { y: b.top, h: b.height }; }));
  for (const b of boxes14) expect(b.h).toBeGreaterThanOrEqual(44);
  const tops = boxes14.map((b) => b.y);
  /** Rows of swatches: tops more than 4 px apart start a new row (sub-pixel layout differs by engine). */
  const rows = [...tops].sort((a, b) => a - b).filter((y, i, all) => i === 0 || y - all[i - 1]! > 4).length;
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no sideways page scroll").toBe(true);
  // The type and action tiles (icon beside the label on phones) never cut their label off; each is a 44 px target.
  const tiles = await page.evaluate(() => [...document.querySelectorAll(".vehicle .tiles-compact .tile")].map((t) => ({ text: t.textContent, over: t.scrollWidth > t.clientWidth + 1, h: t.getBoundingClientRect().height })));
  expect(tiles.filter((t) => t.over).map((t) => t.text)).toEqual([]);
  for (const t of tiles) expect(t.h, t.text ?? "").toBeGreaterThanOrEqual(44);
  const row = picker.locator(".paint-row");
  const scroller = picker.locator(".paint-swatches");
  /** Is this radio wholly inside the scroller's visible box? */
  const inView = async (name: string) => {
    const s = (await scroller.boundingBox())!;
    const r = (await picker.getByRole("radio", { name, exact: true }).boundingBox())!;
    return r.x >= s.x - 1 && r.x + r.width <= s.x + s.width + 1;
  };
  if ((page.viewportSize()?.width ?? 1440) >= 480) {
    expect(rows, "desktop: a grid of rows").toBeGreaterThan(1);
    return;
  }
  expect(rows, "phone: one row").toBe(1);
  expect(await scroller.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  // Not sure (the default, the last swatch) starts in view, so the row is faded at its start only.
  expect(await inView("Not sure of the colour")).toBe(true);
  await expect(row).toHaveAttribute("data-more-start", "true");
  await expect(row).not.toHaveAttribute("data-more-end", /.*/);
  // Home: White, at the start, faded at the end. Arrow keys walk the row and keep the choice in view.
  await picker.getByRole("radio", { name: "Not sure of the colour" }).focus();
  await page.keyboard.press("Home");
  await expect(picker.getByRole("radio", { name: "White" })).toBeFocused();
  await expect(row).toHaveAttribute("data-more-end", "true");
  await expect(row).not.toHaveAttribute("data-more-start", /.*/);
  for (const name of ["Black", "Silver", "Gray", "Red", "Blue", "Dark blue", "Green"]) {
    await page.keyboard.press("ArrowRight");
    await expect(picker.getByRole("radio", { name, exact: true })).toHaveAttribute("aria-checked", "true");
    await expect.poll(() => inView(name), { message: `${name} scrolled into view` }).toBe(true);
  }
  await expect(row).toHaveAttribute("data-more-start", "true");
  expect(pageErrors()).toEqual([]);
});

test("@xb the catalog-model note is kept clear: no vehicle label over it (Top and Wide, start, impact and final rest)", async ({ page }) => {
  test.setTimeout(150_000);
  await openSceneFile(page, (f) => {
    Object.assign(f.vehicles[0]!, { make: "Synthetic", model: "Box car" });
  });
  await expect.poll(async () => (await models(page)).A?.tint, { timeout: 30_000 }).toBe("material");
  const note = page.locator(".viewer3d-model-note");
  await expect(note).toBeVisible();
  const clear = async (where: string) => {
    await expect.poll(async () => crossIntersections(await boxes(page, ".viewer3d-label", "label"), await boxes(page, ".viewer3d-model-note", "model note")), { timeout: 10_000, message: where }).toEqual([]);
  };
  await page.locator(".viewer-canvas").focus();
  for (const view of ["1", "2"]) {
    await page.keyboard.press(view);
    for (const k of ["Home", "i", "End"]) {
      await page.locator(".viewer-canvas").focus();
      await page.keyboard.press(k === "i" ? "I" : k);
      await page.waitForTimeout(300);
      await clear(`view ${view}, ${k}`);
    }
  }
});

test("@xb a catalog photo on the card says it is a catalog photo, and 'Picked: Red' once a colour is picked (light and dark)", async ({ page, pageErrors }, info) => {
  const csp = await watchCsp(page);
  await freshStart(page, "/?media=on#location");
  await searchAndPick(page);
  await page.getByRole("button", { name: /Next: vehicles/ }).click();
  const card = page.locator("#vehicle-A");
  // A new visitor's A is empty: enter the car whose catalog photo is checked.
  await enterVehicle(page, "A");
  await expect(card.locator(".vehicle-photo")).toHaveAttribute("data-photo", "photo");
  await expect(card.locator(".vehicle-photo-wrap .paint-chip")).toHaveText("Catalog photo");
  await card.locator('[data-paint-picker="A"]').getByRole("radio", { name: "Red" }).click();
  const chip = card.locator(".vehicle-photo-wrap .paint-chip");
  await expect(chip).toHaveText("Catalog photo · Picked: Red");
  // Inside the card, next to the photo, and no sideways scroll at 390.
  const [cardBox, chipBox, photoBox] = [await card.boundingBox(), await chip.boundingBox(), await card.locator(".vehicle-photo").boundingBox()];
  expect(chipBox!.x).toBeGreaterThanOrEqual(cardBox!.x);
  expect(chipBox!.x + chipBox!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width + 0.5);
  expect(chipBox!.y).toBeGreaterThanOrEqual(photoBox!.y + photoBox!.height - 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const res = await new AxeBuilder({ page }).include("#vehicle-A .vehicle-head").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(res.violations.map((v) => v.id)).toEqual([]);
  expect(await csp()).toEqual([]);
  expect(pageErrors()).toEqual([]);
  const scrollToCard = () => page.evaluate(() => {
    const el = document.getElementById("vehicle-A");
    const bars = [".app-header", ".disclaimer-bar"].reduce((h, sel) => h + (document.querySelector(sel)?.getBoundingClientRect().height ?? 0), 0);
    if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - bars - 16);
  });
  await scrollToCard();
  await shot(page, "photo-chip", info.project.name);
  await page.getByRole("button", { name: "Switch to the dark theme" }).click();
  await page.waitForTimeout(300);
  const dark = await new AxeBuilder({ page }).include("#vehicle-A .vehicle-head").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(dark.violations.map((v) => v.id), "dark theme").toEqual([]);
  await scrollToCard();
  await shot(page, "photo-chip-dark", info.project.name);
});
