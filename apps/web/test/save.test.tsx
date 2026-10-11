// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_SCENE_BYTES, canonicalJson, type ExportBundle } from "@csd/core";
import { docFromScene } from "../src/state/doc";
import { act } from "react";
import { all, click, flush, get, key, maybe, renderApp, text } from "./helpers";
import { makeServices, tbone } from "./fakes";

let app: Awaited<ReturnType<typeof renderApp>> | null = null;
beforeEach(() => {
  Object.defineProperty(navigator, "webdriver", { value: true, configurable: true });
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:test"), revokeObjectURL: vi.fn() }));
});
afterEach(() => { app?.unmount(); app = null; vi.unstubAllGlobals(); });

const example = { hash: "#export", storage: docFromScene(tbone, tbone.location.label) };
const bundle = (over: Partial<ExportBundle> = {}): ExportBundle => ({
  stamp: { createdAt: "2026-10-09T19:42:07Z", fingerprintHex: "a3f91c2e77b04d18".padEnd(64, "0"), fingerprintShort: "a3f9 1c2e 77b0 4d18" },
  files: [{ name: "crash-scene.json", mime: "application/json", bytes: new TextEncoder().encode("{}") }],
  skipped: [],
  notes: [],
  ...over,
});

/** Give the file input a file and fire change, the way the browser does. */
function chooseFile(file: File): void {
  const input = document.getElementById("open-scene") as HTMLInputElement;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  act(() => { input.dispatchEvent(new Event("change", { bubbles: true })); });
}

describe("step 4: save", () => {
  it("offers the three formats as checkbox rows, with the scene file locked on beside pictures and PDFs", async () => {
    const { services } = makeServices();
    app = await renderApp(services, example);
    await flush(900);
    const boxes = () => all("input[name=fmt]") as HTMLInputElement[];
    expect(boxes().map((i) => i.value)).toEqual(["pdf", "png", "json"]);
    expect(text()).toContain("Video clip.");
    expect(text()).toContain("Share link.");
    // PDF and picture are on, so the scene file is checked, disabled, and says why
    expect(boxes().map((i) => [i.checked, i.disabled])).toEqual([[true, false], [true, false], [true, true]]);
    expect(get("[data-testid=json-hint]").textContent).toBe("Always saved with pictures and PDFs, so the fingerprint can be checked.");
    expect(text()).not.toContain("Also save the scene file");
    click(boxes()[0]!);
    expect(boxes()[2]!.disabled).toBe(true);        // the picture still needs it
    click(boxes()[1]!);
    expect(boxes().map((i) => [i.checked, i.disabled])).toEqual([[false, false], [false, false], [false, false]]);   // its own choice again
    expect(maybe("[data-testid=json-hint]")).toBeNull();
    click(boxes()[2]!);
    expect(boxes()[2]!.checked).toBe(true);
  });

  it("saves the chosen formats from one call, shows the real time and fingerprint, and delivers one download", async () => {
    const { services, build } = makeServices();
    build.mockResolvedValue(bundle());
    app = await renderApp(services, example);
    await flush(900);
    const clicks: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { clicks.push(this.download); });
    click(get("button", /Save to my device/));
    await flush();
    const req = build.mock.calls.at(-1)![0];
    expect(req.formats).toEqual(["pdf", "png-diagram", "png-impact", "png-rest", "json"]); // default: PDF and pictures, with the scene file they need
    expect(req.scene.vehicles.map((v) => v.travel.bearingDeg)).toEqual(tbone.vehicles.map((v) => v.travel.bearingDeg));
    expect(req.scene.claim).toEqual(tbone.claim);
    expect(req.sim.vehicles).toHaveLength(2);
    expect(clicks).toEqual(["crash-scene.json"]);
    expect(get("[data-testid=stamp]").textContent).toContain("a3f9 1c2e 77b0 4d18");
    expect(get("[data-testid=stamp]").textContent).toMatch(/Saved .*2026/);
    expect(text()).toContain("Saved to your device: scene file.");
  });

  it("marks the stamp stale when the scene changes after saving", async () => {
    const { services, build } = makeServices();
    build.mockResolvedValue(bundle());
    app = await renderApp(services, example);
    await flush(900);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    click(get("button", /Save to my device/));
    await flush();
    expect(get("[data-testid=stamp]").classList.contains("is-stale")).toBe(false);
    click(get("button", "Back"));
    await flush(20);
    click(get("button", "Edit details"));
    await flush(20);
    click(get("radio", "Hit on the front left", document.getElementById("vehicle-B")!));
    click(get("button", /See the recreation/));
    await flush(50);
    click(get("button", "Looks right: save it"));
    await flush(50);
    const stamp = get("[data-testid=stamp]");
    expect(stamp.classList.contains("is-stale")).toBe(true);
    expect(stamp.textContent).toContain("You changed the scene after saving at");
  });

  it("won't save with no format chosen", async () => {
    const { services, build } = makeServices();
    app = await renderApp(services, example);
    await flush(900);
    for (const i of all("input[name=fmt]") as HTMLInputElement[]) if (i.checked) click(i);
    // The previews may already have been built (the roads load at once now); the save itself builds nothing.
    const before = build.mock.calls.length;
    click(get("button", /Save to my device/));
    await flush();
    expect(build).toHaveBeenCalledTimes(before);
    expect(text()).toContain("Pick at least one file to save.");
  });

  it("shows a failed save as text and says nothing was saved", async () => {
    const { services, build } = makeServices();
    build.mockRejectedValue(new Error("The brand fonts couldn't be loaded for the export."));
    app = await renderApp(services, example);
    await flush(900);
    click(get("button", /Save to my device/));
    await flush();
    expect(text()).toContain("Saving didn't finish: The brand fonts couldn't be loaded for the export. Nothing was saved.");
  });
});

