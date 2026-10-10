// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocationMap } from "../src/components/LocationMap";
import { mapConfig } from "../src/config/map";
import { crc32 as nodeCrc32 } from "node:zlib";
import { PNG_METERS_PER_PIXEL_KEY } from "@csd/exports";
import { thumbnailMetersPerPixel } from "../../../packages/exports/src/png-meta";
import { addPngText, captureThumbnail, metersPerImagePixel, paintThumbnail, thumbnailCrop } from "../src/lib/thumbnail";
import { ServicesProvider } from "../src/services/context";
import { mapThumbnail } from "../src/services/thumbnail";
import { click, flush, get, mount, renderApp } from "./helpers";
import { makeServices, tbone } from "./fakes";

let app: { unmount: () => void } | null = null;
afterEach(() => { app?.unmount(); app = null; mapThumbnail.clear(); vi.useRealTimers(); vi.restoreAllMocks(); });

const bytes = new Uint8Array([1, 2, 3]);
const pin = { lat: tbone.location.lat, lon: tbone.location.lon };

describe("map thumbnail", () => {
  it("is returned only for the pin it was captured for", () => {
    mapThumbnail.set(bytes, pin);
    expect(mapThumbnail.get(pin)).toBe(bytes);
    expect(mapThumbnail.get({ lat: pin.lat + 0.0001, lon: pin.lon })).toBeNull();
    expect(mapThumbnail.get({ lat: pin.lat, lon: pin.lon - 0.0001 })).toBeNull();
    mapThumbnail.clear();
    expect(mapThumbnail.get(pin)).toBeNull();
  });

  it("is cleared when an example replaces the scene", async () => {
    mapThumbnail.set(bytes, pin);
    const { services } = makeServices();
    app = await renderApp(services, { search: "?example=t-bone-intersection", hash: "#review" });
    await flush();
    expect(mapThumbnail.get(pin)).toBeNull();
  });

  it("is cleared when the pin moves (a search pick)", async () => {
    const { services } = makeServices();
    app = await renderApp(services);
    mapThumbnail.set(bytes, pin);
    click(get("button", "Search"));
    await flush();
    expect(mapThumbnail.get(pin)).toBe(bytes);      // a search alone doesn't move the pin
    click(get("button", /Main Street & Park Street/));
    await flush();
    expect(mapThumbnail.get(pin)).toBeNull();
  });

  it("is cleared when a capture draws no tiles, instead of keeping a blank or old picture", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100, toJSON: () => ({}) });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ scale: vi.fn(), drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    const { services } = makeServices({ mode: "live" });
    app = mount(<ServicesProvider services={services}><LocationMap pin={pin} focusSeq={0} onPin={() => undefined} fixtures={false} roads={null} /></ServicesProvider>);
    mapThumbnail.set(bytes, pin);              // an earlier capture
    await vi.advanceTimersByTimeAsync(700);   // the map has no loaded tiles in jsdom
    expect(mapThumbnail.get(pin)).toBeNull();
  });
});

