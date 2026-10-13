// @vitest-environment jsdom
// The first-visit welcome (DESIGN.md section 19): the seen flag (with storage that throws), the rules that keep it
// away from deep links and fixtures, and the dialog itself in the app.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DISCLAIMER_SHORT } from "@csd/core";
import { WELCOME_STORAGE_KEY, readWelcomeSeen, resetWelcomeMemory, shouldShowWelcome, welcomeSuppressed, writeWelcomeSeen, type WelcomeContext } from "../src/welcome/storage";
import { NEW_TAB_NOTE, WELCOME_TEXT, WELCOME_TITLE } from "../src/welcome/WelcomeDialog";
import { click, flush, get, key, maybe, renderApp } from "./helpers";
import { makeServices, tbone } from "./fakes";
import { docFromScene } from "../src/state/doc";

const live = (over: Partial<WelcomeContext> = {}): WelcomeContext => ({ search: "", hash: "", fixtureMode: false, fixturesAllowed: false, ...over });

beforeEach(() => { window.localStorage.clear(); resetWelcomeMemory(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("the seen flag", () => {
  it("is not set on a first visit, and is remembered once written", () => {
    expect(readWelcomeSeen()).toBe(false);
    writeWelcomeSeen();
    expect(JSON.parse(window.localStorage.getItem(WELCOME_STORAGE_KEY) ?? "null")).toEqual({ seen: true });
    resetWelcomeMemory(); // a new page load: only storage remembers
    expect(readWelcomeSeen()).toBe(true);
  });

  it("ignores a damaged value", () => {
    window.localStorage.setItem(WELCOME_STORAGE_KEY, "{not json");
    expect(readWelcomeSeen()).toBe(false);
    window.localStorage.setItem(WELCOME_STORAGE_KEY, JSON.stringify({ seen: "yes" }));
    expect(readWelcomeSeen()).toBe(false);
    window.localStorage.setItem(WELCOME_STORAGE_KEY, "null");
    expect(readWelcomeSeen()).toBe(false);
  });

  it("works when reading storage throws (private mode, blocked storage)", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("SecurityError"); });
    expect(() => readWelcomeSeen()).not.toThrow();
    expect(readWelcomeSeen()).toBe(false);
    expect(shouldShowWelcome(live())).toBe(true);
  });

  it("works when the localStorage getter itself throws", () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw new Error("SecurityError"); });
    expect(readWelcomeSeen()).toBe(false);
    expect(() => writeWelcomeSeen()).not.toThrow();
    // Not remembered on the device, but it is for the rest of this page.
    expect(readWelcomeSeen()).toBe(true);
  });

  it("works when writing storage throws (full or blocked), and lasts for the page", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("QuotaExceededError"); });
    expect(() => writeWelcomeSeen()).not.toThrow();
    expect(window.localStorage.getItem(WELCOME_STORAGE_KEY)).toBeNull();
    expect(readWelcomeSeen()).toBe(true);
    expect(shouldShowWelcome(live())).toBe(false);
  });
});

describe("when the welcome is kept away", () => {
  it("shows on a plain first visit, at / or #location", () => {
    expect(welcomeSuppressed(live())).toBe(false);
    expect(welcomeSuppressed(live({ hash: "#location" }))).toBe(false);
    expect(welcomeSuppressed(live({ search: "?theme=dark" }))).toBe(false);
  });

  it("never over an example link", () => {
    expect(welcomeSuppressed(live({ search: "?example=t-bone-intersection" }))).toBe(true);
    expect(welcomeSuppressed(live({ search: "?example=t-bone-intersection", hash: "#review" }))).toBe(true);
    expect(welcomeSuppressed(live({ search: "?theme=dark&example=highway-rear-end" }))).toBe(true);
  });

  it("never over a deep link to a later step", () => {
    for (const hash of ["#vehicles", "#review", "#export", "#something"]) expect(welcomeSuppressed(live({ hash })), hash).toBe(true);
  });

  it("never in fixtures mode, unless a test asks with ?welcome=1 where fixtures are allowed", () => {
    expect(welcomeSuppressed(live({ fixtureMode: true, fixturesAllowed: true }))).toBe(true);
    expect(welcomeSuppressed(live({ fixtureMode: true, fixturesAllowed: true, search: "?welcome=1" }))).toBe(false);
    expect(welcomeSuppressed(live({ fixtureMode: true, fixturesAllowed: false, search: "?welcome=1" }))).toBe(true);
    // ?welcome=1 never beats an example or a deep link.
    expect(welcomeSuppressed(live({ fixtureMode: true, fixturesAllowed: true, search: "?welcome=1&example=t-bone-intersection" }))).toBe(true);
    expect(welcomeSuppressed(live({ fixtureMode: true, fixturesAllowed: true, search: "?welcome=1", hash: "#review" }))).toBe(true);
  });

  it("never once seen", () => {
    writeWelcomeSeen();
    expect(shouldShowWelcome(live())).toBe(false);
  });
});

