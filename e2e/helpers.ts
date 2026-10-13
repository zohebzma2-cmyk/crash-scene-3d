// Shared e2e helpers: a page fixture that collects CSP violations and page errors, the example
// loader, the 3D-ready wait, rectangle checks for labels, downloads, PNG sizes and PDF text.
// Everything runs against the VITE_FIXTURES=1 build: no live APIs, synthetic claims only.
import { test as base, expect, type Download, type Locator, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { unzipStored } from "../packages/exports/src/zip";
import { isLiveTarget, stubNonEssentialApi } from "./live-guard";

export const EXAMPLES = ["t-bone-intersection", "highway-rear-end", "parking-lot-backing"] as const;
export type ExampleName = (typeof EXAMPLES)[number];

export const SEARCH_TEXT = "Main Street and Park Street, Nashua NH";
export const DISCLAIMER_SHORT = "Illustration only. This shows what you described. It is not an expert reconstruction and does not decide fault.";
/** The start of the long disclaimer (DESIGN.md section 3). */
export const DISCLAIMER_LONG_START = "This 3D illustration was made in your browser by InsurifyAI";

export interface CspViolation { directive: string; blocked: string; source: string; line: number; sample: string }

/** Collects securitypolicyviolation events from every document the page opens. */
export async function watchCsp(page: Page): Promise<() => Promise<CspViolation[]>> {
  // Reported through the console: it survives navigations and fires even for violations raised while
  // the first module is still evaluating (an exposed function isn't always bound that early).
  const seen: CspViolation[] = [];
  page.on("console", (m) => {
    const t = m.text();
    if (t.startsWith("__e2e_csp__")) seen.push(JSON.parse(t.slice("__e2e_csp__".length)) as CspViolation);
    // The browser's own report too ("Refused to apply a stylesheet ...", "Refusing to load ..."), in case an
    // engine blocks something without dispatching an event we can see.
    else if (m.type() === "error" && /^Refus(ed|ing) to |Content Security Policy/.test(t)) seen.push({ directive: "console", blocked: t, source: m.location().url, line: m.location().lineNumber, sample: "" });
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      console.log("__e2e_csp__" + JSON.stringify({ directive: e.violatedDirective, blocked: e.blockedURI, source: e.sourceFile, line: e.lineNumber, sample: e.sample }));
    });
  });
  return async () => { await page.waitForTimeout(100); return [...seen]; };
}

/** Uncaught page errors (React crashes, failed lazy chunks). */
export function watchErrors(page: Page): () => string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return () => [...errors];
}

export const test = base.extend<{ pageErrors: () => string[] }>({
  // Against a deployed copy (BASE_URL not on this machine), every page in the test's context gets its vehicle lookups
  // and map tiles answered inside the test, so our runs don't spend the live proxy's shared budget
  // (e2e/live-guard.ts). Nothing changes for local runs.
  context: async ({ context }, use) => {
    if (isLiveTarget()) await stubNonEssentialApi(context);
    await use(context);
  },
  pageErrors: async ({ page }, use) => {
    const get = watchErrors(page);
    await use(get);
  },
});
export { expect };

/** Step 1's search: a combobox (type-ahead suggestions, a crossing-streets list); Search runs the full search. */
export const searchBox = (page: Page): Locator => page.getByRole("combobox", { name: "Address, intersection or landmark" });

/** The full (on-submit) search, then its first result picked. */
export async function searchAndPick(page: Page, text = SEARCH_TEXT): Promise<void> {
  await searchBox(page).fill(text);
  // Enter (the keyboard's search key) runs the full search when no suggestion is highlighted. (Tapping
  // Search works on desktop; on a phone the open list covers it: see flow.spec.ts, a known bug.)
  await searchBox(page).press("Enter");
  await page.locator(".results button").first().click();
}

export const isPhone = (page: Page): boolean => (page.viewportSize()?.width ?? 1440) < 600;

/** A fresh session: no stored scene from an earlier test. */
export async function freshStart(page: Page, path = "/#location"): Promise<void> {
  await page.goto(path);
  await page.evaluate(() => { try { sessionStorage.clear(); } catch { /* blocked storage is fine */ } });
  // A goto that only changes the hash doesn't reload; reload so the app starts from the cleared storage.
  await page.reload();
  await expect(page.locator("main h1")).toBeVisible();
}

/** Opens an example on Review and waits for the picture. */
export async function openExample(page: Page, name: ExampleName, extra = ""): Promise<void> {
  await page.goto(`/?example=${name}${extra}`);
  await expect(page.locator("#app")).toHaveAttribute("data-step", "review");
  await expect(page.locator("main h1")).toHaveText("Does this match what happened?");
  await waitForViewer(page);
}

