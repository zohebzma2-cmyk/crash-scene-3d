// @vitest-environment jsdom
// The app's wiring of the Save step to @csd/exports passes every argument on, the stock photo provider included.
// The lazy-chunk wrapper once took (req, canvas) only, so every saved PDF and still lost the photo the card showed
// (2026-10-11): unit tests of each side passed, and only the wiring dropped it.
import { describe, expect, it, vi } from "vitest";
import { MEDIA_HEADERS, PROXY_ROUTES, type ExportBundle, type SceneVehicle } from "@csd/core";
import type { VehicleMediaProvider } from "@csd/exports";
import { createServices } from "../src/services";
import { tbone } from "./fakes";

const calls = vi.hoisted(() => [] as unknown[][]);
vi.mock("@csd/exports", async (orig) => ({
  ...(await orig<typeof import("@csd/exports")>()),
  buildExports: vi.fn(async (...args: unknown[]) => {
    calls.push(args);
    return { files: [], skipped: [], notes: [], stamp: { sha256: "0".repeat(64), createdAt: "2026-10-11T00:00:00Z" } } as unknown as ExportBundle;
  }),
}));
vi.mock("../src/exports/browser-canvas", () => ({
  createBrowserCanvasFactory: () => ({}),
  loadBrandFonts: async () => ({}),
}));

describe("Save step wiring", () => {
  it("hands buildExports the photo provider, which gives the PNG of the photo the card already loaded", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const fetchFn = vi.fn(async (url: string) => (url.startsWith(PROXY_ROUTES.vehicleImage)
      ? new Response(png as BodyInit, { headers: { "content-type": "image/png", [MEDIA_HEADERS.image]: "exact" } })
      : new Response(null, { status: 404 })));
    const services = createServices({ fixtures: false, fetch: fetchFn as unknown as typeof globalThis.fetch });
    const scene = tbone;
    const a = scene.vehicles[0] as SceneVehicle;
    // The card loads the photo first (objectUrl goes through probe; the export never spends a call of its own).
    await services.media.probe(services.media.vehicleImageUrl({ year: a.year, make: a.make, model: a.model, type: a.type })!);

    await services.exports.build({ scene, sim: {} as never, roads: null, formats: ["pdf"] } as never);
    expect(calls).toHaveLength(1);
    const media = calls[0]![2] as VehicleMediaProvider | undefined;
    expect(media).toBeDefined();
    expect(await media!.vehiclePhoto(a)).toEqual(png);
    // A vehicle whose photo the card never loaded: nothing, and no call.
    const before = fetchFn.mock.calls.length;
    expect(await media!.vehiclePhoto({ ...a, model: "Never Shown" })).toBeNull();
    expect(fetchFn.mock.calls.length).toBe(before);
  });
});
