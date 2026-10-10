// 6. UI break-it: hostile and broken scene files, absurd speeds, reduced motion and the dark theme.
import type { Page } from "@playwright/test";
import { open, unlink } from "node:fs/promises";
import { canvasPainted, expect, exampleSceneFile, freshStart, isPhone, openExample, test, waitForViewer } from "./helpers";

/** Goes to Save on an example, where "Open a saved scene file" lives. */
async function toSave(page: Page): Promise<void> {
  await openExample(page, "t-bone-intersection");
  await page.getByRole("button", { name: "Looks right: save it" }).click();
  await expect(page.locator("#app")).toHaveAttribute("data-step", "export");
}

/**
 * Presses a view key on the picture and records the camera (through the fixtures build's viewer hook,
 * window.__csdViewer.camera()) on every frame for 1.5 s. In the page, so protocol round trips and slow
 * SwiftShader frames can't hide or fake a flight. Returns the distinct camera states in order.
 */
async function cameraSteps(page: Page, key: string): Promise<string[]> {
  await page.waitForFunction(() => Boolean((window as unknown as { __csdViewer?: { camera(): unknown } }).__csdViewer?.camera()), undefined, { timeout: 30_000 });
  return page.evaluate(async (k) => {
    type Cam = { orthographic: boolean; zoom: number; position: number[] } | null;
    const hook = (window as unknown as { __csdViewer: { camera(): Cam } }).__csdViewer;
    const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    const cam = () => { const c = hook.camera(); return c ? `${c.orthographic ? "ortho" : "persp"} ${c.position.map((x) => x.toFixed(2)).join(",")} z${c.zoom.toFixed(3)}` : "none"; };
    const out = [cam()];
    const t0 = performance.now();
    document.querySelector<HTMLElement>(".viewer-canvas")!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    while (performance.now() - t0 < 1500) { await frame(); const c = cam(); if (c !== out[out.length - 1]) out.push(c); }
    return out;
  }, key);
}

async function openSceneFile(page: Page, body: string | Buffer, name = "scene.json"): Promise<void> {
  await page.locator("#open-scene").setInputFiles({ name, mimeType: "application/json", buffer: Buffer.isBuffer(body) ? body : Buffer.from(body) });
}

const openErrors = (page: Page) => page.locator(".open-errors");

