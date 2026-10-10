// @vitest-environment jsdom
// The Location map: real tiles (drawn from road data in fixtures mode), wheel/pinch/keyboard zoom, the expand
// dialog on a phone, the street highlight, the attribution, and the PDF thumbnail still being captured.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocationMap, WHEEL_HINT_TEXT, type LocationMapProps } from "../src/components/LocationMap";
import { clampZoom, mapKeyAction, wheelZoomDelta } from "../src/lib/mapZoom";
import { groundTileSvg } from "../src/lib/groundTile";
import { ServicesProvider } from "../src/services/context";
import { mapThumbnail } from "../src/services/thumbnail";
import { all, flush, get, maybe, mockMatchMedia, mount, sizeMapContainers } from "./helpers";
import { makeServices, tbone, tboneNet } from "./fakes";

let app: { unmount: () => void } | null = null;
afterEach(() => { app?.unmount(); app = null; mapThumbnail.clear(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });

const pin = { lat: tbone.location.lat, lon: tbone.location.lon };

function show(over: Partial<LocationMapProps> = {}) {
  const { services } = makeServices();
  app = mount(
    <ServicesProvider services={services}>
      <LocationMap pin={pin} focusSeq={0} onPin={() => undefined} fixtures roads={null} {...over} />
    </ServicesProvider>,
  );
}
const mapEl = () => document.querySelector<HTMLElement>(".leaflet-container")!;
const frame = () => document.querySelector<HTMLElement>(".map-frame")!;
const zoom = () => Number(frame().dataset.zoom);
function wheel(el: Element, init: WheelEventInit): WheelEvent {
  const ev = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaMode: 0, ...init });
  act(() => { el.dispatchEvent(ev); });
  return ev;
}
function keydown(el: Element, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  act(() => { el.dispatchEvent(ev); });
  return ev;
}

describe("zoom arithmetic", () => {
  it("a wheel notch is about one level, a pinch step a sliver, and up is zoom in", () => {
    expect(wheelZoomDelta({ deltaY: -120, deltaMode: 0 })).toBeCloseTo(1);
    expect(wheelZoomDelta({ deltaY: 120, deltaMode: 0 })).toBeCloseTo(-1);
    expect(Math.abs(wheelZoomDelta({ deltaY: -2, deltaMode: 0 }))).toBeLessThan(0.05);
    expect(wheelZoomDelta({ deltaY: -3, deltaMode: 1 })).toBeGreaterThan(0.3);
    expect(clampZoom(25, 3, 19)).toBe(19);
    expect(clampZoom(1, 3, 19)).toBe(3);
  });
  it("maps keys to pan and zoom, and ignores keys with a modifier", () => {
    const k = (key: string, over = {}) => mapKeyAction({ key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...over });
    expect(k("ArrowLeft")).toEqual({ kind: "pan", dx: -80, dy: 0 });
    expect(k("ArrowDown", { shiftKey: true })).toEqual({ kind: "pan", dx: 0, dy: 240 });
    expect(k("+")).toEqual({ kind: "zoom", delta: 1 });
    expect(k("-")).toEqual({ kind: "zoom", delta: -1 });
    expect(k("+", { ctrlKey: true })).toBeNull();
    expect(k("a")).toBeNull();
  });
});

describe("wheel and keyboard", () => {
  it("a plain wheel neither zooms nor is prevented (the page scrolls), and shows the hint", async () => {
    sizeMapContainers();
    show();
    await flush();
    const before = zoom();
    const ev = wheel(mapEl(), { deltaY: -240 });
    expect(ev.defaultPrevented).toBe(false);
    expect(zoom()).toBe(before);
    const hint = document.querySelector(".map-wheel-hint")!;
    expect(hint.textContent).toBe(WHEEL_HINT_TEXT);
    expect(WHEEL_HINT_TEXT).toBe("Use Ctrl + scroll to zoom");
    expect(hint.getAttribute("data-show")).toBe("true");
  });

  it("the hint fades on its own", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    sizeMapContainers();
    show();
    await vi.advanceTimersByTimeAsync(50);
    wheel(mapEl(), { deltaY: 100 });
    expect(document.querySelector(".map-wheel-hint")!.getAttribute("data-show")).toBe("true");
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(document.querySelector(".map-wheel-hint")!.getAttribute("data-show")).toBe("false");
  });

  it("Ctrl + wheel and ⌘ + wheel zoom, and the event is prevented so the page does not zoom", async () => {
    sizeMapContainers();
    show();
    await flush();
    const start = zoom();
    const ev = wheel(mapEl(), { deltaY: -120, ctrlKey: true });
    expect(ev.defaultPrevented).toBe(true);
    expect(zoom()).toBeGreaterThan(start);
    const mid = zoom();
    wheel(mapEl(), { deltaY: 120, metaKey: true });
    expect(zoom()).toBeLessThan(mid);
  });

  it("many tiny pinch steps add up", async () => {
    sizeMapContainers();
    show({ pin: null });
    await flush();
    const start = zoom();
    for (let i = 0; i < 40; i++) wheel(mapEl(), { deltaY: -4, ctrlKey: true });
    expect(zoom()).toBeGreaterThan(start + 0.5);
  });

  it("the focused map pans with the arrows and zooms with + and −", async () => {
    sizeMapContainers();
    show();
    await flush();
    const el = mapEl();
    expect(el.tabIndex).toBe(0);
    const z = zoom();
    expect(keydown(el, "+").defaultPrevented).toBe(true);
    await flush(400);
    expect(zoom()).toBeGreaterThan(z);
    const z2 = zoom();
    keydown(el, "-");
    await flush(400);
    expect(zoom()).toBeLessThan(z2);
    expect(keydown(el, "ArrowRight").defaultPrevented).toBe(true);
    expect(keydown(el, "a").defaultPrevented).toBe(false);
  });

  it("arrow keys on the pin nudge the pin and do not pan the map", async () => {
    sizeMapContainers();
    const onPin = vi.fn();
    show({ onPin });
    await flush();
    const marker = document.querySelector<HTMLElement>(".leaflet-marker-icon")!;
    const ev = new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true });
    const onMap = vi.fn();
    mapEl().addEventListener("keydown", onMap);
    act(() => { marker.dispatchEvent(ev); });
    expect(onPin).toHaveBeenCalledWith(expect.any(Number), expect.any(Number), "keys");
    expect(onMap).not.toHaveBeenCalled();
  });
});

