// The fixtures build serves the synthetic road sites from apps/web/fixtures/roads/<site>/osm.json. Those files are
// written from synthetic-osm.ts; this test keeps them in step. WRITE_ROAD_FIXTURES=1 npx vitest run
// packages/mapdata/test/synthetic-fixtures.test.ts rewrites them.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SITE_NAMES, siteNet, siteOsm } from "./synthetic-osm";

const dir = (site: string) => new URL(`../../../apps/web/fixtures/roads/${site}/`, import.meta.url);

describe("synthetic road sites", () => {
  for (const site of SITE_NAMES) {
    it(`${site}: the fixtures build's osm.json is the generator's output`, () => {
      const want = `${JSON.stringify(siteOsm(site))}\n`;
      if (process.env["WRITE_ROAD_FIXTURES"] === "1") {
        mkdirSync(dir(site), { recursive: true });
        writeFileSync(new URL("osm.json", dir(site)), want);
      }
      expect(readFileSync(new URL("osm.json", dir(site)), "utf8")).toBe(want);
    });
  }

  it("parse into the road shapes they stand for", () => {
    expect(siteNet("no-roads").ways).toHaveLength(0);
    expect(siteNet("curved").ways.map((w) => w.name)).toEqual(["Willow Bend Road"]);
    expect(siteNet("roundabout").ways.some((w) => w.oneway && w.name === null)).toBe(true);
    expect(siteNet("parking-lot").parking).toHaveLength(1);
    expect(siteNet("divided-highway").ways.filter((w) => w.oneway && w.lanesForward === 2)).toHaveLength(2);
  });
});
