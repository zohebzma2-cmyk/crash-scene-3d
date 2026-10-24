import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { BUSY_MESSAGE, type BrandFonts, type ExportBundle, type ExportRequest, type PlaceResult } from "@csd/core";
import { createExportsService } from "../src/services/exports";
import { fakeMergeSearchResults, fakeSplitCrossingQuery } from "../src/services/fakes";
import { withFallback } from "../src/services/fallbacks";
import { FONT_URLS, loadBrandFonts } from "../src/exports/browser-canvas";
import { createGeoService, searchUrl } from "../src/services/geo";
import { getJson } from "../src/services/http";
import { ServiceError } from "../src/services/types";
import { tbone } from "./fakes";

const place = (label: string, lat = 42.76, lon = -71.46, kind = "road"): PlaceResult => ({ label, main: label.split(",")[0] ?? label, sub: "Nashua", lat, lon, kind });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function geo(body: unknown = [place("Main Street, Nashua")], opts: { status?: number } = {}) {
  const fetchFn = vi.fn(async (_url: string) => json(body, opts.status ?? 200));
  let t = 0;
  const sleeps: number[] = [];
  const svc = createGeoService(fetchFn, { splitCrossing: fakeSplitCrossingQuery, mergeResults: fakeMergeSearchResults, now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; } });
  return { svc, fetchFn, sleeps, advance: (ms: number) => { t += ms; } };
}

describe("location search routing (intersection search)", () => {
  it('sends "X and Y" to /api/geo/crossing with both street names', async () => {
    const { svc, fetchFn } = geo();
    await svc.search("Main Street and Amherst Street, Nashua NH");
    const url = String(fetchFn.mock.calls[0]?.[0]);
    expect(url.startsWith("/api/geo/crossing?")).toBe(true);
    const q = new URL(url, "http://x").searchParams;
    expect(q.get("a")).toBe("Main Street");
    expect(q.get("b")).toBe("Amherst Street");
    expect(q.get("near")).toBe("Nashua NH");
  });

  it('sends "X & Y" the same way', () => {
    const url = searchUrl("Main St & Park St, Nashua", fakeSplitCrossingQuery);
    expect(url.startsWith("/api/geo/crossing?")).toBe(true);
    expect(new URL(url, "http://x").searchParams.get("b")).toBe("Park St");
  });

  it("sends plain text to /api/geo/search with only the text and the fixed limit", async () => {
    const { svc, fetchFn } = geo();
    await svc.search("Nashua City Hall");
    const url = String(fetchFn.mock.calls[0]?.[0]);
    expect(url.startsWith("/api/geo/search?")).toBe(true);
    expect([...new URL(url, "http://x").searchParams.keys()].sort()).toEqual(["limit", "q"]);
    expect(new URL(url, "http://x").searchParams.get("q")).toBe("Nashua City Hall");
  });

  it("merges duplicate street segments in the results", async () => {
    const dup = [place("Main Street, Nashua", 42.76, -71.46), place("Main Street, Nashua", 42.7601, -71.4601), place("Park Street, Nashua", 42.77, -71.47)];
    const { svc } = geo(dup);
    const out = await svc.search("Main Street");
    expect(out.map((r) => r.label)).toEqual(["Main Street, Nashua", "Park Street, Nashua"]);
  });

  it("never calls anything outside /api", async () => {
    await expect(getJson(vi.fn(), "https://nominatim.openstreetmap.org/search?q=x")).rejects.toBeInstanceOf(ServiceError);
    const { svc, fetchFn } = geo();
    await svc.search("Elm Street");
    for (const [u] of fetchFn.mock.calls) expect(String(u).startsWith("/api/")).toBe(true);
  });
});

