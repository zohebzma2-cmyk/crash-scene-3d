// @vitest-environment jsdom
// Catalog models end to end in the unit world: the service (GLB, fallback, errors, watermark), parsing the synthetic
// fixture, the hook that swaps models in and frees them (dispose on change and unmount).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Box3, Vector3, type Mesh } from "three";
import type { Scene, SimulationResult } from "@csd/core";
import { createFixtureVehicleModels, createVehicleModelsService, MODEL_ROUTE, type VehicleModelAsset } from "../../src/services/vehicle-models";
import { parseGlb } from "../../src/viewer/glb-loader";
import { normalise, planTint } from "../../src/viewer/glb-model";
import { catalogWants, useCatalogModels, type ModelLoader } from "../../src/viewer/catalog-models";
import type { CatalogModel } from "../../src/viewer/vehicle-view";
import { fakeSimulate } from "../../src/services/fakes";
import { flush, mount } from "../helpers";
import { tbone } from "../fakes";

const BOX = readFileSync(join(process.cwd(), "apps/web/fixtures/models/synthetic-box-car.glb"));
const ab = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const glbResponse = (headers: Record<string, string> = {}) => new Response(ab(BOX), { status: 200, headers: { "content-type": "model/gltf-binary", ...headers } });
const Q = { year: 2021, make: "Synthetic", model: "Box car" };

afterEach(() => { vi.restoreAllMocks(); });

describe("the vehicle models service (/api/vehicles/model)", () => {
  it("asks our own route with the year, make and model only, and returns the GLB with its watermark flag", async () => {
    const fetchFn = vi.fn(async (_url: string) => glbResponse({ watermarked: "1" }));
    const s = createVehicleModelsService(fetchFn);
    const r = await s.load(Q);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const url = new URL(fetchFn.mock.calls[0]![0], "http://x");
    expect(url.pathname).toBe(MODEL_ROUTE);
    expect([...url.searchParams.keys()].sort()).toEqual(["make", "model", "year"]);
    expect(url.searchParams.get("make")).toBe("Synthetic");
    expect(r?.watermarked).toBe(true);
    expect(r?.bytes.byteLength).toBe(BOX.byteLength);
    // Cached for the session: a second viewer opening doesn't fetch again.
    await s.load(Q);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["the route says fallback", () => new Response(JSON.stringify({ fallback: true }), { headers: { "content-type": "application/json" } })],
    ["the route errors", () => new Response("no", { status: 502 })],
    ["the body isn't a GLB", () => new Response("hello", { headers: { "content-type": "model/gltf-binary" } })],
    ["the network fails", () => { throw new TypeError("offline"); }],
  ])("falls back to our model (null) when %s, and asks again next time", async (_label, answer) => {
    const fetchFn = vi.fn(async () => answer());
    const s = createVehicleModelsService(fetchFn);
    expect(await s.load(Q)).toBeNull();
    expect(await s.load(Q)).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("never asks without a make and a model", async () => {
    const fetchFn = vi.fn(async () => glbResponse());
    const s = createVehicleModelsService(fetchFn);
    expect(await s.load({ year: 2020, make: "Honda", model: " " })).toBeNull();
    expect(await s.load({ year: null, make: "", model: "Accord" })).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("an abort rejects with an AbortError", async () => {
    const s = createVehicleModelsService(async () => { await new Promise((r) => setTimeout(r, 20)); return glbResponse(); });
    const ctrl = new AbortController();
    const p = s.load(Q, ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("fixtures mode serves the synthetic models only, never /api", async () => {
    const fetchFn = vi.fn(async (url: string) => (url === "/assets/box.glb" ? glbResponse() : new Response("", { status: 404 })));
    const s = createFixtureVehicleModels({ "../../fixtures/models/synthetic-box-car.glb": async () => "/assets/box.glb" }, fetchFn);
    expect((await s.load({ year: null, make: "synthetic", model: "BOX CAR" }))?.watermarked).toBe(true);
    expect(await s.load({ year: 2021, make: "Honda", model: "Accord" })).toBeNull();
    expect(fetchFn.mock.calls.every(([u]) => !String(u).startsWith("/api/"))).toBe(true);
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
    for (const g of geos) expect(g).toHaveBeenCalledTimes(1);
    await flush(20);
    expect(out.current.size).toBe(0);
    m.unmount();
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
