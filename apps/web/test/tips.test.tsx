// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { docFromScene } from "../src/state/doc";
import { TIPS, tipsForStep } from "../src/tips/content";
import { TIPS_STORAGE_KEY } from "../src/tips/storage";
import { all, click, flush, get, maybe, renderApp } from "./helpers";
import { makeServices, tbone } from "./fakes";

let app: Awaited<ReturnType<typeof renderApp>> | null = null;
beforeEach(() => {
  Object.defineProperty(navigator, "webdriver", { value: true, configurable: true });
  // The roads load at once, so Save's previews are built within the wait; jsdom has no object URLs for their bytes.
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
  vi.spyOn(URL, "revokeObjectURL").mockReturnValue(undefined);
});
afterEach(() => { app?.unmount(); app = null; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const example = docFromScene(tbone, tbone.location.label);
const STEPS = [
  { name: "Location", hash: "#location", id: "location", title: "Finding the place" },
  { name: "Vehicles", hash: "#vehicles", id: "vehicles", title: "Describing each vehicle" },
  { name: "Review", hash: "#review", id: "review", title: "Checking the picture" },
  { name: "Save", hash: "#export", id: "save", title: "Saving your files" },
] as const;
const notes = () => all(".tip");
const stored = () => JSON.parse(window.localStorage.getItem(TIPS_STORAGE_KEY) ?? "null") as { hidden: string[]; all: boolean } | null;

async function open(hash: string) {
  const { services } = makeServices();
  app = await renderApp(services, { hash, storage: example, tips: "shown" });
  await flush(900);
}

describe("tips", () => {
  for (const s of STEPS) {
    it(`shows one labelled tip on ${s.name}, with a Hide tip button that names it`, async () => {
      await open(s.hash);
      expect(notes()).toHaveLength(1);
      expect(notes()[0]?.getAttribute("aria-label")).toBe(`Tip: ${s.title}`);
      expect(notes()[0]?.getAttribute("aria-live")).toBeNull();
      expect(get("button", `Hide tip: ${s.title}`)).toBeTruthy();
      expect(get("button", "Hide all tips")).toBeTruthy();
      expect(maybe("button", "Show tips")).toBeNull();
      // Showing a tip never moves focus.
      expect(notes()[0]).not.toBe(document.activeElement);
      expect(document.activeElement?.closest(".tip")).toBeNull();
    });
  }

  it("dismisses one tip, remembers it, and moves focus to Show tips", async () => {
    await open("#location");
    click(get("button", "Hide tip: Finding the place"));
    expect(notes()).toHaveLength(0);
    expect(stored()).toEqual({ hidden: ["location"], all: false });
    expect(document.activeElement).toBe(get("button", "Show tips"));
  });

  it("stays hidden on the next visit, and on other steps only the hidden tip is gone", async () => {
    window.localStorage.setItem(TIPS_STORAGE_KEY, JSON.stringify({ hidden: ["location"], all: false }));
    const { services } = makeServices();
    app = await renderApp(services, { hash: "#location", tips: "keep" });
    expect(notes()).toHaveLength(0);
    expect(maybe("button", "Show tips")).not.toBeNull();
    click(get("button", /Next: vehicles/));
    await flush(10);
    expect(notes()).toHaveLength(1);
  });

  it("Hide all tips hides every step's tip; Show tips brings them back and focuses the tip", async () => {
    await open("#vehicles");
    click(get("button", "Hide all tips"));
    expect(notes()).toHaveLength(0);
    expect(stored()?.all).toBe(true);
    click(get("button", "Show tips"));
    expect(notes()).toHaveLength(1);
    expect(stored()).toEqual({ hidden: [], all: false });
    expect(document.activeElement).toBe(notes()[0]);
    expect(maybe("button", "Show tips")).toBeNull();
  });

  it("works when storage throws", async () => {
    const { services } = makeServices();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "clear").mockImplementation(() => undefined);
    app = await renderApp(services, { hash: "#location", tips: "keep" });
    expect(notes()).toHaveLength(1);
    click(get("button", "Hide tip: Finding the place"));
    expect(notes()).toHaveLength(0);
    click(get("button", "Show tips"));
    expect(notes()).toHaveLength(1);
  });

  it("ignores a damaged stored value", async () => {
    window.localStorage.setItem(TIPS_STORAGE_KEY, "{not json");
    const { services } = makeServices();
    app = await renderApp(services, { hash: "#location", tips: "keep" });
    expect(notes()).toHaveLength(1);
  });
});

describe("tip copy", () => {
  it("has one tip for each of the four steps, plus the on-demand review-refusal tip", () => {
    expect(tipsForStep("location").map((t) => t.id)).toEqual(["location"]);
    expect(tipsForStep("vehicles").map((t) => t.id)).toEqual(["vehicles"]);
    expect(tipsForStep("review").map((t) => t.id)).toEqual(["review"]);
    expect(tipsForStep("export").map((t) => t.id)).toEqual(["save"]);
    const refusal = TIPS.find((t) => t.id === "review-refusal");
    expect(refusal?.onDemand).toBe(true);
    expect(refusal?.text).toBe("If the details can't happen, pick one of the suggested fixes or edit the details yourself.");
  });

  it("has unique ids, no emoji, no HTML, and none of the words DESIGN.md section 3 bans", () => {
    expect(new Set(TIPS.map((t) => t.id)).size).toBe(TIPS.length);
    for (const t of TIPS) {
      const copy = `${t.title} ${t.text}`;
      expect(copy, t.id).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(copy, t.id).not.toMatch(/[<>]|&\w+;/);
      expect(copy.toLowerCase(), t.id).not.toMatch(/\b(fault|liable|negligent|proves|evidence|expert|forensic|determined|conclusive)\b/);
      expect(t.text.length, t.id).toBeLessThan(200);
    }
  });
});
