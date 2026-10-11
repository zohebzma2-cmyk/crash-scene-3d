// @vitest-environment jsdom
// Catalog models end to end in the unit world: the service (GLB, fallback, errors, watermark), parsing the synthetic
// fixture, the hook that swaps models in and frees them (dispose on change and unmount).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Box3, Vector3, type Mesh } from "three";
import type { Scene, SimulationResult } from "@csd/core";
import { MEDIA_HEADERS, PROXY_ROUTES } from "@csd/core";
import { createFixtureModelFetch, createVehicleModelsService, NO_MODEL_TTL_MS, type VehicleModelAsset } from "../../src/services/vehicle-models";
import { vehicleModelUrl } from "../../src/services/media";
import { parseGlb } from "../../src/viewer/glb-loader";
import { normalise, planTint } from "../../src/viewer/glb-model";
import { catalogWants, useCatalogModels, type ModelLoader } from "../../src/viewer/catalog-models";
import type { CatalogModel } from "../../src/viewer/vehicle-view";
import { fakeSimulate } from "../../src/services/fakes";
import { flush, mount } from "../helpers";
import { tbone } from "../fakes";

const BOX = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/models/synthetic-box-car.glb"));
const ab = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const glbResponse = (headers: Record<string, string> = {}) => new Response(ab(BOX), { status: 200, headers: { "content-type": "model/gltf-binary", ...headers } });
const Q = { year: 2021, make: "Synthetic", model: "Box car" };

afterEach(() => { vi.restoreAllMocks(); });

const fallback = (reason: string) => new Response(JSON.stringify({ fallback: true, reason }), { status: 200, headers: { "content-type": "application/json; charset=utf-8", [MEDIA_HEADERS.fallback]: reason } });

