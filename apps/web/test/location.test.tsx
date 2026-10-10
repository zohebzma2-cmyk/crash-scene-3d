// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUSY_MESSAGE } from "@csd/core";
import { ServiceError } from "../src/services/types";
import { all, click, flush, get, maybe, mockMatchMedia, renderApp, setValue, text } from "./helpers";
import { MAIN_PARK, makeServices, tbone } from "./fakes";

let app: Awaited<ReturnType<typeof renderApp>> | null = null;
afterEach(() => { app?.unmount(); app = null; vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("step 1: location", () => {
  it("prefills the claim address but sends nothing until Search is tapped", async () => {
    const { services, search, load } = makeServices();
    app = await renderApp(services);
    const input = get("textbox", undefined, document.querySelector("form[role=search]")!) as HTMLInputElement;
    expect(input.value).toBe("Main Street and Park Street, Nashua, NH");
    await flush(50);
    expect(search).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    click(get("button", "Search"));
    await flush();
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith("Main Street and Park Street, Nashua, NH", expect.anything());
  });

  it("lists the results with attribution, and picking one sets the pin and shows the coordinates", async () => {
    const { services } = makeServices();
    app = await renderApp(services);
    click(get("button", "Search"));
    await flush();
    expect(text()).toContain("Search by Photon · Nominatim");
    expect(text()).toContain("© OpenStreetMap contributors");
    expect(text()).toContain("where Main Street meets Park Street");
    click(get("button", /Main Street & Park Street/));
    await flush();
    expect(text()).toContain(tbone.location.lat.toFixed(5));
    expect(text()).toContain("From search: Main Street & Park Street");
  });

  it("marks a closest-approach crossing as approximate, in plain text", async () => {
    const { services, search } = makeServices();
    search.mockResolvedValueOnce([{ ...MAIN_PARK, approximate: true }]);
    app = await renderApp(services);
    click(get("button", "Search"));
    await flush();
    expect(text(document.querySelector(".results")!)).toContain("Approximate crossing");
    search.mockResolvedValueOnce([MAIN_PARK]);
    click(get("button", "Search"));
    await flush();
    expect(text(document.querySelector(".results")!)).not.toContain("Approximate");
  });

  it("says plainly when nothing was found, and when search fails (the busy message is shown as text)", async () => {
    const { services, search } = makeServices();
    search.mockResolvedValueOnce([]);
    app = await renderApp(services);
    click(get("button", "Search"));
    await flush();
    expect(text()).toContain("We couldn't find that. Try a nearby street or landmark, or tap the map where it happened.");
    search.mockRejectedValueOnce(new ServiceError(BUSY_MESSAGE, "busy"));
    click(get("button", "Search"));
    await flush();
    expect(text()).toContain(BUSY_MESSAGE);
    // the map stays usable
    expect(document.querySelector(".map-frame")).not.toBeNull();
  });

  it("has no east-west or north-south street fields; the streets come from the pin instead", async () => {
    const { services } = makeServices();
    app = await renderApp(services);
    click(get("button", "Search"));
    await flush();
    click(get("button", /Main Street & Park Street/));
    await flush(800);
    expect(text()).not.toMatch(/east.?west|north.?south/i);
    expect(all("textbox").map((i) => i.id)).not.toContain("street-ew");
    expect(text()).toMatch(/Streets at the pin: .*Main Street/);
    expect(text()).toMatch(/Park Street/);
  });

  it("shows a compact note instead of a big empty map on a phone until a place is set", async () => {
    mockMatchMedia((q) => q.includes("max-width: 767px"));
    const { services } = makeServices();
    app = await renderApp(services);
    expect(document.querySelector("[data-testid=map-compact]")).not.toBeNull();
    expect(document.querySelector(".map-frame")).toBeNull();
    expect(document.querySelector(".leaflet-container")).toBeNull();
    // the claimant can still open the map and tap to drop a pin
    click(get("button", "Open the map"));
    await flush();
    expect(document.querySelector(".map-frame")).not.toBeNull();
    expect(document.querySelector("[data-testid=map-compact]")).toBeNull();
  });

  it("keeps the map on desktop, with an empty state until a place is set", async () => {
    mockMatchMedia(() => false);
    const { services } = makeServices();
    app = await renderApp(services);
    expect(document.querySelector(".map-frame[data-empty]")).not.toBeNull();
    expect(text()).toContain("Search for the place, or tap the map to drop the pin.");
    expect(text()).toContain("No pin yet");
  });

  it("sets the kind of place, the road and the date", async () => {
    const { services } = makeServices();
    app = await renderApp(services);
    click(get("radio", "Parking lot"));
    click(get("radio", "Wet"));
    expect(get("radio", "Parking lot").getAttribute("aria-checked")).toBe("true");
    expect(get("radio", "Wet").getAttribute("aria-checked")).toBe("true");
    setValue(document.getElementById("date"), "2026-09-18");
    expect((document.getElementById("date") as HTMLInputElement).value).toBe("2026-09-18");
  });

  it("renders text from a result as text, never as HTML", async () => {
    const { services, search } = makeServices();
    search.mockResolvedValueOnce([{ ...MAIN_PARK, main: "<script>window.__pwned = 1</script>", label: "<img src=x onerror=window.__pwned=1>", sub: "<b>bold</b>" }]);
    app = await renderApp(services);
    click(get("button", "Search"));
    await flush();
    expect(text()).toContain("<script>window.__pwned = 1</script>");
    expect(text()).toContain("<b>bold</b>");
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("img[src=x]")).toBeNull();
    expect(document.querySelector("b")).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    expect(maybe("button", /<script>/)).not.toBeNull();
  });
});