/**
 * The 3D view has drawn: Review's ready signal (data-ready="true" on .viewer-canvas), then a WebGL canvas
 * with a real size whose pixels are not all one color (so "ready" is also checked to mean what it says).
 */
export async function waitForViewer(page: Page): Promise<void> {
  await expect(page.locator(".viewer-canvas")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
  const canvas = page.locator(".viewer3d canvas");
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => canvasPainted(page), { timeout: 30_000, message: "the 3D canvas never painted" }).toBe(true);
}

export async function canvasPainted(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const c = document.querySelector<HTMLCanvasElement>(".viewer3d canvas");
    if (!c || c.width < 50 || c.height < 50) return false;
    // preserveDrawingBuffer is on, so the last frame can be copied into a 2D canvas and read.
    const bmp = await createImageBitmap(c);
    const w = 64, h = 64;
    const off = new OffscreenCanvas(w, h);
    const ctx = off.getContext("2d");
    if (!ctx) return false;
    ctx.drawImage(bmp, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data;
    const colors = new Set<string>();
    for (let i = 0; i < px.length; i += 4) colors.add(`${px[i]! >> 3},${px[i + 1]! >> 3},${px[i + 2]! >> 3}`);
    return colors.size > 8;
  });
}

export interface Box { x: number; y: number; width: number; height: number; label: string }

/** Bounding boxes of every visible element matching the selector. */
export async function boxes(scope: Page | Locator, selector: string, name: string): Promise<Box[]> {
  const loc = scope.locator(selector);
  const out: Box[] = [];
  for (const el of await loc.all()) {
    if (!(await el.isVisible())) continue;
    const b = await el.boundingBox();
    if (b && b.width > 0 && b.height > 0) out.push({ ...b, label: `${name}: ${(await el.innerText()).replace(/\s+/g, " ").trim()}` });
  }
  return out;
}

const overlap = (a: Box, b: Box): boolean =>
  a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;

/** Every pair of boxes that intersect. */
export function intersections(list: readonly Box[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i]!, b = list[j]!;
    if (overlap(a, b)) out.push(`${a.label}  <->  ${b.label}`);
  }
  return out;
}

/**
 * Presses "Save to my device" and returns the ONE download it delivers (a save with several files is one
 * ZIP). If building outlasted the browser's tap window, the app asks for one more tap ("Download your
 * files"); that tap is made here. Also checks that no second download follows.
 */
export async function saveOnce(page: Page): Promise<{ download: Download; secondTap: boolean }> {
  const all: Download[] = [];
  const on = (d: Download) => { all.push(d); };
  page.on("download", on);
  try {
    await page.getByRole("button", { name: "Save to my device" }).click();
    const again = page.getByRole("button", { name: "Download your files" });
    await expect.poll(async () => all.length > 0 || (await again.isVisible()), { timeout: 45_000, message: "a download, or the second tap" }).toBe(true);
    let secondTap = false;
    if (all.length === 0) { secondTap = true; await again.click(); }
    await expect.poll(() => all.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
    await page.waitForTimeout(600);   // a second download would show up here
    expect(all.map((d) => d.suggestedFilename()), "one save = one download").toHaveLength(1);
    return { download: all[0]!, secondTap };
  } finally {
    page.off("download", on);
  }
}

/** One save, unpacked: the ZIP's entries by name (or the lone file, when only one was asked for). */
export async function saveFiles(page: Page): Promise<{ name: string; files: Map<string, Buffer>; secondTap: boolean }> {
  const { download, secondTap } = await saveOnce(page);
  const name = download.suggestedFilename();
  const bytes = await downloadBytes(download);
  const files = new Map<string, Buffer>();
  if (name.endsWith(".zip")) {
    for (const f of unzipStored(new Uint8Array(bytes))) files.set(f.name, Buffer.from(f.bytes));
  } else files.set(name, bytes);
  return { name, files, secondTap };
}

export async function downloadBytes(d: Download): Promise<Buffer> {
  const p = await d.path();
  return readFile(p);
}

export const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

/** Width and height from a PNG's IHDR chunk. */
export function pngSize(b: Uint8Array): { width: number; height: number } {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!sig.every((v, i) => b[i] === v)) throw new Error("not a PNG");
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: dv.getUint32(16), height: dv.getUint32(20) };
}

/** Text of every PDF page, through pdfjs-dist (the legacy build runs in Node). */
export async function pdfText(bytes: Uint8Array): Promise<{ pages: string[]; info: Record<string, unknown> }> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map((it) => ("str" in it ? it.str + (it.hasEOL ? "\n" : " ") : "")).join(""));
  }
  const meta = await doc.getMetadata();
  await doc.cleanup();
  return { pages, info: (meta.info ?? {}) as Record<string, unknown> };
}