describe("the vehicle models service (PROXY_ROUTES.vehicleModel, roundB/images' route)", () => {
  it("asks the route with images' vehicleModelUrl, reads MEDIA_HEADERS.watermarked, and keeps the GLB for the session", async () => {
    const fetchFn = vi.fn(async (_url: string) => glbResponse({ [MEDIA_HEADERS.watermarked]: "true" }));
    const s = createVehicleModelsService(fetchFn);
    const r = await s.load(Q);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0]![0]).toBe(vehicleModelUrl(Q));
    const url = new URL(fetchFn.mock.calls[0]![0], "http://x");
    expect(url.pathname).toBe(PROXY_ROUTES.vehicleModel);
    expect(url.searchParams.get("year")).toBe("2021");
    expect(r?.watermarked).toBe(true);
    expect(r?.bytes.byteLength).toBe(BOX.byteLength);
    await s.load(Q);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    // "false" or no header: not watermarked.
    const s2 = createVehicleModelsService(async () => glbResponse({ [MEDIA_HEADERS.watermarked]: "false" }));
    expect((await s2.load(Q))?.watermarked).toBe(false);
  });

  it("leaves the year out when it isn't known (the route's year must be a number), and never asks about a motorcycle", async () => {
    const fetchFn = vi.fn(async (_url: string) => glbResponse());
    const s = createVehicleModelsService(fetchFn);
    await s.load({ year: null, make: "Synthetic", model: "Box car" });
    const url = new URL(fetchFn.mock.calls[0]![0], "http://x");
    expect(url.searchParams.has("year")).toBe(false);
    expect(await s.load({ year: 2020, make: "Honda", model: "Gold Wing", type: "motorcycle" })).toBeNull();
    expect(await s.load({ year: 2020, make: "Honda", model: " " })).toBeNull();
    expect(await s.load({ year: null, make: "", model: "Accord" })).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no-model", 1], ["no-make", 1], ["moto-not-in-plan", 1],
    ["quota", 2], ["busy", 2], ["upstream", 2], ["not-configured", 2],
  ] as const)("a {fallback: true, reason: %s} answer keeps our model; it is remembered only when the vehicle has no model", async (reason, calls) => {
    const fetchFn = vi.fn(async () => fallback(reason));
    let t = 0;
    const s = createVehicleModelsService(fetchFn, 1000, () => t);
    expect(await s.load(Q)).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(await s.load(Q)).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(calls);
    t += NO_MODEL_TTL_MS + 1;      // remembered for NO_MODEL_TTL_MS only
    await s.load(Q);
    expect(fetchFn).toHaveBeenCalledTimes(calls + 1);
  });

  it("the reason may come in the header only", async () => {
    const fetchFn = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json", [MEDIA_HEADERS.fallback]: "no-model" } }));
    const s = createVehicleModelsService(fetchFn);
    expect(await s.load(Q)).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    await s.load(Q);
    // A body without fallback:true isn't a fallback answer: not remembered.
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["the route errors (502)", () => new Response("no", { status: 502 })],
    ["the route is over its quota (429)", () => new Response("{}", { status: 429, headers: { "content-type": "application/json" } })],
    ["the body isn't a GLB", () => new Response("hello", { headers: { "content-type": "model/gltf-binary" } })],
    ["the network fails", () => { throw new TypeError("offline"); }],
  ])("%s: our model, and the next opening asks again", async (_label, answer) => {
    const fetchFn = vi.fn(async () => answer());
    const s = createVehicleModelsService(fetchFn);
    expect(await s.load(Q)).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(await s.load(Q)).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("an abort rejects with an AbortError", async () => {
    const s = createVehicleModelsService(async () => { await new Promise((r) => setTimeout(r, 20)); return glbResponse(); });
    const ctrl = new AbortController();
    const p = s.load(Q, ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("fixtures mode: the synthetic models answer the model route like the proxy (watermarked); everything else goes on to images' fixtures", async () => {
    const assets = vi.fn(async () => glbResponse());
    vi.stubGlobal("fetch", assets);
    const next = vi.fn(async (_u: string) => fallback("no-model"));
    const fx = createFixtureModelFetch({ "../../fixtures/models/synthetic-box-car.glb": async () => "/assets/box.glb" }, next);
    const s = createVehicleModelsService(fx);
    expect((await s.load({ year: null, make: "synthetic", model: "BOX CAR" }))?.watermarked).toBe(true);
    expect((assets.mock.calls[0] as unknown as [string])[0]).toBe("/assets/box.glb");
    expect(await s.load({ year: 2021, make: "Honda", model: "Accord" })).toBeNull();
    expect(next).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});

describe("the synthetic fixture GLB", () => {
  it("parses, fits the footprint exactly and tints its Body material", async () => {
    const root = await parseGlb(ab(BOX));
    const foot = { lengthM: 4.76, widthM: 1.81, heightM: 1.42 };
    const fit = normalise(root, foot);
    const size = new Box3().setFromObject(fit).getSize(new Vector3());
    expect(size.x).toBeCloseTo(foot.widthM, 4);
    expect(size.y).toBeCloseTo(foot.heightM, 4);
    expect(size.z).toBeCloseTo(foot.lengthM, 4);
    const plan = planTint(fit);
    expect(plan.kind === "material" && plan.how === "named" && plan.targets.map((m) => m.name)).toEqual(["Body"]);
  });
});

/* ---------- the hook ---------- */

function sceneWith(make: string, model: string): { scene: Scene; sim: SimulationResult } {
  const scene: Scene = structuredClone(tbone);
  scene.vehicles[0]!.make = make;
  scene.vehicles[0]!.model = model;
  scene.vehicles[1]!.make = "";
  const out = fakeSimulate(scene, null);
  if (!out.ok) throw new Error("fake sim");
  return { scene, sim: out.result };
}

function Probe({ scene, sim, load, out }: { scene: Scene; sim: SimulationResult; load: ModelLoader; out: { current: ReadonlyMap<string, CatalogModel> } }) {
  out.current = useCatalogModels(scene, sim, load);
  return null;
}

describe("useCatalogModels", () => {
  it("asks only for vehicles with a make and a model, keyed by the footprint they must fit", () => {
    const { scene, sim } = sceneWith("Synthetic", "Box car");
    const w = catalogWants(scene, sim);
    expect(w.map((x) => x.id)).toEqual(["A"]);
    expect(w[0]!.foot.lengthM).toBeCloseTo(sim.vehicles[0]!.lengthM - 0.04, 6);
  });

  it("swaps the model in when it loads, frees it when the vehicle changes and when the viewer goes", async () => {
    const asset: VehicleModelAsset = { bytes: ab(BOX), watermarked: false };
    const load = vi.fn<ModelLoader>(async (q) => (q.model === "Box car" ? asset : null));
    const out = { current: new Map() as ReadonlyMap<string, CatalogModel> };
    const first = sceneWith("Synthetic", "Box car");
    let m = mount(<Probe {...first} load={load} out={out} />);
    expect(out.current.size).toBe(0);              // our model first, never a blank
    await flush(50);
    const loaded = out.current.get("A");
    expect(loaded).toBeTruthy();
    const geos: Array<ReturnType<typeof vi.spyOn>> = [];
    loaded!.object.traverse((o) => { if ((o as Mesh).isMesh) geos.push(vi.spyOn((o as Mesh).geometry, "dispose")); });
    expect(geos.length).toBeGreaterThan(0);
    // The claimant edits the model: the old one is freed and our model shows again (this one has no catalog model).
    m.unmount();
    m = mount(<Probe {...sceneWith("Synthetic", "Other")} load={load} out={out} />);
    await flush(5);                                 // freed once the closing commit is done
    for (const g of geos) expect(g).toHaveBeenCalledTimes(1);
    await flush(20);
    expect(out.current.size).toBe(0);
    m.unmount();
  });

  it("a vehicle edited while the viewer stays open: the old model leaves the picture first, then is freed", async () => {
    const asset: VehicleModelAsset = { bytes: ab(BOX), watermarked: false };
    const load = vi.fn<ModelLoader>(async (q) => (q.model === "Box car" ? asset : null));
    const out = { current: new Map() as ReadonlyMap<string, CatalogModel> };
    const host = document.createElement("div");
    document.body.append(host);
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");
    const root = createRoot(host);
    act(() => root.render(<Probe {...sceneWith("Synthetic", "Box car")} load={load} out={out} />));
    await flush(50);
    const loaded = out.current.get("A")!;
    const spies: Array<ReturnType<typeof vi.spyOn>> = [];
    loaded.object.traverse((o) => { if ((o as Mesh).isMesh) spies.push(vi.spyOn((o as Mesh).geometry, "dispose")); });
    let disposedWhileShown = false;
    for (const sp of spies) sp.mockImplementation(() => { if (out.current.get("A") === loaded) disposedWhileShown = true; });
    act(() => root.render(<Probe {...sceneWith("Synthetic", "Other")} load={load} out={out} />));
    await flush(20);
    expect(out.current.get("A")).toBeUndefined();
    for (const sp of spies) expect(sp).toHaveBeenCalledTimes(1);
    expect(disposedWhileShown).toBe(false);
    act(() => root.unmount());
    host.remove();
  });

  it("frees a model that arrives after the vehicle changed (never drawn, never leaked)", async () => {
    let release: (a: VehicleModelAsset) => void = () => undefined;
    const load = vi.fn<ModelLoader>((_q, signal) => new Promise((resolve, reject) => { release = resolve; signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))); }));
    const out = { current: new Map() as ReadonlyMap<string, CatalogModel> };
    const m = mount(<Probe {...sceneWith("Synthetic", "Box car")} load={load} out={out} />);
    m.unmount();                                    // the viewer closes before the model arrives
    release({ bytes: ab(BOX), watermarked: false });
    await flush(30);
    expect(out.current.size).toBe(0);
    expect(load.mock.calls[0]![1]?.aborted).toBe(true);
  });
});
