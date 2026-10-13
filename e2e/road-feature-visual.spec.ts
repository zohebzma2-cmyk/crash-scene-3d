// Opt-in, local-only screenshot matrix. All upstream requests are blocked in the browser.
import { mkdir, writeFile } from "node:fs/promises";
import { test, expect, openExample, waitForViewer, saveFiles, EXAMPLES } from "./helpers";
test.skip(process.env.FEATURE_VISUAL !== "1", "Manual local visual audit");
for (const name of EXAMPLES) for (const theme of ["light", "dark"] as const) {
  test(`${name} ${theme}: every step, time and export`, async ({ page, baseURL }) => {
    test.setTimeout(180000);
    expect(new URL(baseURL!).hostname).toMatch(/^(localhost|127\.0\.0\.1)$/);
    await page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      return /^(localhost|127\.0\.0\.1)$/.test(url.hostname) || url.protocol === "data:" || url.protocol === "blob:" ? route.continue() : route.abort();
    });
    const width = page.viewportSize()!.width;
    const dir = `qa-output/road-features/${name}-${width}-${theme}`;
    await mkdir(dir, { recursive: true });
    await openExample(page, name, `&theme=${theme}`);
    const shot = async (label: string) => {
      await page.evaluate(() => scrollTo(0, 0));
      await page.waitForTimeout(100);
      const height = await page.evaluate(() => document.documentElement.scrollHeight);
      if (height < 8000) await page.screenshot({ path: `${dir}/${label}.png`, fullPage: true, scale: "css" });
      else {
        // Chromium cannot capture very tall full pages at mobile device scale; retain every viewport.
        for (let y = 0, part = 0; y < height; y += page.viewportSize()!.height, part++) {
          await page.evaluate((top) => scrollTo(0, top), y);
          await page.screenshot({ path: `${dir}/${label}-${part}.png`, scale: "css" });
        }
      }
    };
    for (const [label, key] of [["start", "Home"], ["impact", "i"], ["rest", "End"]]) {
      const slider = page.getByRole("slider", { name: "Timeline" });
      await slider.focus(); await slider.press(key!); await page.waitForTimeout(250);
      await shot(`review-${label}`);
    }
    for (const [view, key] of [["top", "1"], ["driver-a", "3"], ["driver-b", "4"]]) {
      const canvas = page.locator(".viewer-canvas"); await canvas.focus(); await canvas.press(key!); await page.waitForTimeout(300);
      await shot(`view-${view}`);
    }
    await page.evaluate(() => { location.hash = "#location"; });
    await expect(page.locator("#app")).toHaveAttribute("data-step", "location");
    await page.locator(".optional-questions summary").click();
    await shot("location");
    await page.getByRole("button", { name: /Next: vehicles/ }).click();
    await expect(page.locator("#app")).toHaveAttribute("data-step", "vehicles");
    await page.locator("#vehicle-A .optional-questions summary").click();
    await shot("vehicles");
    await page.evaluate(() => { location.hash = "#review"; });
    await waitForViewer(page);
    await page.getByRole("button", { name: "Looks right: save it" }).click();
    await expect(page.locator("#app")).toHaveAttribute("data-step", "export");
    await expect(page.getByRole("button", { name: "Open full size" })).toBeVisible({ timeout: 30000 });
    await shot("save");
    const saved = await saveFiles(page);
    for (const [file, bytes] of saved.files) await writeFile(`${dir}/${file}`, bytes);
  });
}
