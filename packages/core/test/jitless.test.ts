import { describe, expect, it, vi } from "vitest";

describe("zod never probes for eval (strict CSP)", () => {
  it("builds and parses the scene schema without calling new Function(\"\")", async () => {
    vi.resetModules();
    const probes: unknown[][] = [];
    const Original = globalThis.Function;
    globalThis.Function = new Proxy(Original, {
      construct(target, args, newTarget) {
        if (args.length === 1 && args[0] === "") probes.push(args);
        return Reflect.construct(target, args, newTarget);
      },
    });
    try {
      const core = await import("../src");
      const zod = await import("zod");
      expect(zod.z.config().jitless).toBe(true);
      const { sampleScene } = await import("./fixtures");
      expect(core.parseScene(sampleScene()).ok).toBe(true);
      expect(core.parseScene({ schemaVersion: 3 }).ok).toBe(false);
    } finally {
      globalThis.Function = Original;
    }
    expect(probes).toEqual([]);
  });
});
