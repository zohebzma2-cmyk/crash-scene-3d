// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { all, click, flush, get, key, renderApp } from "./helpers";
import { makeServices } from "./fakes";

let app: { unmount: () => void } | null = null;
afterEach(() => { app?.unmount(); app = null; vi.unstubAllGlobals(); });

describe("view controls when the viewport narrows to a phone", () => {
  it("falls back to Top when a driver view was selected", async () => {
    let phone = false;
    const listeners = new Set<() => void>();
    vi.stubGlobal("matchMedia", (q: string) => ({
      get matches() { return q.includes("max-width: 767px") ? phone : false; },
      media: q,
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
      addListener: () => undefined, removeListener: () => undefined, onchange: null, dispatchEvent: () => false,
    }));
    const { services } = makeServices();
    app = await renderApp(services, { search: "?example=t-bone-intersection", hash: "#review" });
    await flush(900);
    click(get("radio", "Driver A"));
    expect(get("radio", "Driver A").getAttribute("aria-checked")).toBe("true");
    phone = true;
    act(() => { for (const fn of listeners) fn(); });
    expect(all("radio", undefined, document.querySelector(".view-controls")!).map((r) => r.textContent)).toEqual(["Top", "Wide"]);
    expect(get("radio", "Top").getAttribute("aria-checked")).toBe("true");
  });

  it("ignores the 3 and 4 keys on a phone, where those views aren't offered", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("max-width: 767px"), media: q, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, onchange: null, dispatchEvent: () => false }));
    const { services } = makeServices();
    app = await renderApp(services, { search: "?example=t-bone-intersection", hash: "#review" });
    await flush(900);
    key(document.querySelector(".viewer-canvas"), "3");
    key(document.querySelector(".viewer-canvas"), "4");
    expect(get("radio", "Top").getAttribute("aria-checked")).toBe("true");
    key(document.querySelector(".viewer-canvas"), "2");
    expect(get("radio", "Wide").getAttribute("aria-checked")).toBe("true");
  });
});
