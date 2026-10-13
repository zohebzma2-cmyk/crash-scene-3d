import { describe, expect, it } from "vitest";
import { clipPaintLine, taggedCrosswalkPaint } from "../src/feature-placement";
import type { RoadNetwork } from "../src/contracts";
const rect = (left: number, right: number) => [{ x: left, y: -1 }, { x: right, y: -1 }, { x: right, y: 1 }, { x: left, y: 1 }];
const line = [{ x: -5, y: 0 }, { x: 5, y: 0 }];
describe("crosswalk paint clipping", () => {
  it("clips overlapping road polygons to one span", () => {
    expect(clipPaintLine(line, [rect(-2, 1), rect(0, 3)])).toEqual([[{ x: -2, y: 0 }, { x: 3, y: 0 }]]);
  });
  it("keeps disconnected spans separate and rejects nonintersecting roads", () => {
    expect(clipPaintLine(line, [rect(-3, -1), rect(1, 3)])).toEqual([[{ x: -3, y: 0 }, { x: -1, y: 0 }], [{ x: 1, y: 0 }, { x: 3, y: 0 }]]);
    expect(clipPaintLine(line, [rect(8, 10)])).toEqual([]);
  });
  it("returns the same computed paint for each network, with an empty fast path", () => {
    const net: RoadNetwork = { frame: { origin: { lat: 0, lon: 0 } }, radiusM: 100, ways: [], buildings: [], parking: [], terrain: null, attribution: [], fetchedAt: "2026-10-11T00:00:00Z", features: [] };
    const a = taggedCrosswalkPaint(net);
    expect(taggedCrosswalkPaint(net)).toBe(a);
    expect(taggedCrosswalkPaint({ ...net })).not.toBe(a);
  });
});