describe("expanding on a phone", () => {
  const phone = () => mockMatchMedia((q) => q.includes("max-width: 767px"));

  it("offers Expand map only on a phone", async () => {
    mockMatchMedia(() => false);
    show();
    await flush();
    expect(maybe("button", "Expand map")).toBeNull();
  });

  it("opens a full-screen dialog, closes with Esc, and returns focus to the button", async () => {
    phone();
    show();
    await flush();
    expect(document.querySelector("dialog")).toBeNull();
    const expand = get("button", "Expand map");
    expand.focus();
    act(() => { expand.click(); });
    await flush();
    const dialog = document.querySelector<HTMLDialogElement>("dialog.map-dialog")!;
    expect(dialog.hasAttribute("open")).toBe(true);
    // the same map moved in: it is inside the dialog, and the Close button has focus
    expect(dialog.querySelector(".leaflet-container")).not.toBeNull();
    expect(document.querySelectorAll(".leaflet-container").length).toBe(1);
    const close = get("button", "Close map");
    expect(document.activeElement).toBe(close);
    // the attribution is still there, in the dialog
    expect(dialog.querySelector(".map-attrib a")!.textContent).toBe("© OpenStreetMap contributors");

    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => { close.dispatchEvent(esc); });
    await flush();
    expect(document.querySelector("dialog")).toBeNull();
    expect(document.querySelectorAll(".leaflet-container").length).toBe(1);
    expect(document.querySelector(".map-slot .leaflet-container")).not.toBeNull();
    expect(document.activeElement).toBe(get("button", "Expand map"));
  });

  it("closes with the Close button, and a native cancel (Esc in a browser) closes it too", async () => {
    phone();
    show();
    await flush();
    act(() => { get("button", "Expand map").click(); });
    await flush();
    act(() => { get("button", "Close map").click(); });
    await flush();
    expect(document.querySelector("dialog")).toBeNull();
    act(() => { get("button", "Expand map").click(); });
    await flush();
    const cancel = new Event("cancel", { cancelable: true });
    act(() => { document.querySelector("dialog")!.dispatchEvent(cancel); });
    await flush();
    expect(document.querySelector("dialog")).toBeNull();
    expect(cancel.defaultPrevented).toBe(true);
  });

  it("keeps Tab inside the dialog", async () => {
    phone();
    show();
    await flush();
    act(() => { get("button", "Expand map").click(); });
    await flush();
    const dialog = document.querySelector("dialog")!;
    const items = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'));
    const last = items[items.length - 1]!;
    last.focus();
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    act(() => { last.dispatchEvent(tab); });
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(items[0]);
  });

  it("the compact phone map leaves one-finger swipes to the page; the expanded one pans", async () => {
    phone();
    show();
    await flush();
    expect(mapEl().classList.contains("leaflet-touch-drag")).toBe(false);
    act(() => { get("button", "Expand map").click(); });
    await flush();
    expect(mapEl().classList.contains("leaflet-touch-drag")).toBe(true);
  });
});