/** Collapses whitespace so text split across PDF runs can be searched. */
export const flat = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Picks Review's Measure tab and returns its rows as { label, value }. */
export async function measureTab(page: Page): Promise<Array<{ n: string | null; label: string; value: string }>> {
  await page.getByRole("tab", { name: "Measure" }).click();
  const rows = page.locator(".measure-list > div");
  await expect(rows.first()).toBeVisible();
  const out: Array<{ n: string | null; label: string; value: string }> = [];
  for (const r of await rows.all()) {
    const n = (await r.locator(".mnum").count()) ? (await r.locator(".mnum").innerText()).trim() : null;
    const dt = flat(await r.locator("dt").innerText());
    out.push({ n, label: n && dt.startsWith(n) ? dt.slice(n.length).trim() : dt, value: flat(await r.locator("dd").innerText()) });
  }
  return out;
}

/** The car the old default claim prefilled on vehicle A. A new visitor starts empty now, so tests enter it themselves. */
export const CLAIM_CAR = { year: "2021", make: "Honda", model: "Accord" } as const;

/** Types a vehicle's year, make and model into its card (the fixture vPIC list fills the type), leaving each field with Tab. */
export async function enterVehicle(page: Page, id: "A" | "B" | "C" | "D", car: { year: string; make: string; model: string } = CLAIM_CAR): Promise<void> {
  const card = page.locator(`#vehicle-${id}`);
  for (const [label, value] of [["Year", car.year], ["Make", car.make], ["Model", car.model]] as const) {
    const field = card.getByRole("combobox", { name: label, exact: true });
    await field.fill(value);
    await field.press("Tab");
  }
  await expect(card.locator(".lookup")).toContainText("from NHTSA vPIC");
}

/** What a claimant answers on a vehicle card (a new visitor's cards start with none of it picked). */
export interface VehicleAnswers {
  /** The type tile's label ("SUV"); leave out when vPIC fills the type from the year, make and model. */
  readonly type?: string;
  /** The action tile's label ("Straight", "Turning left", "Parked"). */
  readonly action: string;
  /** Speed at impact in mph; leave out for a parked vehicle. */
  readonly mph?: number;
  /** The hit-side radio's name ("Hit on the left side", "Hit on the front"). */
  readonly zone: string;
}

/** Answers a vehicle card's type (when given), what it was doing, its speed and where it was hit, as a person would. */
export async function answerVehicle(page: Page, id: "A" | "B" | "C" | "D", a: VehicleAnswers): Promise<void> {
  const card = page.locator(`#vehicle-${id}`);
  if (a.type) await card.locator("[data-fix-type]").getByRole("radio", { name: a.type, exact: true }).click();
  await card.locator("[data-fix-action]").getByRole("radio", { name: a.action, exact: true }).click();
  if (a.mph != null) await card.getByRole("textbox", { name: `Speed at impact in mph, vehicle ${id}` }).fill(String(a.mph));
  await card.getByRole("radio", { name: a.zone, exact: true }).click();
}

/** The default claim's answers (what the app prefilled before 2026-10-12): a T-bone, A hit on its left side by B's front. */
export const DEFAULT_ANSWERS = {
  A: { action: "Straight", mph: 25, zone: "Hit on the left side" },
  B: { type: "SUV", action: "Straight", mph: 30, zone: "Hit on the front" },
} as const satisfies Record<"A" | "B", VehicleAnswers>;

/**
 * Walks the default claim to the Vehicles step with every detail answered: the Main and Park pin, vehicle A entered as
 * the 2021 Honda Accord (vPIC fills the type), A going straight northbound on Main at 25 mph hit on its left side, and B
 * an SUV going straight westbound on Park at 30 mph hit in front (Review is a press of "See the recreation" away).
 */
export async function fillDefaultClaim(page: Page): Promise<void> {
  await freshStart(page);
  await searchAndPick(page);
  await expect(page.locator(".streets-here")).toContainText("Streets at the pin");
  await page.getByRole("button", { name: /Next: vehicles/ }).click();
  await expect(page.locator("#vehicle-A")).toBeVisible();
  await enterVehicle(page, "A");
  await answerVehicle(page, "A", DEFAULT_ANSWERS.A);
  await page.locator("#vehicle-A").getByRole("radio", { name: "Northbound on Main Street" }).click();
  await answerVehicle(page, "B", DEFAULT_ANSWERS.B);
  await page.locator("#vehicle-B").getByRole("radio", { name: "Westbound on Park Street" }).click();
}