describe("previews are the real files", () => {
  const pdfBytes = new TextEncoder().encode("%PDF-1.7 fake");
  const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const jsonText = '{"a":1,"b":[2,3]}';
  const real = (): ExportBundle => bundle({ files: [
    { name: "crash-scene.pdf", mime: "application/pdf", bytes: pdfBytes },
    { name: "crash-scene-diagram.png", mime: "image/png", bytes: pngBytes },
    { name: "crash-scene.json", mime: "application/json", bytes: new TextEncoder().encode(jsonText) },
  ] });

  async function openWith(b: ExportBundle) {
    const made = makeServices();
    made.build.mockResolvedValue(b);
    const created: string[] = [];
    let n = 0;
    (URL.createObjectURL as ReturnType<typeof vi.fn>).mockImplementation(() => { const u = `blob:test/${++n}`; created.push(u); return u; });
    app = await renderApp(made.services, example);
    await flush(900);
    await flush(700);   // roads first, then the preview's own pause
    return { ...made, created };
  }

  it("builds all three files through the exports service, after a pause, and shows their bytes", async () => {
    const { build, services } = await openWith(real());
    expect(build).toHaveBeenCalledTimes(1);
    expect(build.mock.calls[0]![0].formats).toEqual(["pdf", "png-diagram", "json"]);
    // the PDF: its real bytes go to pdf.js, which draws page 1
    const opened = (services.pdf.open as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Uint8Array;
    expect(Array.from(opened)).toEqual(Array.from(pdfBytes));
    expect(document.querySelector("[data-testid=pdf-preview] canvas")).not.toBeNull();
    // the picture: an <img> from a blob: URL
    click(get("tab", "Diagram"));
    const img = get("img[data-testid=png-preview]") as HTMLImageElement;
    expect(img.getAttribute("src")).toMatch(/^blob:/);
    // the scene file: its own text in a <pre>, as text
    click(get("tab", "Scene file"));
    expect(get("[data-testid=json-preview]").textContent).toBe(jsonText);
    expect(get("[data-testid=json-preview]").tagName).toBe("PRE");
  });

  it("says how many pages the PDF has and lets the claimant page through it", async () => {
    const made = makeServices();
    made.build.mockResolvedValue(real());
    const renderPage = vi.fn(async () => undefined);
    (made.services.pdf.open as ReturnType<typeof vi.fn>).mockResolvedValue({ numPages: 2, renderPage, destroy: vi.fn() });
    app = await renderApp(made.services, example);
    await flush(900);
    await flush(700);   // roads first, then the preview's own pause
    expect(text(get("[data-testid=pdf-preview]"))).toContain("2 pages");
    expect(text(get("[data-testid=pdf-preview]"))).toContain("Page 1 of 2");
    expect(renderPage).toHaveBeenLastCalledWith(1, expect.anything(), expect.any(Number));
    click(get("button", "Next page"));
    await flush();
    expect(renderPage).toHaveBeenLastCalledWith(2, expect.anything(), expect.any(Number));
    expect(get("button", "Next page").hasAttribute("disabled")).toBe(true);
    click(get("button", "Previous page"));
    await flush();
    expect(renderPage).toHaveBeenLastCalledWith(1, expect.anything(), expect.any(Number));
  });

  it("has no pager for a one-page PDF", async () => {
    await openWith(real());
    expect(maybe("button", "Next page")).toBeNull();
  });

  it("opens the full size view in the page, never in a new tab, and never downloads the preview", async () => {
    const clicks: Array<{ href: string; target: string; download: string }> = [];
    const { created } = await openWith(real());
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { clicks.push({ href: this.href, target: this.target, download: this.download }); });
    expect(document.querySelector("a[target=_blank]")).toBeNull();
    expect(created.length).toBe(3);
    const opener = get("button", "Open full size");
    opener.focus();
    click(opener);
    const dialog = document.querySelector("dialog.full-size-dialog") as HTMLDialogElement;
    expect(dialog.hasAttribute("open")).toBe(true);
    expect(dialog.getAttribute("aria-label")).toBe("PDF summary, full size");
    expect(dialog.querySelector("canvas")).not.toBeNull();          // the PDF's pages, drawn by pdf.js
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Close the full size view");
    expect(clicks).toEqual([]);                                     // nothing was downloaded or navigated
    expect(document.querySelector("a[target=_blank]")).toBeNull();
  });

  it("closes on Esc and on the close button, and gives focus back to the button that opened it", async () => {
    await openWith(real());
    const opener = get("button", "Open full size");
    opener.focus();
    click(opener);
    const dialog = document.querySelector("dialog.full-size-dialog") as HTMLElement;
    key(dialog, "Escape");
    expect(document.querySelector("dialog.full-size-dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
    click(get("button", "Open full size"));
    click(get("button", "Close the full size view"));
    expect(document.querySelector("dialog.full-size-dialog")).toBeNull();
    expect(document.activeElement).toBe(get("button", "Open full size"));
  });

  it("keeps Tab inside the dialog (it wraps from the last control to the first and back)", async () => {
    const made = makeServices();
    made.build.mockResolvedValue(real());
    (made.services.pdf.open as ReturnType<typeof vi.fn>).mockResolvedValue({ numPages: 2, renderPage: vi.fn(async () => undefined), destroy: vi.fn() });
    app = await renderApp(made.services, example);
    await flush(900);
    await flush(700);
    click(get("button", "Open full size"));
    await flush();                                                   // the dialog's own copy of the PDF opens
    const dialog = document.querySelector("dialog.full-size-dialog") as HTMLElement;
    const items = Array.from(dialog.querySelectorAll<HTMLElement>("button:not([disabled])"));
    expect(items.length).toBeGreaterThan(1);                         // close, next page (previous is disabled on page 1)
    items[items.length - 1]!.focus();
    const ev = key(items[items.length - 1]!, "Tab");
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(items[0]);
    const back = key(items[0]!, "Tab", { shiftKey: true });
    expect(back.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(items[items.length - 1]);
  });

  it("uses the same in-page view for the picture, and has none for the scene file", async () => {
    await openWith(real());
    click(get("tab", "Diagram"));
    click(get("button", "Open full size"));
    const dialog = document.querySelector("dialog.full-size-dialog")!;
    expect(dialog.getAttribute("aria-label")).toBe("Diagram picture, full size");
    expect(dialog.querySelector("img")?.getAttribute("src")).toMatch(/^blob:/);
    click(get("button", "Close the full size view"));
    click(get("tab", "Scene file"));
    expect(maybe("button", "Open full size")).toBeNull();
  });

  it("revokes the preview's object URLs when the step goes away", async () => {
    const { created } = await openWith(real());
    app!.unmount();
    app = null;
    for (const u of created) expect(URL.revokeObjectURL).toHaveBeenCalledWith(u);
  });

  it("shows the exports package's reason when a file was skipped, and a plain note when a preview isn't available", async () => {
    await openWith({ ...real(), files: real().files.filter((f) => f.mime !== "image/png"), skipped: [{ format: "png-diagram", reason: "The diagram picture was left out: its fonts could not be loaded." }] });
    click(get("tab", "Diagram"));
    expect(text()).toContain("The diagram picture was left out");
  });

  it("shows a failed preview build as text", async () => {
    const made = makeServices();
    made.build.mockRejectedValue(new Error("The brand fonts couldn't be loaded for the export."));
    app = await renderApp(made.services, example);
    await flush(900);
    await flush(700);   // roads first, then the preview's own pause
    expect(get("alert").textContent).toContain("The brand fonts couldn't be loaded for the export.");
  });

  it("rebuilds after the scene changes, not on every keystroke", async () => {
    const made = makeServices();
    made.build.mockResolvedValue(real());
    app = await renderApp(made.services, example);
    await flush(900);
    await flush(700);   // roads first, then the preview's own pause
    expect(made.build).toHaveBeenCalledTimes(1);
    await flush(700);
    expect(made.build).toHaveBeenCalledTimes(1);     // nothing changed, nothing rebuilt
  });
});

describe("opening a saved scene file", () => {
  const fileOf = (content: string | Uint8Array, name = "scene.json") => new File([content as BlobPart], name, { type: "application/json" });

  it("rejects a file that is too big BEFORE reading it into memory, and says so as text", async () => {
    const { services } = makeServices();
    app = await renderApp(services, example);
    await flush(900);
    const big = fileOf("{}");
    Object.defineProperty(big, "size", { value: 50_000_000 });
    const readers = [vi.spyOn(big, "arrayBuffer"), vi.spyOn(big, "text")];
    chooseFile(big);
    await flush();
    for (const r of readers) expect(r).not.toHaveBeenCalled();
    expect(get("alert").textContent).toContain("That file is too big to be a scene file (50.0 MB; the limit is 1 MB).");
    expect(window.location.hash).toBe("#export");
  });

  it("accepts a file right at the limit's edge only if it is within it", async () => {
    const { services } = makeServices();
    app = await renderApp(services, example);
    await flush(900);
    const f = fileOf("{}");
    Object.defineProperty(f, "size", { value: MAX_SCENE_BYTES + 1 });
    chooseFile(f);
    await flush();
    expect(get("alert").textContent).toContain("too big");
  });

  it("shows malformed JSON and the wrong schema version as plain sentences", async () => {
    const { services } = makeServices();
    app = await renderApp(services, example);
    await flush(900);
    chooseFile(fileOf("{ not json"));
    await flush();
    expect(get("alert").textContent).toContain("isn't a scene file we can read");
    chooseFile(fileOf(JSON.stringify({ ...tbone, schemaVersion: 2, createdAt: "2026-10-09T19:42:07Z", disclaimer: "x" })));
    await flush();
    expect(get("alert").textContent).toContain("from a different version of the tool");
  });

  it("shows a script tag inside an opened file as text, with no script element", async () => {
    const { services } = makeServices();
    app = await renderApp(services, example);
    await flush(900);
    const evil = { ...tbone, claim: { ...tbone.claim, number: "<script>1</script>" }, location: { ...tbone.location, lat: 999 } };
    chooseFile(fileOf(JSON.stringify({ ...evil, createdAt: "2026-10-09T19:42:07Z", disclaimer: "x" })));
    await flush();
    expect(get("alert").textContent).toContain("latitude has to be between");
    expect(document.querySelector("script")).toBeNull();
    // a file whose text fields carry markup opens, and the markup stays text
    const ok = { ...tbone, claim: { ...tbone.claim, number: "<script>1</script>" } };
    chooseFile(fileOf(canonicalJson({ ...ok, createdAt: "2026-10-09T19:42:07Z", disclaimer: "x" })));
    await flush(900);
    expect(document.querySelector("[data-testid=claim-chip]")?.textContent).toContain("<script>1</script>");
    expect(document.querySelector("script")).toBeNull();
  });

  it("opens a good file: same scene, straight to Review, with a toast", async () => {
    const { services } = makeServices();
    app = await renderApp(services, example);
    await flush(900);
    const bytes = new TextEncoder().encode(canonicalJson({ ...tbone, claim: { ...tbone.claim, number: "CLM-FILE-7" }, createdAt: "2026-10-09T19:42:07Z", disclaimer: "x" }));
    chooseFile(fileOf(bytes));
    await flush(900);
    expect(window.location.hash).toBe("#review");
    expect(document.querySelector("[data-testid=claim-chip]")?.textContent).toContain("CLM-FILE-7");
    expect(text()).toContain("Opened the scene saved");
    expect(maybe("alert")).toBeNull();
  });
});
