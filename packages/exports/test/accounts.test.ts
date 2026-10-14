import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { accountItems, CONTROL, LIGHTING, PLACE_WORDS, ROAD_WORDS, WEATHER, YES_NO, VISIBILITY, simulate, type Scene } from "@csd/core";
import { parseOverpass } from "@csd/mapdata";
import { sceneSummary } from "../../../apps/web/src/lib/text";
import { buildModel } from "../src/model";
import { buildPdf } from "../src/pdf";
import { sceneFile } from "../src/scene-file";
import { brandFonts, readPdf, syntheticPng } from "./helpers";
import { twoVehicle, fourVehicle } from "./sim-fixtures";

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const cases: Array<[string, (s: Scene) => void]> = [
  ...LIGHTING.map((value): [string, (s: Scene) => void] => [`lighting ${value}`, (s) => { s.conditions = { lighting: value }; }]),
  ...WEATHER.map((value): [string, (s: Scene) => void] => [`weather ${value}`, (s) => { s.conditions = { weather: value }; }]),
  ["visibility", (s) => { s.conditions = { visibility: ["sun-glare", "parked-cars", "hedges"] }; }],
  ...VISIBILITY.map((value): [string, (s: Scene) => void] => [`visibility ${value}`, (s) => { s.conditions = { visibility: [value] }; }]),
  ...CONTROL.map((value): [string, (s: Scene) => void] => [`control ${value}`, (s) => { s.vehicles[0]!.account = { control: value }; }]),
  ...(["signaled", "braking", "swerving", "airbags", "towed"] as const).flatMap((key) => YES_NO.map((value): [string, (s: Scene) => void] => [`${key} ${value}`, (s) => { s.vehicles[0]!.account = { [key]: value }; }])),
  ["lane", (s) => { s.vehicles[0]!.travel.lane = 2; s.vehicles[0]!.account = { lane: "entered" }; }],
  ["lane not sure", (s) => { s.vehicles[0]!.account = { lane: "not-sure" }; }],
];
describe("a road condition the claimant didn't give", () => {
  it("is said to be not given in the summary, the PDF and the scene file, never shown as the placeholder", async () => {
    const scene: Scene = { ...twoVehicle().scene, road: { condition: "dry", conditionNotGiven: true } };
    const out = simulate(scene, null);
    if (!out.ok) throw new Error(out.errors.map((e) => e.text).join("; "));
    const sim = out.result;
    const { text: file, stamp } = await sceneFile(scene, sim, "2026-10-10T00:00:00Z");
    const model = buildModel(scene, sim, stamp);
    expect(model.road).toBe(`${PLACE_WORDS[scene.location.place]} · road surface not given`);
    expect(sceneSummary(scene, sim, "us")).toContain("The road surface was not given.");
    expect(sceneSummary(scene, sim, "us")).not.toMatch(/The road was/);
    const pdf = await buildPdf({ model, scene, sim, roads: null, fonts: brandFonts(), createdAt: stamp.createdAt, sceneFileName: "synthetic.json" });
    const text = norm((await readPdf(pdf.bytes)).text);
    expect(text).toContain("road surface not given");
    expect(text).toContain("Road surface not given: the picture uses dry-road friction");
    expect(text).not.toMatch(/Road dry, as entered/);
    // The file keeps it, so reopening it says the same.
    expect(JSON.parse(file).road).toEqual({ condition: "dry", conditionNotGiven: true, friction: sim.frictionCoefficient });
  });

  it("an entered condition (and every older scene) still reads as entered", () => {
    const { scene, sim } = twoVehicle();
    expect(scene.road.conditionNotGiven).toBeUndefined();
    expect(sceneSummary(scene, sim, "us")).toContain(`The road was ${ROAD_WORDS[scene.road.condition]}.`);
  });
});