/** Presses "See the recreation" and gets past non-blocking warnings with "See it anyway". */
export async function toReview(page: Page): Promise<void> {
  await page.getByRole("button", { name: /See the recreation/ }).click();
  const anyway = page.getByRole("button", { name: "See it anyway" });
  await expect(page.locator("#app[data-step=review]").or(anyway)).toBeVisible();
  if (await anyway.isVisible()) await anyway.click();
  await expect(page.locator("#app")).toHaveAttribute("data-step", "review");
}

export const LONG_DISCLAIMER = "This 3D illustration was made in your browser by InsurifyAI from details you entered: location, vehicles, directions and estimated speeds. It is a simplified picture to help explain your account. It is not an expert accident reconstruction, expert opinion or evidence of fault, and real vehicle movement may have been different.";

/** A valid scene file (schema v3): an example's scene plus the file fields. Tests mutate it. */
export async function exampleSceneFile(name: ExampleName): Promise<Record<string, unknown> & { vehicles: Array<Record<string, unknown>>; location: Record<string, unknown> }> {
  const scene = JSON.parse(await readFile(new URL(`../examples/${name}/scene.json`, import.meta.url), "utf8")) as Record<string, unknown>;
  return { ...scene, createdAt: "2026-10-01T12:00:00Z", disclaimer: LONG_DISCLAIMER } as unknown as Record<string, unknown> & { vehicles: Array<Record<string, unknown>>; location: Record<string, unknown> };
}

/** Share of pixels (0–1) that differ clearly between two PNGs in rows [from, to), decoded by the browser. */
export async function pngDiff(page: Page, a: Uint8Array, b: Uint8Array, rows: readonly [number, number] = [0, 1e9]): Promise<number> {
  return page.evaluate(async ([a64, b64, from, to]) => {
    // An <img> (img-src allows data:), not fetch: the page's CSP limits connect-src to 'self'.
    const load = async (s: string) => { const img = new Image(); img.src = `data:image/png;base64,${s}`; await img.decode(); return createImageBitmap(img); };
    const [ia, ib] = await Promise.all([load(a64), load(b64)]);
    const w = Math.min(ia.width, ib.width), h = Math.min(ia.height, ib.height, to);
    const px = (bmp: ImageBitmap) => { const c = new OffscreenCanvas(w, h); const x = c.getContext("2d")!; x.drawImage(bmp, 0, 0); return x.getImageData(0, 0, w, h).data; };
    const pa = px(ia), pb = px(ib);
    let diff = 0;
    for (let i = from * w * 4; i < pa.length; i += 4) {
      if (Math.abs(pa[i]! - pb[i]!) + Math.abs(pa[i + 1]! - pb[i + 1]!) + Math.abs(pa[i + 2]! - pb[i + 2]!) > 48) diff++;
    }
    return diff / (w * (h - from));
  }, [Buffer.from(a).toString("base64"), Buffer.from(b).toString("base64"), rows[0], rows[1]] as const);
}

/**
 * What the vehicle labels must keep off, in page pixels: each vehicle's projected outline (the convex hull of its
 * projected box, cut into thin strips) and the impact ring's. The viewer publishes them as data-boxes on its label layer
 * (picture-relative), so this also works against a deployed build.
 */
export async function viewerObstacles(page: Page): Promise<{ vehicles: Box[]; ring: Box[] }> {
  const layer = page.locator(".viewer3d-labels");
  const origin = (await layer.boundingBox())!;
  const raw = JSON.parse((await layer.getAttribute("data-boxes")) ?? `{"vehicles":{},"ring":[]}`) as { vehicles: Record<string, Array<{ x: number; y: number; w: number; h: number }>>; ring: Array<{ x: number; y: number; w: number; h: number }> };
  const toBox = (r: { x: number; y: number; w: number; h: number }, label: string): Box => ({ x: origin.x + r.x, y: origin.y + r.y, width: r.w, height: r.h, label });
  return {
    vehicles: Object.entries(raw.vehicles).flatMap(([id, strips]) => strips.map((r) => toBox(r, `vehicle ${id}`))),
    ring: raw.ring.map((r) => toBox(r, "impact ring")),
  };
}

/** Boxes of `a` that intersect any box of `b` (a different list: pairs inside one list are not compared). */
export function crossIntersections(a: readonly Box[], b: readonly Box[]): string[] {
  const out: string[] = [];
  for (const x of a) for (const y of b) if (intersections([x, y]).length) out.push(`${x.label}  <->  ${y.label}`);
  return out;
}
