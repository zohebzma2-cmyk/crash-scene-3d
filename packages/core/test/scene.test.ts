import { describe, expect, it } from "vitest";
import { MAX_SCENE_BYTES, parseScene, parseSceneFile, DISCLAIMER_LONG } from "../src";
import { sampleScene } from "./fixtures";

const bytes = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

describe("scene contract", () => {
  it("accepts a valid scene", () => {
    expect(parseScene(sampleScene()).ok).toBe(true);
  });

  it("explains a 300 mph speed in plain words, with the vehicle letter", () => {
    const s = sampleScene();
    s.vehicles[0]!.speed = { kind: "known", mph: 300 };
    const r = parseScene(s);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContain("Vehicle A: That's faster than we can illustrate. Enter 150 mph or less.");
  });

  it("explains missing and out-of-range coordinates", () => {
    const s = sampleScene() as unknown as { location: Record<string, unknown> };
    delete s.location.lat;
    s.location.lon = 500;
    const r = parseScene(s);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => /latitude/.test(e) && /missing/.test(e))).toBe(true);
      expect(r.errors).toContain("The longitude has to be between −180 and 180.");
    }
  });

  it("keeps a script tag in a label as plain text (rendering decides; parsing never executes)", () => {
    const s = sampleScene();
    s.location.label = "<script>alert(1)</script>";
    const r = parseScene(s);
    expect(r.ok && r.value.location.label).toBe("<script>alert(1)</script>");
  });

  it("rejects a file over the size limit before parsing", () => {
    const big = new Uint8Array(MAX_SCENE_BYTES + 1);
    const r = parseSceneFile(big);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/too big/);
  });

  it("rejects malformed JSON and other versions with readable errors", () => {
    const bad = parseSceneFile(new TextEncoder().encode("{not json"));
    expect(bad.ok === false && bad.errors[0]).toMatch(/isn't valid JSON/);
    const old = parseSceneFile(bytes({ ...sampleScene(), schemaVersion: 2, createdAt: "2026-10-09T19:42:07Z", disclaimer: DISCLAIMER_LONG }));
    expect(old.ok === false && old.errors.join(" ")).toMatch(/different version/);
  });

  it("requires at least one moving vehicle and A–D in order", () => {
    const s = sampleScene();
    s.vehicles.forEach((v) => { v.action = "parked"; });
    s.vehicles[1]!.id = "C";
    const r = parseScene(s);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toContain("At least one vehicle has to be moving.");
      expect(r.errors.some((e) => /lettered A, B, C, D in order/.test(e))).toBe(true);
    }
  });
});
