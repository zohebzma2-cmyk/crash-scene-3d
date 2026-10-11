import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CUSTOM_PAINT_NAME, FACTORY_COLORS, canonicalJson, contrastRatio, customPaint, factoryColor, hexToRgb01, inkOn, paintLabel, paintMap, paintOf,
  parseScene, pickedChipText, sha256Hex, vehicleColor,
} from "../src";
import { sampleScene } from "./fixtures";

const TOKEN: Record<string, string> = { A: "token-a", B: "token-b", C: "token-c", D: "token-d" };
const token = (id: string) => TOKEN[id]!;

describe("vehicle colour in the scene schema", () => {
  it("accepts a factory colour and a custom one", () => {
    const s = sampleScene();
    s.vehicles[0]!.color = { name: "Red", hex: "#b3151b" };
    s.vehicles[1]!.color = { name: CUSTOM_PAINT_NAME, hex: "#ABCDEF" };
    const r = parseScene(s);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.vehicles[0]!.color).toEqual({ name: "Red", hex: "#b3151b" });
      expect(r.value.vehicles[1]!.color?.hex).toBe("#abcdef");   // normalised to lower case as it is read
    }
  });

  it("accepts null (Not sure) and a missing colour (older v3 files)", () => {
    const s = sampleScene() as unknown as { vehicles: Array<Record<string, unknown>> };
    s.vehicles[0]!.color = null;
    const n = parseScene(s);
    expect(n.ok).toBe(true);
    if (n.ok) expect(n.value.vehicles[0]!.color).toBeUndefined();
    const old = sampleScene();
    expect("color" in old.vehicles[0]!).toBe(false);
    const r = parseScene(old);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.vehicles[0]!.color).toBeUndefined();
  });

  it.each(["red", "#fff", "#12345", "#1234567", "#gg0000", "rgb(1,2,3)", ""])("rejects a bad hex %j with a plain sentence", (hex) => {
    const s = sampleScene() as unknown as { vehicles: Array<Record<string, unknown>> };
    s.vehicles[1]!.color = { name: "Red", hex };
    const r = parseScene(s);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContain("Vehicle B: The colour should look like #b3151b.");
  });

  it("rejects an empty or overlong name and a colour that isn't an object", () => {
    for (const color of [{ name: "", hex: "#000000" }, { name: "x".repeat(41), hex: "#000000" }, "red", 3]) {
      const s = sampleScene() as unknown as { vehicles: Array<Record<string, unknown>> };
      s.vehicles[0]!.color = color;
      expect(parseScene(s).ok).toBe(false);
    }
  });

  it("every example scene still loads, without a colour, and keeps its canonical JSON", async () => {
    for (const name of ["t-bone-intersection", "highway-rear-end", "parking-lot-backing"]) {
      const raw = JSON.parse(readFileSync(new URL(`../../../examples/${name}/scene.json`, import.meta.url), "utf8")) as unknown;
      const r = parseScene(raw);
      expect(r.ok, name).toBe(true);
      if (!r.ok) continue;
      expect(r.value.vehicles.every((v) => v.color === undefined)).toBe(true);
      // Parsing adds no colour key, so the canonical JSON (the fingerprint's input) is what it was before round B.
      expect(canonicalJson(r.value)).not.toContain("\"color\"");
    }
  });

  it("normalises as it reads: the same paint gives the same canonical bytes (hex case, name spaces); null is the same as absent", async () => {
    const bytes = async (color: unknown) => {
      const s = sampleScene() as unknown as { vehicles: Array<Record<string, unknown>> };
      if (color !== "absent") s.vehicles[0]!.color = color;
      const r = parseScene(s);
      if (!r.ok) throw new Error(r.errors.join("; "));
      return sha256Hex(canonicalJson(r.value));
    };
    expect(await bytes({ name: "Red", hex: "#B3151B" })).toBe(await bytes({ name: " Red ", hex: "#b3151b" }));
    expect(await bytes(null)).toBe(await bytes("absent"));
    expect(await bytes(null)).not.toBe(await bytes({ name: "Red", hex: "#b3151b" }));
    const s = sampleScene() as unknown as { vehicles: Array<Record<string, unknown>> };
    s.vehicles[0]!.color = { name: "   ", hex: "#b3151b" };
    expect(parseScene(s).ok).toBe(false);   // a name of spaces is no name
  });

  it("the canonical JSON (and so the fingerprint) includes a picked colour", async () => {
    const s = sampleScene();
    const before = await sha256Hex(canonicalJson(s));
    s.vehicles[0]!.color = { name: "Red", hex: "#b3151b" };
    const json = canonicalJson(s);
    expect(json).toContain("\"color\":{\"hex\":\"#b3151b\",\"name\":\"Red\"}");
    expect(await sha256Hex(json)).not.toBe(before);
  });
});