describe("thumbnail capture is centered on the pin", () => {
  it("crops the view to the largest rectangle centered on the pin", () => {
    // pin in the middle: the whole view
    expect(thumbnailCrop({ w: 400, h: 200 }, { x: 200, y: 100 }, 120)).toEqual({ x: 0, y: 0, w: 400, h: 200 });
    // pin dragged to the left of center: still centered on the pin, so narrower
    const left = thumbnailCrop({ w: 400, h: 200 }, { x: 150, y: 100 }, 120)!;
    expect(left).toEqual({ x: 0, y: 0, w: 300, h: 200 });
    expect(left.x + left.w / 2).toBe(150);
    expect(left.y + left.h / 2).toBe(100);
    // pin near the top: shorter, centered on the pin
    const top = thumbnailCrop({ w: 400, h: 200 }, { x: 200, y: 70 }, 120)!;
    expect(top).toEqual({ x: 0, y: 0, w: 400, h: 140 });
    expect(top.y + top.h / 2).toBe(70);
  });

  it("gives up (so the PDF draws the road outline) when the pin is too close to an edge", () => {
    expect(thumbnailCrop({ w: 400, h: 200 }, { x: 30, y: 100 }, 120)).toBeNull();
    expect(thumbnailCrop({ w: 400, h: 200 }, { x: 200, y: 20 }, 120)).toBeNull();
    expect(thumbnailCrop({ w: 400, h: 200 }, { x: Number.NaN, y: 100 }, 120)).toBeNull();
  });

  it("paints the tiles shifted to the crop, the pin dot at the picture's center, and skips tiles outside the crop", () => {
    const calls: Array<[string, ...unknown[]]> = [];
    const ctx = new Proxy({}, {
      get: (_t, prop: string) => (...a: unknown[]) => { calls.push([prop, ...a]); },
      set: (_t, prop: string, v: unknown) => { calls.push([`set:${prop}`, v]); return true; },
    }) as unknown as CanvasRenderingContext2D;
    const crop = thumbnailCrop({ w: 400, h: 200 }, { x: 150, y: 100 }, 120)!;
    const img = {} as CanvasImageSource;
    const drew = paintThumbnail(ctx, {
      crop, pin: { x: 150, y: 100 }, scale: 2, dotRadius: 7, ringWidth: 3, dotColor: "#111111", ringColor: "#eeeeee",
      tiles: [
        { image: img, rect: { x: 0, y: 0, w: 256, h: 256 } },
        { image: img, rect: { x: 350, y: 0, w: 256, h: 256 } },    // beyond the crop (it ends at x = 300)
      ],
    });
    expect(drew).toBe(1);
    // the shift is the crop's corner, at 2x
    expect(calls.find((c) => c[0] === "scale")).toEqual(["scale", 2, 2]);
    expect(calls.find((c) => c[0] === "translate")).toEqual(["translate", -crop.x, -crop.y]);
    // the dot is at the pin; after the shift that is the center of the crop
    const arc = calls.find((c) => c[0] === "arc")!;
    expect([arc[1], arc[2], arc[3]]).toEqual([150, 100, 7]);
    expect((arc[1] as number) - crop.x).toBe(crop.w / 2);
    expect((arc[2] as number) - crop.y).toBe(crop.h / 2);
    // with no tile in the crop nothing is drawn, not even the dot
    calls.length = 0;
    expect(paintThumbnail(ctx, { crop, pin: { x: 150, y: 100 }, scale: 2, dotRadius: 7, ringWidth: 3, dotColor: "#111111", ringColor: "#eeeeee", tiles: [{ image: img, rect: { x: 350, y: 0, w: 256, h: 256 } }] })).toBe(0);
    expect(calls.some((c) => c[0] === "arc")).toBe(false);
  });

  it("reads tiles from our own origin, so the canvas is never tainted", () => {
    const url = new URL(mapConfig.tilesUrl.replace("{z}", "18").replace("{x}", "1").replace("{y}", "2"), "http://localhost:5173");
    expect(url.origin).toBe("http://localhost:5173");
    expect(url.pathname).toMatch(/^\/api\/geo\/tile\/18\/1\/2\.png$/);
  });
});

describe("capturing never leaves an old thumbnail alive", () => {
  const img = {} as CanvasImageSource;
  const crop = { x: 0, y: 0, w: 300, h: 200 };
  const base = { crop, pin: { x: 150, y: 100 }, scale: 2, dotRadius: 7, ringWidth: 3, dotColor: "#111111", ringColor: "#eeeeee", tiles: [{ image: img, rect: { x: 0, y: 0, w: 256, h: 256 } }] };
  const ctx = new Proxy({}, { get: () => () => undefined, set: () => true }) as unknown as CanvasRenderingContext2D;
  const canvasWith = (opts: { ctx?: CanvasRenderingContext2D | null; toBlob?: HTMLCanvasElement["toBlob"] }) => (() => ({
    getContext: () => (opts.ctx === undefined ? ctx : opts.ctx),
    toBlob: opts.toBlob ?? ((cb: BlobCallback) => cb(new Blob([new Uint8Array([9, 8, 7])], { type: "image/png" }))),
  }) as unknown as HTMLCanvasElement);

  it("returns the PNG bytes when everything works", async () => {
    const bytes = await captureThumbnail({ ...base, createCanvas: canvasWith({}) });
    expect([...bytes!]).toEqual([9, 8, 7]);
  });
  it("returns null when there is no 2D context", async () => {
    expect(await captureThumbnail({ ...base, createCanvas: canvasWith({ ctx: null }) })).toBeNull();
  });
  it("returns null when toBlob gives no blob", async () => {
    expect(await captureThumbnail({ ...base, createCanvas: canvasWith({ toBlob: (cb) => cb(null) }) })).toBeNull();
  });
  it("returns null when toBlob throws, or the blob can't be read", async () => {
    expect(await captureThumbnail({ ...base, createCanvas: canvasWith({ toBlob: () => { throw new Error("tainted"); } }) })).toBeNull();
    const broken = { arrayBuffer: () => Promise.reject(new Error("nope")) } as unknown as Blob;
    expect(await captureThumbnail({ ...base, createCanvas: canvasWith({ toBlob: (cb) => cb(broken) }) })).toBeNull();
  });
  it("returns null when painting throws or no tile was drawn", async () => {
    const angry = new Proxy({}, { get: (_t, p: string) => (p === "drawImage" ? () => { throw new Error("tainted"); } : () => undefined), set: () => true }) as unknown as CanvasRenderingContext2D;
    expect(await captureThumbnail({ ...base, createCanvas: canvasWith({ ctx: angry }) })).toBeNull();
    expect(await captureThumbnail({ ...base, tiles: [], createCanvas: canvasWith({}) })).toBeNull();
  });
  it("the map clears the stored thumbnail when the capture comes back empty", async () => {
    mapThumbnail.set(bytes, pin);
    const result = await captureThumbnail({ ...base, createCanvas: canvasWith({ toBlob: (cb) => cb(null) }) });
    // the map applies it this way: a result of null clears, bytes replace
    if (result) mapThumbnail.set(result, pin); else mapThumbnail.clear();
    expect(mapThumbnail.get(pin)).toBeNull();
  });
});