describe("the welcome dialog in the app", () => {
  let app: Awaited<ReturnType<typeof renderApp>> | null = null;
  afterEach(() => { app?.unmount(); app = null; });
  const dialog = () => document.querySelector<HTMLDialogElement>("dialog.welcome-dialog");

  async function open(search = "?welcome=1", hash = "#location") {
    const { services } = makeServices();
    app = await renderApp(services, { search, hash });
    await flush(10);
  }

  it("opens over step 1 as a labelled modal dialog with the copy, the disclaimer and the four steps; focus on Try an example", async () => {
    await open();
    const d = dialog();
    expect(d).not.toBeNull();
    expect(d?.getAttribute("aria-modal")).toBe("true");
    const title = document.getElementById(d?.getAttribute("aria-labelledby") ?? "");
    expect(title?.textContent).toBe(WELCOME_TITLE);
    expect(d?.textContent).toContain(WELCOME_TEXT);
    expect(d?.textContent).toContain(DISCLAIMER_SHORT);
    expect(Array.from(d?.querySelectorAll(".welcome-steps li") ?? []).map((li) => li.textContent)).toEqual(["1Location", "2Vehicles", "3Review", "4Save"]);
    expect(document.activeElement).toBe(get("button", "Try an example"));
    expect(document.querySelector("#app")?.getAttribute("data-step")).toBe("location");
  });

  it("is not shown in fixtures mode without ?welcome=1, nor once seen", async () => {
    await open("");
    expect(dialog()).toBeNull();
    app?.unmount();
    writeWelcomeSeen();
    await open();
    expect(dialog()).toBeNull();
  });

  it("Dismiss closes it, stays on step 1 and remembers it", async () => {
    await open();
    click(get("button", "Dismiss"));
    expect(dialog()).toBeNull();
    expect(document.querySelector("#app")?.getAttribute("data-step")).toBe("location");
    expect(JSON.parse(window.localStorage.getItem(WELCOME_STORAGE_KEY) ?? "null")).toEqual({ seen: true });
  });

  it("Esc dismisses it; Tab and Shift+Tab stay inside", async () => {
    await open();
    const d = dialog()!;
    const tryBtn = get("button", "Try an example");
    const dismissBtn = get("button", "Dismiss");
    expect(key(tryBtn, "Tab").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(dismissBtn);
    expect(key(dismissBtn, "Tab", { shiftKey: true }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(tryBtn);
    key(d, "Escape");
    expect(dialog()).toBeNull();
    expect(window.localStorage.getItem(WELCOME_STORAGE_KEY)).not.toBeNull();
  });

  it("Try an example opens the t-bone example on Review, like /?example=t-bone-intersection#review", async () => {
    await open();
    click(get("button", "Try an example"));
    await flush(50);
    expect(dialog()).toBeNull();
    expect(new URLSearchParams(window.location.search).get("example")).toBe("t-bone-intersection");
    expect(window.location.hash).toBe("#review");
    expect(document.querySelector("#app")?.getAttribute("data-step")).toBe("review");
    expect(document.querySelector("main h1")?.textContent).toBe("Does this match what happened?");
  });

  it("About this tool reopens it, and focus goes back to that button after", async () => {
    await open("");
    expect(dialog()).toBeNull();
    const about = get("button", "About this tool");
    about.focus();
    click(about);
    expect(dialog()).not.toBeNull();
    expect(document.activeElement).toBe(get("button", "Try an example"));
    click(get("button", "Dismiss"));
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(about);
  });

  it("the About dialog's About this tool swaps it for the welcome (the way there on phones)", async () => {
    await open("");
    click(get("button", "Learn more"));
    const aboutDialog = document.querySelector("dialog[aria-labelledby='about-title']");
    expect(aboutDialog).not.toBeNull();
    const inDialog = Array.from(aboutDialog!.querySelectorAll("button")).find((b) => b.textContent === "About this tool");
    click(inDialog ?? null);
    expect(document.querySelector("dialog[aria-labelledby='about-title']")).toBeNull();
    expect(dialog()).not.toBeNull();
    expect(document.activeElement).toBe(get("button", "Try an example"));
    click(get("button", "Dismiss"));
    expect(document.activeElement).toBe(get("button", "Learn more"));
  });

  it("reopened after details were entered, Try an example opens in a new tab and says so", async () => {
    const { services } = makeServices();
    // A session with details in it (here a whole scene).
    app = await renderApp(services, { hash: "#location", storage: docFromScene(tbone, tbone.location.label) });
    click(get("button", "About this tool"));
    const link = dialog()?.querySelector<HTMLAnchorElement>("a.btn-primary");
    expect(link?.textContent).toBe("Try an example");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("href")).toMatch(/\?example=t-bone-intersection#review$/);
    expect(dialog()?.textContent).toContain(NEW_TAB_NOTE);
    expect(maybe("button", "Try an example")).toBeNull();
  });
});