describe("search etiquette", () => {
  it("answers a repeat of the same query from the session cache without a new request", async () => {
    const { svc, fetchFn } = geo();
    await svc.search("Elm Street");
    await svc.search("  Elm Street ");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("merges a repeat press within 300 ms into the one request", async () => {
    const { svc, fetchFn } = geo();
    const [a, b] = await Promise.all([svc.search("Oak Street"), svc.search("Oak Street")]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });

  it("keeps requests at least one second apart", async () => {
    const { svc, sleeps } = geo();
    await svc.search("One Street");
    await svc.search("Two Street");
    expect(sleeps.length).toBe(1);
    expect(sleeps[0]).toBeGreaterThan(900);
  });

  it("shows the proxy's busy message as text, and nothing worse", async () => {
    const { svc } = geo({ code: "busy", message: BUSY_MESSAGE, retryAfterS: 2 }, { status: 429 });
    await expect(svc.search("Busy Street")).rejects.toMatchObject({ message: BUSY_MESSAGE, code: "busy" });
  });

  it("turns a network failure or garbage into a plain sentence", async () => {
    const svc = createGeoService(async () => { throw new TypeError("Failed to fetch"); }, { splitCrossing: () => null, mergeResults: (r) => [...r] });
    await expect(svc.search("Anywhere")).rejects.toMatchObject({ code: "network" });
    const svc2 = createGeoService(async () => new Response("<html>oops</html>", { status: 502 }), { splitCrossing: () => null, mergeResults: (r) => [...r] });
    const err = await svc2.search("Anywhere").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as Error).message).not.toMatch(/html/i);
  });
});

describe("timeouts", () => {
  it("waits 10 s for every /api call, so the proxy's own 9.3 s answer is never cut off", async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      const slow = (_url: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => { aborted = true; reject(new DOMException("aborted", "AbortError")); });
        setTimeout(() => resolve(json({ ok: 1 })), 9000);
      });
      const p = getJson(slow, "/api/geo/search?q=x");
      await vi.advanceTimersByTimeAsync(9000);
      await expect(p).resolves.toEqual({ ok: 1 });
      expect(aborted).toBe(false);
      const never = (_url: string, init?: RequestInit) => new Promise<Response>((_r, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      const q = getJson(never, "/api/vehicles/makes").catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(9999);
      let settled = false;
      void q.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(await q).toMatchObject({ code: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("stand-in fallback", () => {
  it('uses the stand-in only in fixtures mode, and only for "not implemented yet"', () => {
    const real = () => { throw new Error("not implemented yet: x"); };
    expect(withFallback(real, () => "fake", true)()).toBe("fake");
    expect(() => withFallback(real, () => "fake", false)()).toThrow("not implemented yet");
    expect(() => withFallback(() => { throw new Error("real failure"); }, () => "fake", true)()).toThrow("real failure");
  });
});

describe("brand fonts for exports", () => {
  it("points at the self-hosted @fontsource files, and they exist", () => {
    for (const rel of ["plus-jakarta-sans/files/plus-jakarta-sans-latin-400-normal.woff", "plus-jakarta-sans/files/plus-jakarta-sans-latin-700-normal.woff", "jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff"]) {
      expect(existsSync(fileURLToPath(new URL(`../../../node_modules/@fontsource/${rel}`, import.meta.url)))).toBe(true);
    }
    expect(Object.keys(FONT_URLS).sort()).toEqual(["monoRegular", "sansBold", "sansRegular"]);
  });

  it("loads the font bytes and hands exactly those bytes to buildExports", async () => {
    // the real loader, fed the actual font files by their file names
    const fonts: BrandFonts = await loadBrandFonts(async (url) => {
      const base = url.split("/").pop()?.split("?")[0] ?? "";
      const pkg = base.startsWith("jetbrains") ? "jetbrains-mono" : "plus-jakarta-sans";
      return new Response(new Uint8Array(readFileSync(fileURLToPath(new URL(`../../../node_modules/@fontsource/${pkg}/files/${base}`, import.meta.url)))));
    });
    expect(fonts.sansRegular.byteLength).toBeGreaterThan(1000);
    expect(fonts.sansBold.byteLength).toBeGreaterThan(1000);
    expect(fonts.monoRegular.byteLength).toBeGreaterThan(1000);

    const build = vi.fn(async (_req: ExportRequest, _canvas: unknown): Promise<ExportBundle> => ({ stamp: { createdAt: "2026-10-09T00:00:00Z", fingerprintHex: "0".repeat(64), fingerprintShort: "0000 0000 0000 0000" }, files: [], skipped: [], notes: [] }));
    const canvas = { create: vi.fn(), toPng: vi.fn(), registerFonts: vi.fn() };
    const svc = createExportsService({ buildExports: build, canvas, loadFonts: async () => fonts });
    const sim = { physicsVersion: "t" } as never;
    await svc.build({ scene: tbone, sim, roads: null, formats: ["pdf", "png-diagram"] });
    const req = build.mock.calls[0]![0];
    expect(req.fonts.sansRegular).toBe(fonts.sansRegular);
    expect(req.fonts.sansBold).toBe(fonts.sansBold);
    expect(req.fonts.monoRegular).toBe(fonts.monoRegular);
    expect(req.formats).toEqual(["pdf", "png-diagram"]);
    expect(build.mock.calls[0]?.[1]).toBe(canvas);
  });

  it("refuses an empty or failed font download instead of exporting in a fallback font", async () => {
    await expect(loadBrandFonts(async () => new Response(new Uint8Array(0)))).rejects.toThrow(/fonts/);
    await expect(loadBrandFonts(async () => new Response("no", { status: 404 }))).rejects.toThrow(/fonts/);
  });
});
