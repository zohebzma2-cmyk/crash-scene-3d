// @vitest-environment jsdom
// The media client (photos, models, logos from our own /api) and the two components that use it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MEDIA_HEADERS, PROXY_ROUTES } from "@csd/core";
import { createMediaService, makeLogoUrl, vehicleImageUrl, vehicleModelUrl, viewFor } from "../src/services/media";
import { createFixtureMediaFetch, fixtureMediaMode } from "../src/services/media-fixtures";
import { initialDoc, reducer, type Doc } from "../src/state/doc";
import { flush, renderApp, setValue, text } from "./helpers";
import { makeServices, tbone } from "./fakes";

// Vitest runs from the repo root (under jsdom, import.meta.url is not a file URL).
const fixture = (name: string) => new Uint8Array(readFileSync(join(process.cwd(), "apps/web/test/fixtures/media", name)));
const CAR_PNG = fixture("car.png");
const LOGO_PNG = fixture("logo.png");
const WEBP = new Uint8Array([...new TextEncoder().encode("RIFF"), 1, 0, 0, 0, ...new TextEncoder().encode("WEBPVP8 x")]);

const F150 = { year: 2022, make: "Ford", model: "F-150" };

function recorder(answer: (url: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  const fetchFn = vi.fn(async (url: string) => { calls.push(url); return answer(url); });
  return { calls, fetchFn };
}

describe("media URLs", () => {
  it("are same-origin /api URLs carrying only year, make and model", () => {
    expect(vehicleImageUrl(F150)).toBe(`${PROXY_ROUTES.vehicleImage}?make=Ford&model=F-150&year=2022`);
    expect(vehicleImageUrl({ ...F150, year: null }, { view: "side", width: 800 })).toBe(`${PROXY_ROUTES.vehicleImage}?make=Ford&model=F-150&view=side&width=800`);
    expect(vehicleImageUrl({ ...F150, type: "motorcycle" })).toContain("type=moto");
    expect(vehicleModelUrl(F150)).toBe(`${PROXY_ROUTES.vehicleModel}?make=Ford&model=F-150&year=2022`);
    expect(vehicleModelUrl({ ...F150, type: "motorcycle" })).toBeNull();
    expect(makeLogoUrl("  Land   Rover ")).toBe(`${PROXY_ROUTES.makeLogo}?name=Land+Rover`);
  });

  it("are not made for empty or odd text", () => {
    expect(vehicleImageUrl({ ...F150, model: "" })).toBeNull();
    expect(vehicleImageUrl({ ...F150, make: "<b>" })).toBeNull();
    expect(makeLogoUrl("")).toBeNull();
  });

  it("viewFor: front 3/4 by default, the side from above, the front from a driver's seat", () => {
    expect(viewFor("wide")).toBe("front34");
    expect(viewFor("aftermath")).toBe("front34");
    expect(viewFor("top")).toBe("side");
    expect(viewFor("driver-a")).toBe("front");
    expect(viewFor("driver-b")).toBe("front");
  });
});

describe("media client fallbacks", () => {
  it("a photo comes back with its bytes and the angle served", async () => {
    const r = recorder(() => new Response(WEBP as BodyInit, { headers: { "content-type": "image/webp", [MEDIA_HEADERS.image]: "exact", [MEDIA_HEADERS.view]: "front34" } }));
    const m = createMediaService(r.fetchFn);
    const a = await m.probe(vehicleImageUrl(F150)!);
    expect(a?.contentType).toBe("image/webp");
    expect(a?.view).toBe("front34");
    expect(a?.bytes).toEqual(WEBP);
  });

  it.each([
    ["204", () => new Response(null, { status: 204, headers: { [MEDIA_HEADERS.fallback]: "quota" } })],
    ["JSON {fallback:true}", () => new Response(JSON.stringify({ fallback: true, reason: "no-model" }), { headers: { "content-type": "application/json" } })],
    ["429", () => new Response(JSON.stringify({ code: "busy", message: "Busy." }), { status: 429, headers: { "content-type": "application/json" } })],
    ["500", () => new Response("oops", { status: 500 })],
    ["an empty image", () => new Response(new Uint8Array(0) as BodyInit, { headers: { "content-type": "image/png" } })],
    ["HTML labelled as anything else", () => new Response("<html></html>", { headers: { "content-type": "text/html" } })],
    ["no network", () => { throw new TypeError("Failed to fetch"); }],
  ])("%s means 'use our own', never an error", async (_name, answer) => {
    const m = createMediaService(recorder(answer).fetchFn);
    await expect(m.probe(vehicleImageUrl(F150)!)).resolves.toBeNull();
    await expect(m.photoPng(F150)).resolves.toBeNull();
  });

  it("asks once per URL per session, whoever asks", async () => {
    const r = recorder(() => new Response(null, { status: 204 }));
    const m = createMediaService(r.fetchFn);
    const url = vehicleImageUrl(F150)!;
    await Promise.all([m.probe(url), m.probe(url), m.objectUrl(url)]);
    await m.probe(url);
    expect(r.calls).toEqual([url]);
  });

  it("never fetches anything but our own /api", async () => {
    const r = recorder(() => new Response(null, { status: 204 }));
    const m = createMediaService(r.fetchFn);
    await expect(m.probe("https://cdn.example.test/car.webp")).resolves.toBeNull();
    expect(r.calls).toEqual([]);
  });

  it("photoPng: a PNG is passed through; cachedOnly never spends a call", async () => {
    const r = recorder(() => new Response(CAR_PNG as BodyInit, { headers: { "content-type": "image/png" } }));
    const m = createMediaService(r.fetchFn);
    await expect(m.photoPng(F150, { cachedOnly: true })).resolves.toBeNull();
    expect(r.calls).toEqual([]);
    await m.probe(vehicleImageUrl(F150)!);
    await expect(m.photoPng(F150, { cachedOnly: true })).resolves.toEqual(CAR_PNG);
    expect(r.calls).toHaveLength(1);
  });

  it("models carry the watermark flag; logos their source, and a logo.dev logo turns its credit on", async () => {
    const r = recorder((url) => url.startsWith(PROXY_ROUTES.vehicleModel)
      ? new Response(fixture("car.glb") as BodyInit, { headers: { "content-type": "model/gltf-binary", [MEDIA_HEADERS.watermarked]: "true" } })
      : new Response(LOGO_PNG as BodyInit, { headers: { "content-type": "image/png", [MEDIA_HEADERS.logoSource]: "logodev" } }));
    const m = createMediaService(r.fetchFn);
    expect((await m.probe(vehicleModelUrl(F150)!))?.watermarked).toBe(true);
    const seen = vi.fn();
    m.logoCredit.subscribe(seen);
    expect(m.logoCredit.get()).toBe(false);
    expect((await m.probe(makeLogoUrl("Kia")!))?.source).toBe("logodev");
    expect(m.logoCredit.get()).toBe(true);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("fixtures: ?media=on serves the synthetic files, busy answers 429, the default is the fallback", async () => {
    expect(fixtureMediaMode("?fixtures=1&media=on")).toBe("on");
    expect(fixtureMediaMode("?media=busy")).toBe("busy");
    expect(fixtureMediaMode("?fixtures=1")).toBe("off");
    const load = async (name: string) => fixture(name);
    const on = createMediaService(createFixtureMediaFetch("on", load));
    // Photos come as WebP, like production's (the browser converts them to PNG for the PDF and the stills).
    const photo = await on.probe(vehicleImageUrl(F150)!);
    expect(photo?.contentType).toBe("image/webp");
    expect(photo?.bytes).toEqual(fixture("car.webp"));
    expect((await on.probe(vehicleModelUrl(F150)!))?.contentType).toBe("model/gltf-binary");
    const busy = createFixtureMediaFetch("busy", load);
    expect((await busy(vehicleImageUrl(F150)!)).status).toBe(429);
    const off = createMediaService(createFixtureMediaFetch("off", load));
    await expect(off.probe(vehicleImageUrl(F150)!)).resolves.toBeNull();
    await expect(off.probe(vehicleModelUrl(F150)!)).resolves.toBeNull();
  });
});

describe("the vehicle card's photo and logo", () => {
  let app: Awaited<ReturnType<typeof renderApp>> | null = null;
  let n = 0;
  beforeEach(() => {
    // jsdom has no blob: URLs.
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => `blob:test/${++n}`), revokeObjectURL: vi.fn() }));
  });
  afterEach(() => { app?.unmount(); app = null; vi.unstubAllGlobals(); vi.useRealTimers(); });

  const located = (): Doc => ({ ...reducer(initialDoc(), { type: "pin", lat: tbone.location.lat, lon: tbone.location.lon, how: "tap" }), directionSet: [true, true] });
  const card = (id: string) => document.getElementById(`vehicle-${id}`) as HTMLElement;

  async function pickF150(fetchFn: (url: string) => Promise<Response>) {
    const { services, models } = makeServices({ media: createMediaService(fetchFn) });
    void models;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    app = await renderApp(services, { hash: "#vehicles", storage: located() });
    const b = card("B");
    const [year, make, model] = [...b.querySelectorAll<HTMLInputElement>("input[type=text]")] as [HTMLInputElement, HTMLInputElement, HTMLInputElement];
    setValue(year, "2018");
    setValue(make, "Ford");
    await vi.advanceTimersByTimeAsync(700);
    await flush();
    setValue(model, "F-150");
    await vi.advanceTimersByTimeAsync(700);
    await flush();
    await flush();
    return b;
  }

  it("shows the maker logo and the photo once a model is picked, and asked nothing while typing", async () => {
    const calls: string[] = [];
    const b = await pickF150(async (url) => {
      calls.push(url);
      return url.startsWith(PROXY_ROUTES.makeLogo)
        ? new Response(LOGO_PNG as BodyInit, { headers: { "content-type": "image/png", [MEDIA_HEADERS.logoSource]: "carimages" } })
        : new Response(CAR_PNG as BodyInit, { headers: { "content-type": "image/png", [MEDIA_HEADERS.image]: "exact" } });
    });
    const photo = b.querySelector(".vehicle-photo")!;
    expect(photo.getAttribute("data-photo")).toBe("photo");
    expect(photo.querySelector("img")?.getAttribute("alt")).toBe("Stock photo of a 2018 Ford F-150");
    const logo = b.querySelector(".make-logo")!;
    expect(logo.getAttribute("data-make-logo")).toBe("logo");
    expect(logo.querySelector("img")?.getAttribute("alt")).toBe("Ford");
    // For card B, one logo call and one photo call, each for the finished text only (card A asks for its own make's logo).
    expect(calls.filter((c) => !c.includes("Honda"))).toEqual([`${PROXY_ROUTES.makeLogo}?name=Ford`, `${PROXY_ROUTES.vehicleImage}?make=Ford&model=F-150&year=2018`]);
    // The carimages logo needs no credit.
    expect(document.querySelector(".logo-credit")).toBeNull();
  });

  it("round B: the catalog photo always says it is the catalog's ('Catalog photo'), with the picked colour once there is one", async () => {
    const b = await pickF150(async (url) => new Response((url.startsWith(PROXY_ROUTES.makeLogo) ? LOGO_PNG : CAR_PNG) as BodyInit, { headers: { "content-type": "image/png", [MEDIA_HEADERS.image]: "exact", [MEDIA_HEADERS.logoSource]: "carimages" } }));
    expect(b.querySelector(".vehicle-photo")?.getAttribute("data-photo")).toBe("photo");
    expect(b.querySelector(".vehicle-photo-wrap .paint-chip")?.textContent).toBe("Catalog photo");
    const radio = (name: string) => [...b.querySelectorAll<HTMLElement>('[data-paint-picker] [role="radio"]')].find((r) => (r.getAttribute("aria-label") ?? r.textContent) === name)!;
    radio("Red").click();
    await flush();
    const chip = b.querySelector(".vehicle-photo-wrap .paint-chip");
    expect(chip?.textContent).toBe("Catalog photo · Picked: Red");
    expect(b.querySelector(".vehicle-photo-wrap .vehicle-photo")?.getAttribute("data-photo")).toBe("photo");
    radio("Not sure of the colour").click();
    await flush();
    expect(b.querySelector(".vehicle-photo-wrap .paint-chip")?.textContent).toBe("Catalog photo");
  });

  it("over quota (429): our icons, no error text", async () => {
    const b = await pickF150(async () => new Response(JSON.stringify({ code: "busy", message: "We're getting a lot of map requests right now." }), { status: 429, headers: { "content-type": "application/json" } }));
    expect(b.querySelector(".vehicle-photo")?.getAttribute("data-photo")).toBe("icon");
    expect(b.querySelector(".vehicle-photo .icon")).not.toBeNull();
    expect(b.querySelector(".make-logo")?.getAttribute("data-make-logo")).toBe("icon");
    expect(text(b)).not.toMatch(/busy|error|wrong|couldn't|requests/i);
  });

  it("a logo.dev logo shows its credit link", async () => {
    await pickF150(async (url) => url.startsWith(PROXY_ROUTES.makeLogo)
      ? new Response(LOGO_PNG as BodyInit, { headers: { "content-type": "image/png", [MEDIA_HEADERS.logoSource]: "logodev" } })
      : new Response(null, { status: 204 }));
    const credit = document.querySelector<HTMLAnchorElement>(".logo-credit a");
    expect(credit?.textContent).toBe("Logos provided by Logo.dev");
    expect(credit?.getAttribute("href")).toBe("https://logo.dev");
    expect(credit?.getAttribute("rel")).toBe("noopener noreferrer");
  });
});
