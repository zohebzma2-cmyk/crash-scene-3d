// @vitest-environment jsdom
// Review's loading and failure states in the app (jsdom has no WebGL, so the picture is the diagram).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { docFromScene } from "../src/state/doc";
import { click, flush, get, maybe, renderApp, text } from "./helpers";
import { makeServices, tbone, tboneNet } from "./fakes";

let app: Awaited<ReturnType<typeof renderApp>> | null = null;
beforeEach(() => {
  Object.defineProperty(navigator, "webdriver", { value: true, configurable: true });
  // jsdom has no canvas: the WebGL check says no, quietly.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => { app?.unmount(); app = null; vi.restoreAllMocks(); });

describe("Review loading states", () => {
  it("shows the status box while the roads load, then the picture", async () => {
    let finish: () => void = () => undefined;
    const load = vi.fn(() => new Promise<ReturnType<typeof tboneNet>>((r) => { finish = () => r(tboneNet()); }));
    const { services } = makeServices({ roads: { load } });
    app = await renderApp(services, { hash: "#review", storage: docFromScene(tbone, tbone.location.label) });
    await flush(20);
    expect(text(get("[data-testid=viewer-loading] .viewer-status-title"))).toBe("Building the scene… Loading the map data.");
    // What a screen reader hears comes from the one live region the app keeps, not from the box.
    const live = get("[data-testid=load-announcer]");
    expect(live.getAttribute("role")).toBe("status");
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(text(live)).toBe("Building the scene… Loading the map data.");
    expect(maybe("[data-testid=viewer-loading] [role=status]")).toBeNull();
    finish();
    await flush(20);
    expect(maybe("[data-testid=viewer-loading]")).toBeNull();
    expect(maybe(".viewer-slot")).not.toBeNull();
    // The same region (never remounted) says when it is done.
    expect(get("[data-testid=load-announcer]")).toBe(live);
    expect(text(live)).toBe("The scene is ready.");
  });

  it("says when the map data failed, draws the picture anyway, and Retry loads the roads again", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("down")).mockImplementation(async () => tboneNet());
    const { services } = makeServices({ roads: { load } });
    app = await renderApp(services, { hash: "#review", storage: docFromScene(tbone, tbone.location.label) });
    await flush(50);
    const notice = get("[data-testid=viewer-notice]");
    expect(notice.getAttribute("role")).toBe("alert");
    expect(text(notice)).toContain("We couldn't load the map data, so the picture has no roads.");
    expect(maybe(".viewer-slot")).not.toBeNull();
    // The picture is drawn (the diagram, in jsdom), so no loading box stays up beside the notice.
    expect(maybe("[data-testid=viewer-loading]")).toBeNull();
    click(get("button", "Retry", notice));
    await flush(50);
    expect(load).toHaveBeenCalledTimes(2);
    expect(maybe("[data-testid=viewer-notice]")).toBeNull();
  });

  it("says when the example couldn't be opened (not that it doesn't exist), and Retry opens it", async () => {
    const loadExample = vi.fn().mockRejectedValueOnce(new Error("Failed to fetch dynamically imported module")).mockResolvedValue(tbone);
    const { services } = makeServices({ examples: { names: () => ["t-bone-intersection"], load: loadExample } });
    app = await renderApp(services, { search: "?example=t-bone-intersection", hash: "#review" });
    await flush(20);
    const alert = get(".example-failed");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(text(alert)).toContain("We couldn't open the example. Check your connection and try again.");
    expect(text(alert)).not.toContain("don't have an example");
    click(get("button", "Retry", alert));
    await flush(50);
    expect(loadExample).toHaveBeenCalledTimes(2);
    expect(text(get("h1"))).toBe("Does this match what happened?");
    expect(maybe(".example-failed")).toBeNull();
  });
});