describe("the thumbnail says how big a pixel is, for the PDF's street names", () => {
  // a 1 x 1 PNG
  const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

  it("computes Web Mercator meters per picture pixel", () => {
    expect(metersPerImagePixel(0, 0, 1)).toBeCloseTo(156543.034, 2);
    // one zoom in halves it, a 2x picture halves it again, and it shrinks with the cosine of the latitude
    expect(metersPerImagePixel(0, 1, 1)).toBeCloseTo(156543.034 / 2, 2);
    expect(metersPerImagePixel(0, 18, 2)).toBeCloseTo(156543.034 / 2 ** 19, 6);
    expect(metersPerImagePixel(60, 10, 1)).toBeCloseTo(metersPerImagePixel(0, 10, 1) / 2, 6);
  });

  it("adds a valid tEXt chunk before IEND that the PDF can read back", () => {
    const out = addPngText(png, PNG_METERS_PER_PIXEL_KEY, "0.2193");
    expect([...out.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(String.fromCharCode(...out.subarray(out.length - 8, out.length - 4))).toBe("IEND");
    expect(out.length).toBeGreaterThan(png.length);
    // the chunk's CRC is right
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    const start = png.length - 12;
    const len = dv.getUint32(start);
    expect(String.fromCharCode(...out.subarray(start + 4, start + 8))).toBe("tEXt");
    expect(dv.getUint32(start + 8 + len)).toBe(nodeCrc32(out.subarray(start + 4, start + 8 + len)));
    expect(thumbnailMetersPerPixel(out)).toBeCloseTo(0.2193, 6);
    // a picture without it, and rubbish, give no scale
    expect(thumbnailMetersPerPixel(png)).toBeNull();
    expect(thumbnailMetersPerPixel(addPngText(png, PNG_METERS_PER_PIXEL_KEY, "-3"))).toBeNull();
    expect(thumbnailMetersPerPixel(addPngText(png, PNG_METERS_PER_PIXEL_KEY, "abc"))).toBeNull();
    // something that isn't a PNG comes back untouched
    const junk = new Uint8Array([1, 2, 3, 4]);
    expect(addPngText(junk, "k", "v")).toBe(junk);
  });

  it("captureThumbnail writes the scale into the picture it returns", async () => {
    const ctx = new Proxy({}, { get: () => () => undefined, set: () => true }) as unknown as CanvasRenderingContext2D;
    const canvas = () => ({ getContext: () => ctx, toBlob: (cb: BlobCallback) => cb(new Blob([png as BlobPart], { type: "image/png" })) }) as unknown as HTMLCanvasElement;
    const o = { crop: { x: 0, y: 0, w: 300, h: 200 }, pin: { x: 150, y: 100 }, scale: 2, dotRadius: 7, ringWidth: 3, dotColor: "#111111", ringColor: "#eeeeee", tiles: [{ image: {} as CanvasImageSource, rect: { x: 0, y: 0, w: 256, h: 256 } }], createCanvas: canvas };
    const withScale = await captureThumbnail({ ...o, metersPerPixel: 0.22 });
    expect(thumbnailMetersPerPixel(withScale!)).toBeCloseTo(0.22, 6);
    const without = await captureThumbnail(o);
    expect(thumbnailMetersPerPixel(without!)).toBeNull();
  });
});