describe("every optional answer in summary and actual PDF", () => {
  it("does not call the default no-braking physics assumption a claimant answer", async () => {
    const { scene, sim } = twoVehicle();
    for (const v of scene.vehicles) { v.braking = false; delete v.account; }
    const { stamp } = await sceneFile(scene, sim, "2026-10-10T00:00:00Z");
    const model = buildModel(scene, sim, stamp);
    const pdf = await buildPdf({ model, scene, sim, roads: null, fonts: brandFonts(), createdAt: stamp.createdAt, sceneFileName: "synthetic.json" });
    expect(sceneSummary(scene, sim, "us")).not.toContain("Claimant said");
    expect(norm((await readPdf(pdf.bytes)).text)).not.toContain("Claimant said");
  });
  for (const [name, set] of cases) it(name, async () => {
    const { scene, sim } = twoVehicle(); set(scene);
    const { stamp } = await sceneFile(scene, sim, "2026-10-10T00:00:00Z");
    const model = buildModel(scene, sim, stamp);
    const pdf = await buildPdf({ model, scene, sim, roads: null, fonts: brandFonts(), createdAt: stamp.createdAt, sceneFileName: "synthetic.json" });
    const text = norm((await readPdf(pdf.bytes)).text);
    const summary = sceneSummary(scene, sim, "us");
    for (const item of accountItems(scene)) {
      expect(summary).toContain(item.text);
      expect(text).toContain(norm(item.text));
      expect(item.text).toMatch(/^Claimant said/);
    }
    for (const p of pdf.report) { expect(p.bodyBottom).toBeLessThan(p.footerTop); expect(p.minTextPt).toBeGreaterThanOrEqual(8); }
  });
  it("keeps all four vehicles' answers when the PDF needs extra pages", async () => {
    const { scene, sim } = fourVehicle();
    scene.conditions = { lighting: "dark-lit", weather: "fog", visibility: ["sun-glare", "hedges", "parked-cars"] };
    for (const v of scene.vehicles) { v.account = { control: "red", signaled: "yes", braking: "no", swerving: "yes", airbags: "yes", towed: "yes" }; v.travel.lane = 0; }
    const { stamp } = await sceneFile(scene, sim, "2026-10-10T00:00:00Z");
    const pdf = await buildPdf({ model: buildModel(scene, sim, stamp), scene, sim, roads: null, fonts: brandFonts(), createdAt: stamp.createdAt, sceneFileName: "synthetic.json" });
    const text = norm((await readPdf(pdf.bytes)).text);
    for (const item of accountItems(scene)) expect(text).toContain(norm(item.text));
    for (const p of pdf.report) expect(p.bodyBottom).toBeLessThan(p.footerTop);
  });
  it("combines photos, road legends and four vehicles of answers without repeated continuation copy", async () => {
    const { scene, sim } = fourVehicle();
    const raw = JSON.parse(readFileSync(new URL("../../../examples/t-bone-intersection/osm.json", import.meta.url), "utf8"));
    const roads = parseOverpass(raw, { origin: raw.center }, raw.radiusM, raw.fetchedAt);
    scene.conditions = { lighting: "dark-lit", weather: "snow", visibility: ["sun-glare", "parked-cars", "hedges"] };
    for (const v of scene.vehicles) {
      v.account = { control: "flashing", lane: "entered", signaled: "yes", braking: "no", swerving: "not-sure", airbags: "yes", towed: "yes" };
      v.travel.lane = 0;
    }
    const { stamp } = await sceneFile(scene, sim, "2026-10-10T00:00:00Z");
    const pdf = await buildPdf({ model: buildModel(scene, sim, stamp), scene, sim, roads, fonts: brandFonts(), createdAt: stamp.createdAt, sceneFileName: "synthetic.json", mapThumbnail: syntheticPng(800, 600, "map"), vehiclePhotos: new Map(scene.vehicles.map((v) => [v.id, syntheticPng(600, 400, `synthetic ${v.id}`)])) });
    const read = await readPdf(pdf.bytes), text = norm(read.text);
    for (const item of accountItems(scene)) expect(text).toContain(norm(item.text));
    expect(text).toContain("Stock photo");
    expect(text).not.toMatch(/what the claimant said, what the claimant said/i);
    expect(pdf.report.flatMap((p) => p.images)).toHaveLength(5);
    for (const p of pdf.report) { expect(p.bodyBottom).toBeLessThan(p.footerTop); expect(p.minTextPt).toBeGreaterThanOrEqual(8); }
  });
});