describe("vehicleColor(), the one helper every renderer asks", () => {
  it("returns the picked hex (lower case) or the vehicle's token colour", () => {
    expect(vehicleColor({ id: "A" }, token)).toBe("token-a");
    expect(vehicleColor({ id: "B", color: null }, token)).toBe("token-b");
    expect(vehicleColor({ id: "C", color: { name: "Red", hex: "#B3151B" } }, token)).toBe("#b3151b");
    expect(vehicleColor({ id: "D", color: { name: "Bad", hex: "red" } }, token)).toBe("token-d");
  });

  it("paintOf, paintMap and the chip copy", () => {
    const vs = [{ id: "A", color: { name: "Red", hex: "#B3151B" } }, { id: "B" }, { id: "C", color: { name: CUSTOM_PAINT_NAME, hex: "#123456" } }];
    expect(paintOf(vs[1]!)).toBeNull();
    expect(paintMap(vs)).toEqual({ A: "#b3151b", C: "#123456" });
    expect(pickedChipText(vs[0]!.color!)).toBe("Picked: Red");
    expect(paintLabel(vs[2]!.color!)).toBe("Custom colour");
  });

  it("the palette: twelve named factory colours, unique, valid; custom and lookup helpers", () => {
    expect(FACTORY_COLORS.map((c) => c.name)).toEqual(["White", "Black", "Silver", "Gray", "Red", "Blue", "Dark blue", "Green", "Beige", "Brown", "Orange", "Yellow"]);
    expect(new Set(FACTORY_COLORS.map((c) => c.hex)).size).toBe(12);
    for (const c of FACTORY_COLORS) {
      const s = sampleScene();
      s.vehicles[0]!.color = c;
      expect(parseScene(s).ok, c.name).toBe(true);
    }
    expect(factoryColor("dark BLUE")?.hex).toBe(FACTORY_COLORS[6]!.hex);
    expect(customPaint("#ABCDEF")).toEqual({ name: CUSTOM_PAINT_NAME, hex: "#abcdef" });
    expect(customPaint("#abc")).toBeNull();
  });
});

describe("ink on paint: badge text, glyphs and lines drawn ON a paint pick light or dark automatically", () => {
  // The inks the app uses: --color-surface and --color-text, light mode (the exports are light) and dark mode.
  const LIGHT = { surface: "#FFFFFF", text: "#0F172A" };
  const DARK = { surface: "#0F172A", text: "#F8FAFC" };

  it.each([["near-white", "#fdfdfc"], ["near-black", "#050506"], ["pure white", "#ffffff"], ["pure black", "#000000"]])("%s paint gets an ink with at least 4.5:1 in both themes", (_label, paint) => {
    for (const m of [LIGHT, DARK]) {
      const r = inkOn(paint, m.surface, m.text);
      expect(r.ratio).toBeGreaterThanOrEqual(4.5);
      expect(r.ratio).toBeCloseTo(contrastRatio(hexToRgb01(paint), hexToRgb01(r.ink)), 6);
    }
    // Near-white takes the dark ink, near-black the light ink.
    expect(inkOn("#fdfdfc", LIGHT.surface, LIGHT.text).which).toBe("dark");
    expect(inkOn("#050506", LIGHT.surface, LIGHT.text).which).toBe("light");
  });

  it("every factory colour gets an ink with at least 4.5:1", () => {
    for (const c of FACTORY_COLORS) for (const m of [LIGHT, DARK]) expect(inkOn(c.hex, m.surface, m.text).ratio, c.name).toBeGreaterThanOrEqual(4.5);
  });

  it("any custom paint gets an ink with at least 4:1 (3:1 is the bar for glyphs and lines; letters sit on token badges)", () => {
    let worst = 21;
    for (let r = 0; r < 256; r += 15) for (let g = 0; g < 256; g += 15) for (let b = 0; b < 256; b += 15) {
      const hex = `#${[r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
      worst = Math.min(worst, inkOn(hex, LIGHT.surface, LIGHT.text).ratio);
    }
    expect(worst).toBeGreaterThanOrEqual(4);
  });
});
