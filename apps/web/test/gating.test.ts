import { describe, expect, it, vi } from "vitest";
import { createExamplesService } from "../src/services/examples";
import { createServices } from "../src/services";
import { fixturesAllowed, fixturesRequested } from "../src/services/fixtures";

describe("fixtures are gated", () => {
  const prod = { DEV: false };
  const dev = { DEV: true };
  const fixturesBuild = { DEV: false, VITE_FIXTURES: "1" };

  it("a production build does not honor ?fixtures=1, or ?example= as a reason to use fixtures", () => {
    expect(fixturesAllowed(prod)).toBe(false);
    expect(fixturesRequested("?fixtures=1", prod)).toBe(false);
    expect(fixturesRequested("?example=t-bone-intersection", prod)).toBe(false);
    expect(fixturesRequested("?fixtures=1&example=x", { DEV: false, VITE_FIXTURES: "0" })).toBe(false);
    expect(fixturesRequested("", prod)).toBe(false);
  });

  it("a dev server honors ?fixtures=1 and ?example=", () => {
    expect(fixturesRequested("?fixtures=1", dev)).toBe(true);
    expect(fixturesRequested("?example=t-bone-intersection", dev)).toBe(true);
    expect(fixturesRequested("", dev)).toBe(false);
  });

  it("a VITE_FIXTURES=1 build is always in fixtures mode", () => {
    expect(fixturesAllowed(fixturesBuild)).toBe(true);
    expect(fixturesRequested("", fixturesBuild)).toBe(true);
  });

  it("createServices refuses fixtures where they aren't allowed, even if asked", async () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_FIXTURES", "");
    try {
      const s = createServices({ fixtures: true, fetch: vi.fn() });
      expect(s.mode).toBe("live");
    } finally {
      vi.unstubAllEnvs();
    }
    expect(createServices({ fixtures: true }).mode).toBe("fixtures");   // vitest runs in dev mode
    expect(createServices({ fixtures: false }).mode).toBe("live");
  });
});

describe("examples", () => {
  it("lists every example scene and loads one scene file on demand", async () => {
    const svc = createExamplesService();
    expect(svc.names()).toEqual([
      "chicago-state-madison", "highway-rear-end", "la-hollywood-highland", "nyc-5th-42nd",
      "parking-lot-backing", "sf-haight-ashbury", "t-bone-intersection",
    ]);
    const scene = await svc.load("t-bone-intersection");
    expect(scene?.claim.number).toBe("CLM-EX-1001");
    expect(await svc.load("nope")).toBeNull();
    expect(await svc.load("../../secret")).toBeNull();
  });

  it("works with the real services too: ?example= needs no fixtures mode", async () => {
    const live = createServices({ fixtures: false });
    expect(live.mode).toBe("live");
    expect((await live.examples.load("highway-rear-end"))?.location.place).toBe("road");
  });
});