describe("tiles", () => {
  it("fixtures mode asks for nothing but files of this origin or data: URLs, and no fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    sizeMapContainers();
    show({ pin: null });                // zoomed way out: plain ground tiles
    await flush();
    const tiles = all("img.leaflet-tile");
    expect(tiles.length).toBeGreaterThan(0);
    for (const t of tiles) expect(t.getAttribute("src")).toMatch(/^data:/);
    expect(tiles.every((t) => t.hasAttribute("data-neutral"))).toBe(true);
    // a plain tile, never a "no map here" placeholder
    for (const t of tiles) expect(decodeURIComponent(t.getAttribute("src")!)).not.toMatch(/No map here|<text/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("draws every tile at the example's pin locally: no OSM tile files, nothing from the network", async () => {
    sizeMapContainers();
    show();
    await flush();
    const tiles = all("img.leaflet-tile");
    expect(tiles.length).toBeGreaterThan(0);
    for (const t of tiles) {
      expect(t.getAttribute("src")).toMatch(/^data:/);
      expect(t.hasAttribute("data-neutral")).toBe(true);
    }
    expect(groundTileSvg("rgb(1, 2, 3)")).not.toContain("<text");
  });

  it("live mode asks our proxy, never the tile server", async () => {
    sizeMapContainers();
    show({ fixtures: false });
    await flush();
    const tiles = all("img.leaflet-tile");
    expect(tiles.length).toBeGreaterThan(0);
    for (const t of tiles) expect(t.getAttribute("src")).toMatch(/^\/api\/geo\/tile\/\d+\/\d+\/\d+\.png$/);
  });

  it("never draws the gray road line drawing", async () => {
    sizeMapContainers();
    show({ roads: tboneNet() });
    await flush();
    expect(document.querySelector("path.map-road")).toBeNull();
  });
});

describe("overlays", () => {
  it("draws the chosen streets as a halo and a line under the pin, and nothing for other streets", async () => {
    sizeMapContainers();
    show({ roads: tboneNet(), streets: ["Main Street"] });
    await flush();
    const halos = all("path.map-street-halo");
    const lines = all("path.map-street");
    expect(halos.length).toBeGreaterThan(0);
    expect(lines.length).toBe(halos.length);
    // below the markers
    const overlay = document.querySelector(".leaflet-overlay-pane")!;
    const markers = document.querySelector(".leaflet-marker-pane")!;
    expect(overlay.contains(halos[0]!)).toBe(true);
    expect(overlay.compareDocumentPosition(markers) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(markers.querySelector(".pin-marker")).not.toBeNull();
  });

  it("draws nothing when no street is chosen", async () => {
    sizeMapContainers();
    show({ roads: tboneNet(), streets: [] });
    await flush();
    expect(document.querySelector("path.map-street")).toBeNull();
  });

  it("keeps the OpenStreetMap attribution as a visible link, with and without a pin", async () => {
    show({ pin: null });
    await flush();
    const a = document.querySelector<HTMLAnchorElement>(".map-attrib a")!;
    expect(a.textContent).toBe("© OpenStreetMap contributors");
    expect(a.href).toBe("https://www.openstreetmap.org/copyright");
    expect(a.closest(".map-attrib")!.hasAttribute("hidden")).toBe(false);
  });

  it("reports taps and drags through onPin and onPick, and the view through onBias", async () => {
    sizeMapContainers();
    const onPin = vi.fn();
    const onPick = vi.fn();
    const onBias = vi.fn();
    show({ onPin, onPick, onBias });
    await flush();
    act(() => { keydown(document.querySelector(".leaflet-marker-icon")!, "ArrowUp"); });
    expect(onPin).toHaveBeenCalledWith(expect.any(Number), expect.any(Number), "keys");
    expect(onPick).toHaveBeenCalledWith(expect.any(Number), expect.any(Number));
    act(() => { keydown(mapEl(), "ArrowLeft"); });
    await flush(500);
    expect(onBias).toHaveBeenCalled();
  });
});

describe("the PDF thumbnail still comes from the loaded tiles", () => {
  const rect = { x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 500, width: 800, height: 500, toJSON: () => ({}) };
  function stubCanvas() {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(rect);
    const drawn: unknown[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ scale: vi.fn(), translate: vi.fn(), save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), stroke: vi.fn(), drawImage: (...a: unknown[]) => { drawn.push(a); } } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((cb) => cb(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" })));
    return drawn;
  }
  const loadTiles = () => act(() => { for (const t of all("img.leaflet-tile")) t.dispatchEvent(new Event("load")); });

  it("is never captured in fixtures mode, where every tile is drawn (the PDF draws the road outline instead)", async () => {
    stubCanvas();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    sizeMapContainers();
    show();
    await vi.advanceTimersByTimeAsync(50);
    loadTiles();
    await vi.advanceTimersByTimeAsync(900);
    expect(mapThumbnail.get(pin)).toBeNull();
  });

  it("is not made of the neutral stand-in tiles", async () => {
    stubCanvas();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    sizeMapContainers();
    show({ pin: { lat: 0.1, lon: 0.1 } });     // far from every example
    await vi.advanceTimersByTimeAsync(50);
    loadTiles();
    await vi.advanceTimersByTimeAsync(900);
    expect(all("img.leaflet-tile").length).toBeGreaterThan(0);
    expect(mapThumbnail.get({ lat: 0.1, lon: 0.1 })).toBeNull();
  });
});