test.describe("scene files", () => {
  test("<script> and on* in a file's text render as text; no script, img or handler is added", async ({ page }) => {
    // Record every element added after load that could run code or load something. (The app's own icons
    // are inline <svg>; the save previews and the 3D canvas are allowed their images.)
    await page.addInitScript(() => {
      const w = window as unknown as { __e2eAdded: string[] };
      w.__e2eAdded = [];
      const check = (el: Element) => {
        const tag = el.tagName.toLowerCase();
        if (["script", "img", "iframe", "object", "embed"].includes(tag) && el.closest(".viewer3d, .viewer-canvas, .preview-frame, .map") === null) w.__e2eAdded.push(`<${tag}> ${el.outerHTML.slice(0, 120)}`);
        if (tag === "script" || tag === "iframe") w.__e2eAdded.push(`<${tag}> ${el.outerHTML.slice(0, 120)}`);
        for (const a of Array.from(el.attributes)) if (/^on/i.test(a.name)) w.__e2eAdded.push(`${tag}[${a.name}]`);
      };
      new MutationObserver((list) => {
        for (const m of list) {
          if (m.type === "attributes" && m.target instanceof Element && m.attributeName && /^on/i.test(m.attributeName)) w.__e2eAdded.push(`${m.target.tagName}[${m.attributeName}]`);
          for (const n of Array.from(m.addedNodes)) if (n instanceof Element) { check(n); n.querySelectorAll("*").forEach(check); }
        }
      }).observe(document, { childList: true, subtree: true, attributes: true });
    });
    await toSave(page);
    const evil = `<script>window.__pwned=1</script><img src=x onerror="window.__pwned=2">`;
    const file = await exampleSceneFile("t-bone-intersection");
    file.location = { ...file.location, label: `Main ${evil}` };
    file.vehicles = file.vehicles.map((v, i) => ({
      ...v, make: `${evil.slice(0, 40)}`, model: `<b onmouseover=alert(1)>M${i}</b>`,
      travel: { ...(v.travel as Record<string, unknown>), roadName: `<svg onload=alert(1)>Rd${i}` },
    }));
    (file as Record<string, unknown>).claim = { number: "CLM-<i>9</i>", vehicle: { year: 2021, make: "<u>H</u>", model: "x" } };
    await page.evaluate(() => { (window as unknown as { __e2eAdded: string[] }).__e2eAdded = []; });
    await openSceneFile(page, JSON.stringify(file));
    await expect(page.locator("#app")).toHaveAttribute("data-step", "review");
    await waitForViewer(page);
    // The text shows as typed, literally.
    await expect(page.locator(".summary-list")).toContainText("<svg onload=alert(1)>Rd0");
    await expect(page.locator(".summary-list")).toContainText("<b onmouseover=alert(1)>M1</b>");
    await expect(page.getByTestId("claim-chip")).toContainText("CLM-<i>9</i>");
    await page.getByRole("button", { name: "Looks right: save it" }).click();
    await expect(page.locator(".preview-frame")).not.toContainText("Making the preview");
    await page.getByRole("tab", { name: "Scene file", exact: true }).click();
    await page.waitForTimeout(300);
    const added = await page.evaluate(() => (window as unknown as { __e2eAdded: string[] }).__e2eAdded);
    expect(added).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    expect(await page.locator("main script, main [onerror], main [onload], main [onmouseover]").count()).toBe(0);
    // Self-check: the observer does report an injected handler.
    await page.evaluate(() => { const s = document.createElement("span"); s.setAttribute("onclick", "void 0"); document.querySelector("main")?.append(s); });
    await expect.poll(() => page.evaluate(() => (window as unknown as { __e2eAdded: string[] }).__e2eAdded.length)).toBe(1);
  });

  test("a 50 MB file is turned away with a plain message before it is read", async ({ page }, info) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __e2eReads: number };
      w.__e2eReads = 0;
      const big = (b: Blob) => b.size > 2_000_000;
      for (const k of ["arrayBuffer", "text", "stream", "bytes"] as const) {
        const proto = Blob.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
        const orig = proto[k];
        if (typeof orig !== "function") continue;
        proto[k] = function (this: Blob, ...a: unknown[]) { if (big(this)) w.__e2eReads++; return orig.apply(this, a); };
      }
      for (const k of ["readAsArrayBuffer", "readAsText", "readAsDataURL", "readAsBinaryString"] as const) {
        const orig = FileReader.prototype[k] as (b: Blob, ...r: unknown[]) => void;
        (FileReader.prototype as unknown as Record<string, unknown>)[k] = function (this: FileReader, b: Blob, ...r: unknown[]) { if (big(b)) w.__e2eReads++; return orig.call(this, b, ...r); };
      }
    });
    await toSave(page);
    const path = info.outputPath("big-scene.json");
    const fh = await open(path, "w");
    await fh.truncate(50 * 1024 * 1024);
    await fh.close();
    try {
      await page.locator("#open-scene").setInputFiles(path);
      await expect(openErrors(page)).toContainText("That file is too big to be a scene file");
      await expect(openErrors(page)).toContainText("MB");
      expect(await page.evaluate(() => (window as unknown as { __e2eReads: number }).__e2eReads)).toBe(0);
      await expect(page.locator("#app")).toHaveAttribute("data-step", "export");
    } finally {
      await unlink(path).catch(() => undefined);
    }
  });

  test("malformed JSON gives a plain message", async ({ page }) => {
    await toSave(page);
    await openSceneFile(page, '{"schemaVersion": 3, "claim": ');
    await expect(openErrors(page)).toHaveText("That file isn't a scene file we can read (it isn't valid JSON).");
    await openSceneFile(page, Buffer.from([0xff, 0xfe, 0x00, 0x7b]));
    await expect(openErrors(page)).toContainText("isn't valid JSON");
    await expect(page.locator("#app")).toHaveAttribute("data-step", "export");
  });

  test("a wrong schemaVersion gives a plain message", async ({ page }) => {
    await toSave(page);
    const file = await exampleSceneFile("highway-rear-end");
    await openSceneFile(page, JSON.stringify({ ...file, schemaVersion: 2 }));
    await expect(openErrors(page)).toContainText("This scene file is from a different version of the tool and can't be opened.");
    await expect(openErrors(page).locator("li")).toHaveCount(1);
  });

  test("lat/lon out of range in a file gives plain messages", async ({ page }) => {
    await toSave(page);
    const file = await exampleSceneFile("highway-rear-end");
    await openSceneFile(page, JSON.stringify({ ...file, location: { ...file.location, lat: 123.4, lon: -200 } }));
    await expect(openErrors(page)).toContainText("The latitude has to be between −90 and 90.");
    await expect(openErrors(page)).toContainText("The longitude has to be between −180 and 180.");
    await expect(page.locator("#app")).toHaveAttribute("data-step", "export");
  });

  test("300 mph in a file is refused with a friendly message", async ({ page }) => {
    await toSave(page);
    const file = await exampleSceneFile("t-bone-intersection");
    file.vehicles[0] = { ...file.vehicles[0], speed: { kind: "known", mph: 300 } };
    await openSceneFile(page, JSON.stringify(file));
    await expect(openErrors(page)).toContainText("Vehicle A: That's faster than we can illustrate. Enter 150 mph or less.");
  });
});

