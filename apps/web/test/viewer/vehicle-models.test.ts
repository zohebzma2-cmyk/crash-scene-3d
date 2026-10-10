import { afterAll, describe, expect, it } from "vitest";
import { PRESETS } from "@csd/core";
import { VEHICLE_KINDS, disposeVehicleModels, mergedModel, vehicleModel } from "../../src/viewer/vehicle-models";

afterAll(() => disposeVehicleModels());

const EPS = 1e-6;
/** Triangle budget per vehicle. */
const MAX_TRIANGLES = 1500;

describe("vehicle models stay inside their lengthM x widthM footprint", () => {
  for (const kind of VEHICLE_KINDS) {
    const L = PRESETS[kind].length.value, W = PRESETS[kind].width.value;
    it(`${kind}: wheels, mirrors, bumpers and lights fit in ${L} x ${W} m and fill most of it`, () => {
      const model = vehicleModel(kind, L, W);
      const all = mergedModel(model);
      all.computeBoundingBox();
      const box = all.boundingBox!;
      expect(box.max.x).toBeLessThanOrEqual(W / 2 + EPS);
      expect(box.min.x).toBeGreaterThanOrEqual(-W / 2 - EPS);
      expect(box.min.z).toBeGreaterThanOrEqual(-L / 2 - EPS);
      expect(box.max.z).toBeLessThanOrEqual(L / 2 + EPS);
      expect(box.min.y).toBeGreaterThanOrEqual(-EPS);               // wheels rest on the ground
      // Not a shrunken model: it reaches the footprint edges, so "touching" reads as touching.
      expect(box.max.x - box.min.x).toBeGreaterThan(W - 0.1);
      expect(box.max.z - box.min.z).toBeGreaterThan(L - 0.1);
      expect(model.heightM).toBeGreaterThan(0.9);
      all.dispose();
    });
    it(`${kind}: under the triangle budget and cached`, () => {
      const model = vehicleModel(kind, L, W);
      expect(model.triangles).toBeLessThan(MAX_TRIANGLES);
      expect(vehicleModel(kind, L, W)).toBe(model);
    });
  }

  it("holds for other sizes too (the sim's own length and width)", () => {
    for (const kind of VEHICLE_KINDS) {
      const L = PRESETS[kind].length.value * 1.1, W = PRESETS[kind].width.value * 0.93;
      const all = mergedModel(vehicleModel(kind, L, W));
      all.computeBoundingBox();
      const b = all.boundingBox!;
      expect(b.max.x).toBeLessThanOrEqual(W / 2 + EPS);
      expect(b.max.z).toBeLessThanOrEqual(L / 2 + EPS);
      expect(b.min.z).toBeGreaterThanOrEqual(-L / 2 - EPS);
      all.dispose();
    }
  });
});
