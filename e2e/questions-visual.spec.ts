// Local fixture build only. Synthetic examples and answers; never uses provider APIs.
import { mkdir, writeFile } from "node:fs/promises";
import { test, expect, openExample, waitForViewer, saveFiles, pdfText, EXAMPLES, boxes, crossIntersections } from "./helpers";
import type { Page } from "@playwright/test";
import type { Scene } from "@csd/core";
test.skip(process.env.QUESTIONS_VISUAL !== "1", "Opt-in local question visual audit");

async function replaceAnswers(page: Page, lighting: NonNullable<Scene["conditions"]>["lighting"], weather: NonNullable<Scene["conditions"]>["weather"], theme: string) {
  await page.evaluate(({ lighting, weather, theme }) => {
    const key = "crash-scene-3d/doc/v4";
    const doc = JSON.parse(sessionStorage.getItem(key)!);
    doc.scene.conditions = { lighting, weather, visibility: ["sun-glare", "parked-cars", "hedges"] };
    doc.scene.vehicles.forEach((v: { braking: boolean; travel: { lane: number | null }; account: unknown }, i: number) => {
      v.account = { control: i === 0 ? "green" : "stop", signaled: i === 0 ? "yes" : "no", braking: v.braking ? "yes" : "no", swerving: "not-sure", airbags: i === 0 ? "yes" : "no", towed: i === 0 ? "no" : "not-sure", lane: "not-sure" };
      v.travel.lane = null;
    });
    sessionStorage.setItem(key, JSON.stringify(doc));
    history.replaceState(null, "", `/?fixtures=1&theme=${theme}#review`);
  }, { lighting, weather, theme });
  await page.reload(); await waitForViewer(page);
}

for (const example of EXAMPLES) for (const theme of ["light", "dark"] as const) {
  test(`${example} ${theme}: questions, scene icons and PDF`, async ({ page, baseURL, pageErrors }) => {
    test.setTimeout(240000);
    expect(new URL(baseURL!).hostname).toMatch(/^(localhost|127\.0\.0\.1)$/);
    await page.route("**/*", (route) => {
      const u = new URL(route.request().url());
      return /^(localhost|127\.0\.0\.1)$/.test(u.hostname) || ["data:", "blob:"].includes(u.protocol) ? route.continue() : route.abort();
    });
    const dir = `qa-output/questions/${example}-${page.viewportSize()!.width}-${theme}`;
    await mkdir(dir, { recursive: true });
    const shot = async (name: string) => {
      await page.evaluate(() => scrollTo(0, 0)); await page.waitForTimeout(150);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true, scale: "css" });
    };
    await openExample(page, example, `&theme=${theme}`);
    await replaceAnswers(page, "dark-lit", "rain", theme);
    await expect(page.locator(".viewer .account-icons")).toContainText("Claimant said");
    await expect(page.locator(".viewer .account-icons")).toContainText("A: Yes");
    await expect(page.locator(".viewer .account-icons")).toContainText("B: No");
    for (const phrase of ["Claimant said: lighting", "weather — Rain", "visibility issues", "traffic control", "signaled", "braking", "swerving", "airbags deployed", "towed", "lane — Not sure"]) {
      await expect(page.getByTestId("scene-summary")).toContainText(phrase);
    }
    expect((await page.getByTestId("scene-summary").innerText()).match(/Claimant said/g)).toHaveLength(17);
    for (const [time, key] of [["start", "Home"], ["impact", "i"], ["rest", "End"]]) {
      await page.getByRole("slider", { name: "Timeline" }).press(key!); await page.waitForTimeout(200); await shot(`review-${time}`);
      const strip = await boxes(page, ".viewer .account-icons", "claimant answers");
      expect(crossIntersections(strip, await boxes(page, ".viewer-canvas", "picture")), time).toEqual([]);
    }
    await page.locator(".viewer .account-icons summary").click();
    await page.locator(".viewer .account-chips").evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await shot("scene-vehicle-answers");
    expect(crossIntersections(await boxes(page, ".viewer .account-icons", "claimant answers"), await boxes(page, ".viewer-canvas", "picture"))).toEqual([]);
    await page.locator(".viewer .account-icons summary").click();
    await page.getByTestId("scene-summary").locator("..").evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await shot("summary-answers");
    await page.evaluate(() => { location.hash = "#location"; });
    await page.locator(".optional-questions summary").click(); await shot("location");
    await page.getByRole("button", { name: /Next: vehicles/ }).click();
    await shot("vehicles");
    for (const id of ["A", "B"]) {
      const panel = page.locator(`#vehicle-${id} .optional-questions`);
      await panel.locator("summary").click();
      if (example === "highway-rear-end") await expect(panel.getByLabel("Which lane, from the right?").locator("option")).toHaveCount(6);
      await shot(`questions-${id}`);
    }
    await page.evaluate(() => { location.hash = "#review"; }); await waitForViewer(page);
    await page.getByRole("button", { name: "Looks right: save it" }).click();
    await expect(page.getByRole("button", { name: "Open full size" })).toBeVisible({ timeout: 30000 }); await shot("save");
    const saved = await saveFiles(page);
    for (const [name, bytes] of saved.files) {
      await writeFile(`${dir}/${name}`, bytes);
      if (name.endsWith(".pdf")) {
        const text = (await pdfText(bytes)).pages.join(" ").replace(/\s+/g, " ");
        for (const phrase of ["Claimant said: lighting", "weather — Rain", "visibility issues", "traffic control", "signaled", "braking", "swerving", "airbags deployed", "towed", "lane — Not sure"]) expect(text).toContain(phrase);
      }
    }
    // Every lighting/weather combination on the intersection, in both widths and UI themes.
    if (example === "t-bone-intersection" && process.env.QUESTIONS_ENVIRONMENT !== "0") {
      for (const light of ["daylight", "dusk-dawn", "dark-lit", "dark-unlit"] as const) for (const weather of ["clear", "rain", "snow", "fog"] as const) {
        await replaceAnswers(page, light, weather, theme);
        await page.locator(".viewer-canvas").press("2"); await page.waitForTimeout(250);
        await page.locator(".viewer-canvas").screenshot({ path: `${dir}/environment-${light}-${weather}.png`, scale: "css" });
      }
      await replaceAnswers(page, "not-sure", "not-sure", theme); await shot("not-sure");
    }
    expect(pageErrors()).toEqual([]);
  });
}