test.describe("speed in the form", () => {
  test("the speed stepper stops at the 150 mph cap", async ({ page }) => {
    await freshStart(page, "/#vehicles");
    const a = page.locator("#vehicle-A");
    await expect(a).toBeVisible();
    const faster = a.getByRole("button", { name: "Faster, vehicle A" });
    for (let i = 0; i < 40; i++) await faster.click();
    await expect(a.getByRole("textbox", { name: "Speed at impact in mph, vehicle A" })).toHaveValue("150");
  });

  test("300 mph typed in the form: capped, with a friendly message", async ({ page }) => {
    await freshStart(page, "/#vehicles");
    const a = page.locator("#vehicle-A");
    const field = a.getByRole("textbox", { name: "Speed at impact in mph, vehicle A" });
    const before = await field.inputValue();
    await field.fill("300");
    const msg = a.locator("[data-speed-group] .field-error");
    await expect(msg).toHaveText("That's faster than we can illustrate. Enter 150 mph or less.");
    await expect(msg).toHaveAttribute("role", "alert");
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await expect(field).toHaveAttribute("aria-describedby", (await msg.getAttribute("id"))!);
    // The picture can't be asked for until it is fixed.
    await page.getByRole("button", { name: /See the recreation/ }).click();
    const gate = page.getByTestId("gate-panel");
    await expect(gate).toContainText("Vehicle A: That's faster than we can illustrate. Enter 150 mph or less.");
    await expect(gate.getByRole("button", { name: "See it anyway" })).toHaveCount(0);
    // The scene kept the last good speed: one step faster from it, not from 300 (that would stop at 150).
    await a.getByRole("button", { name: "Faster, vehicle A" }).click();
    await expect(field).toHaveValue(String(Number(before) + 5));
    await expect(msg).toHaveCount(0);
    // Other bad input gets its own plain words; a good value clears the message.
    await field.fill("fast");
    await expect(msg).toHaveText("The speed should be a number of mph, like 25.");
    await field.fill("25.25");
    await expect(msg).toHaveText("Use whole or tenths of a mile per hour, like 25 or 25.5.");
    await field.fill("");
    await expect(msg).toHaveText("Enter the speed in mph, like 25, or choose Not sure.");
    await field.fill("150");
    await expect(msg).toHaveCount(0);
    await expect(field).toHaveAttribute("aria-invalid", "false");
  });
});

test.describe("motion and theme", () => {
  test("reduced motion: no autoplay, opens at impact, presets cut", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openExample(page, "t-bone-intersection");
    await expect(page.locator(".timeline .readout")).toHaveText("At impact");
    await expect(page.getByRole("button", { name: "Play" })).toBeVisible();
    await page.waitForTimeout(800);
    await expect(page.getByRole("slider", { name: "Timeline" })).toHaveAttribute("aria-valuenow", "0");
    // A preset cuts: one jump from the old camera to the new one, nothing in between.
    for (const key of isPhone(page) ? ["2", "1"] : ["2", "3", "1"]) {
      const steps = await cameraSteps(page, key);
      expect(steps.length, `key ${key}: the camera moved in one step: ${steps.join(" -> ")}`).toBe(2);
    }
  });

  test("without reduced motion a preset flies (control for the test above)", async ({ page }) => {
    test.skip(isPhone(page), "the driver views aren't offered on phones");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await openExample(page, "t-bone-intersection");
    await cameraSteps(page, "2");
    const steps = await cameraSteps(page, "3");      // Wide -> Driver A, both perspective
    expect(steps.length, `in-between camera positions: ${steps.join(" -> ")}`).toBeGreaterThan(2);
  });

  for (const how of ["prefers-color-scheme", "?theme=dark", "toggle"] as const) {
    test(`dark theme renders (${how})`, async ({ page }) => {
      if (how === "prefers-color-scheme") await page.emulateMedia({ colorScheme: "dark" });
      await openExample(page, "parking-lot-backing", how === "?theme=dark" ? "&theme=dark" : "");
      if (how === "toggle") {
        await page.getByRole("button", { name: "Switch to the dark theme" }).click();
        await expect(page.getByRole("button", { name: "Switch to the light theme" })).toBeVisible();
      }
      const lum = await page.evaluate(() => {
        const rgb = (s: string) => (s.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number);
        const l = (c: number[]) => (0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!) / 255;
        let el: Element | null = document.querySelector("main");
        let bg = "rgba(0, 0, 0, 0)";
        while (el && /rgba\(0, 0, 0, 0\)|transparent/.test(bg)) { bg = getComputedStyle(el).backgroundColor; el = el.parentElement; }
        return { bg: l(rgb(bg)), h1: l(rgb(getComputedStyle(document.querySelector("main h1")!).color)) };
      });
      expect(lum.bg, "dark background").toBeLessThan(0.3);
      expect(lum.h1, "light heading text").toBeGreaterThan(0.7);
      await expect.poll(() => canvasPainted(page)).toBe(true);
    });
  }
});
