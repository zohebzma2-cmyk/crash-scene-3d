// What each engine actually draws on Review: the 3D view (WebGL) or the 2D top-down fallback. The app picks the
// fallback only when the browser has no WebGL (apps/web/src/review/SceneView.tsx hasWebGL), so this test checks
// the pick matches the engine: WebGL present means a painted 3D canvas and no fallback; WebGL absent means the
// fallback diagram with its labels. The result is attached to the report as an annotation ("renders").
import { EXAMPLES, canvasPainted, expect, openExample, test } from "./helpers";

test("@xb Review draws the 3D view when the engine has WebGL, the 2D fallback only when it doesn't", async ({ page, browserName, pageErrors }) => {
  await page.goto("/");
  const gl = await page.evaluate(() => {
    const c = document.createElement("canvas");
    const g = (c.getContext("webgl2") ?? c.getContext("webgl")) as WebGLRenderingContext | null;
    if (!g) return null;
    const ext = g.getExtension("WEBGL_debug_renderer_info");
    return String(ext ? g.getParameter(ext.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER));
  });
  for (const name of EXAMPLES) {
    await openExample(page, name);
    if (gl) {
      await expect(page.locator(".viewer3d canvas")).toBeVisible();
      await expect(page.locator(".viewer-slot")).toHaveCount(0);
      expect(await canvasPainted(page), `${name}: the 3D canvas painted`).toBe(true);
    } else {
      await expect(page.locator(".viewer-slot .diagram-host")).toBeVisible();
      await expect(page.locator(".viewer-slot .vlabel")).not.toHaveCount(0);
    }
  }
  test.info().annotations.push({ type: "renders", description: `${browserName}: ${gl ? `3D WebGL (${gl})` : "2D fallback (no WebGL)"}` });
  console.log(`[renders] ${test.info().project.name}: ${gl ? `3D WebGL (${gl})` : "2D fallback (no WebGL)"}`);
  expect(pageErrors()).toEqual([]);
});

test("@xb with no WebGL, Review shows the 2D fallback, ready, and Save still delivers the diagram, PDF and scene file", async ({ page, pageErrors }) => {
  // An engine without WebGL (blocked by policy, old GPU): getContext("webgl"/"webgl2") gives null.
  await page.addInitScript(() => {
    const orig = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, id: string, ...rest: unknown[]) {
      if (/^(webgl2?|experimental-webgl)$/.test(id)) return null;
      return (orig as (...a: unknown[]) => unknown).call(this, id, ...rest);
    } as typeof orig;
  });
  await page.goto("/?example=t-bone-intersection");
  await expect(page.locator(".viewer-canvas")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
  await expect(page.locator(".viewer3d canvas")).toHaveCount(0);
  await expect(page.locator(".viewer-slot .diagram-host")).toBeVisible();
  await expect(page.locator(".viewer-slot .vlabel")).not.toHaveCount(0);
  await page.getByRole("button", { name: "Looks right: save it" }).click();
  await expect(page.locator("#app")).toHaveAttribute("data-step", "export");
  const dl = page.waitForEvent("download", { timeout: 60_000 });
  await page.getByRole("button", { name: "Save to my device" }).click();
  const again = page.getByRole("button", { name: "Download your files" });
  const first = await Promise.race([dl, again.waitFor({ timeout: 60_000 }).then(() => null)]);
  const download = first ?? (await Promise.all([page.waitForEvent("download"), again.click()]))[0];
  const { readFile } = await import("node:fs/promises");
  const { unzipStored } = await import("../packages/exports/src/zip");
  const names = unzipStored(new Uint8Array(await readFile(await download.path()))).map((f) => f.name).sort();
  // No 3D stills without the 3D view; everything else is there.
  expect(names).toEqual(["crash-scene-CLM-EX-1001-diagram.png", "crash-scene-CLM-EX-1001.json", "crash-scene-CLM-EX-1001.pdf"]);
  expect(pageErrors()).toEqual([]);
});
