// "Break it on purpose" against the exports: hostile text in every label field must come out as
// glyphs and plain text, never as PDF structure, HTML or a file path.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DISCLAIMER_LONG, canonicalJson, parseSceneFile, sha256Hex } from "@csd/core";
import type { ExportBundle, ExportRequest, Scene, SimulationResult } from "@csd/core";
import { buildExports, sceneFile } from "../src";
import { fileClaim, printable } from "../src/model";
import { decodePng } from "../src/png-decode";
import { brandFonts, latin1, readPdf, syntheticPng, testCanvas } from "./helpers";
import { twoVehicle } from "./sim-fixtures";

const NOW = new Date("2026-10-09T20:52:18.456Z");
const CREATED = "2026-10-09T20:52:18Z";
const BIDI_OR_CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\u061C\uFEFF]/;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
/** Names a PDF viewer would act on. None may appear anywhere in our PDFs. */
const ACTIVE_PDF_KEYS = ["/JS", "/JavaScript", "/OpenAction", "/AA", "/Launch", "/URI", "/GoToR", "/SubmitForm", "/ImportData", "/EmbeddedFile", "/RichMedia", "/AcroForm", "/XFA"];

const HOSTILE: Array<[string, string]> = [
  ["script tag", "<script>alert(1)</script>"],
  ["broken-out attribute", '"><img src=x onerror=alert(1)>'],
  ["javascript: URL", "javascript:alert(1)"],
  ["bidi override and isolates", "a\u202Eb\u2066c\u2069 d\u200Ee\u200Ff\u061Cg"],
  ["zero-width characters", "z\u200Bw\u200Cx\u200Dy\u2060v\uFEFFq"],
  ["PDF syntax", "/JS /JavaScript /OpenAction /AA (x) \\) <</S/JavaScript/JS(app.alert(1))>>"],
  ["control characters", "tab\there\u0000nul\u001bx\u007fdel"],
];

function hostileScene(text: string): { scene: Scene; sim: SimulationResult } {
  const { scene, sim } = twoVehicle();
  const s = structuredClone(scene);
  s.claim.number = text.slice(0, 40);
  s.claim.vehicle.make = text.slice(0, 60);
  s.claim.vehicle.model = text.slice(0, 80);
  s.location.label = text;
  s.location.nearLabel = text;
  s.vehicles[0]!.travel.roadName = text;
  s.vehicles[0]!.make = text.slice(0, 60);
  s.vehicles[0]!.model = text.slice(0, 80);
  s.vehicles[1]!.travel.roadName = text;
  s.vehicles[1]!.make = text.slice(0, 60);
  s.vehicles[1]!.model = text.slice(0, 80);
  return { scene: s, sim };
}

function request(scene: Scene, sim: SimulationResult, formats: ExportRequest["formats"], extra: Partial<ExportRequest> = {}): ExportRequest {
  return {
    scene, sim, roads: null, formats, fonts: brandFonts(), now: () => NOW,
    stills: { impact: syntheticPng(960, 492, "impact"), rest: syntheticPng(960, 492, "rest") },
    mapThumbnail: syntheticPng(800, 600, "synthetic map"),
    ...extra,
  };
}
const fileEnding = (b: ExportBundle, suffix: string) => {
  const f = b.files.find((x) => x.name.endsWith(suffix));
  if (!f) throw new Error(`no file ending ${suffix}: ${b.files.map((x) => x.name).join(", ")}`);
  return f;
};

describe("5. hostile text in labels (exports)", () => {
  for (const [what, text] of HOSTILE) {
    describe(what, () => {
      it("the PDF is valid, carries the text as glyphs and has no script, action or form entries", async () => {
        const { scene, sim } = hostileScene(text);
        const tc = testCanvas();
        const bundle = await buildExports(request(scene, sim, ["pdf", "json"]), tc.factory);
        expect(bundle.skipped).toEqual([]);
        const pdf = fileEnding(bundle, ".pdf").bytes;

        // A real PDF: header, trailer, and pdf.js (a separate implementation) reads it back.
        expect(latin1(pdf.subarray(0, 8))).toMatch(/^%PDF-1\.\d/);
        expect(latin1(pdf.subarray(pdf.length - 16))).toContain("%%EOF");
        const read = await readPdf(pdf);
        expect(read.pages).toBeGreaterThanOrEqual(1);

        // The words are on the page, as printable text.
        const shown = printable(scene.location.label);
        expect(shown.length).toBeGreaterThan(0);
        expect(read.text).toContain(shown.slice(0, 40));
        expect(read.text).not.toMatch(BIDI_OR_CONTROL);

        // The bytes hold no active content. Text lives in glyph-encoded content streams, so even
        // PDF syntax typed by the claimant is not found as syntax in the file.
        const raw = latin1(pdf);
        for (const key of ACTIVE_PDF_KEYS) expect(raw.includes(key), `${key} in the PDF bytes`).toBe(false);
        // The only annotation list is pdf-lib's empty one.
        for (const m of raw.matchAll(/\/Annots\s*(\[[^\]]*\])/g)) expect(m[1]).toMatch(/^\[\s*\]$/);
        // The document info is ours alone, never the claimant's text.
        for (const key of ["/Title", "/Author", "/Subject", "/Keywords", "/Creator", "/Producer"]) {
          const m = new RegExp(`${key}\\s*\\(([^)]*)\\)`).exec(raw);
          if (m) expect(m[1], key).not.toContain(text.slice(0, 6));
        }
      }, 60_000);

      it("the scene file keeps the exact text, escaped as JSON, and reads back", async () => {
        const { scene, sim } = hostileScene(text);
        const { text: file, stamp } = await sceneFile(scene, sim, CREATED);
        expect(file).toBe(canonicalJson(JSON.parse(file)));
        expect(stamp.fingerprintHex).toBe(createHash("sha256").update(new TextEncoder().encode(file)).digest("hex"));
        const back = parseSceneFile(new TextEncoder().encode(file));
        expect(back.ok).toBe(true);
        if (back.ok) {
          expect(back.value.location.label).toBe(text);
          expect(back.value.location.nearLabel).toBe(text);
          expect(back.value.vehicles[0]!.travel.roadName).toBe(text);
        }
        // Valid on its own as JSON text: no raw control character survives in the file.
        expect(file).not.toMatch(/[\u0000-\u001f]/);
      });

      it("the diagram is drawn as text on a canvas, never markup, and decodes as a PNG", async () => {
        const { scene, sim } = hostileScene(text);
        const tc = testCanvas();
        const bundle = await buildExports(request(scene, sim, ["png-diagram", "png-impact", "png-rest"]), tc.factory);
        expect(bundle.skipped).toEqual([]);
        for (const f of bundle.files.filter((x) => x.name.endsWith(".png"))) {
          expect(Array.from(f.bytes.subarray(0, 8))).toEqual(PNG_SIGNATURE);
          const img = await decodePng(f.bytes);
          expect(img.width).toBeGreaterThan(100);
        }
        const drawn = tc.drawn.map((d) => d.text);
        // The place line is drawn as a string with the printable version of the text in it.
        const shown = printable(scene.location.label);
        expect(drawn.some((t) => t.includes(shown.slice(0, 30)))).toBe(true);
        // Nothing drawn can reorder or hide other text.
        for (const t of drawn) expect(t).not.toMatch(BIDI_OR_CONTROL);
      }, 60_000);

      it("every file name is safe", async () => {
        const { scene, sim } = hostileScene(text);
        const tc = testCanvas();
        const bundle = await buildExports(request(scene, sim, ["pdf", "json", "png-diagram", "png-impact", "png-rest"]), tc.factory);
        expect(bundle.files).toHaveLength(5);
        for (const f of bundle.files) expectSafeFileName(f.name);
        // one claim, one base name
        const bases = new Set(bundle.files.map((f) => f.name.replace(/(-diagram|-impact|-final-rest)?\.(json|pdf|png)$/, "")));
        expect(bases.size).toBe(1);
      }, 60_000);
    });
  }

  it("all hostile strings at once, with the exact names a claimant would get", async () => {
    const { scene, sim } = hostileScene("<script>alert(1)</script>");
    scene.claim.number = "../../<script>x";
    const tc = testCanvas();
    const bundle = await buildExports(request(scene, sim, ["pdf", "json"]), tc.factory);
    expect(bundle.files.map((f) => f.name).sort()).toEqual(["crash-scene-script-x.json", "crash-scene-script-x.pdf"]);
  }, 60_000);
});

function expectSafeFileName(name: string) {
  expect(name, name).toMatch(/^crash-scene-[A-Za-z0-9._-]+\.(json|pdf|png)$/);
  expect(name).not.toContain("..");
  expect(name).not.toMatch(/[/\\<>:"|?*\u0000-\u001f\u007f-\u009f\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF&'`%#;]/);
  expect(name.length).toBeLessThanOrEqual(80);
  expect(name.startsWith(".")).toBe(false);
  expect(name.endsWith(".")).toBe(false);
}

describe("5. file names from the claim number", () => {
  const cases: Array<[string, string]> = [
    ["../../etc/passwd", "etc-passwd"],
    ["..\\..\\windows\\system32", "windows-system32"],
    ["a/b\\c", "a-b-c"],
    ["..", "scene"],
    [".", "scene"],
    ["...", "scene"],
    ["a..b", "a.b"],
    ["a....b....c", "a.b.c"],
    ["..a..", "a"],
    [".hidden", "hidden"],
    ["trailing.", "trailing"],
    ["<script>alert(1)</script>", "script-alert-1-script"],
    ['"><img src=x onerror=alert(1)>', "img-src-x-onerror-alert-1"],
    ["javascript:alert(1)", "javascript-alert-1"],
    ["<>:\"|?*", "scene"],
    ["a&b'c`d%e#f;g", "a-b-c-d-e-f-g"],
    ["\u0000\u001f\u007f", "scene"],
    ["ab\ncd\r\nef\tgh", "ab-cd-ef-gh"],
    ["\u202Egpj.exe", "gpj.exe"],
    ["z\u200Bw\u200Dx", "zwx"],
    ["  ", "scene"],
    ["", "scene"],
    ["日本語", "scene"],
    ["résumé", "r-sum"],
    ["CLM-EX-1001", "CLM-EX-1001"],
    ["x".repeat(300), "x".repeat(60)],
    // the 60-character cut must not leave a trailing "." or "-" (that would make "..json" or "-.json")
    ["a".repeat(59) + ".b", "a".repeat(59)],
    ["a".repeat(59) + "-b", "a".repeat(59)],
    ["a".repeat(58) + "-.b", "a".repeat(58)],
    ["a".repeat(59) + "\u2248b", "a".repeat(59)],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input).slice(0, 36)} -> ${JSON.stringify(expected).slice(0, 40)}`, () => {
      expect(fileClaim(input)).toBe(expected);
      expectSafeFileName(`crash-scene-${fileClaim(input)}.json`);
    });
  }

  it("never produces a path, a dot-dot, a control or an HTML character for anything (sweep)", () => {
    const pieces = ["..", "/", "\\", "<", ">", "&", "\"", "'", ":", "|", "?", "*", "\u0000", "\n", "\u202E", "\u200B", " ", ".", "-", "a", "Z", "9", "é", "日", "%2e", "%00", "\ud800", "\u{1F600}"];
    let seed = 7;
    const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    for (let i = 0; i < 3000; i++) {
      const input = Array.from({ length: 1 + Math.floor(rand() * 14) }, () => pieces[Math.floor(rand() * pieces.length)]).join("");
      expectSafeFileName(`crash-scene-${fileClaim(input)}.json`);
    }
  });

  it("a short claim number that expands when printed and is then cut at 60 characters still gives a safe name", () => {
    // "\u2248" prints as " about ", so 21 characters can run well past 60 after cleaning.
    const name = fileClaim("\u2248\u2248\u2248\u2248\u2248\u2248\u2248\u2248aaaaaaaaaaa.b");
    expect(name.length).toBeLessThanOrEqual(60);
    expect(name).not.toMatch(/[-.]$/);
    expectSafeFileName(`crash-scene-${name}.json`);
    // every cut position: a separator can land on character 60 whatever came before it
    for (let n = 50; n <= 70; n++) {
      for (const sep of ["-", ".", "\u2248", " ", "/", "<"]) {
        const input = "a".repeat(n) + sep + "b".repeat(5);
        const out = fileClaim(input);
        expect(out.length, input).toBeLessThanOrEqual(60);
        expectSafeFileName(`crash-scene-${out}.json`);
      }
    }
    for (let reps = 1; reps <= 12; reps++) expectSafeFileName(`crash-scene-${fileClaim("\u2248".repeat(reps) + "a".repeat(11) + ".b")}.json`);
  });
});

describe("printable() for text that is drawn", () => {
  it("drops bidi controls, zero-width characters and control characters, keeps the visible text, and is idempotent", () => {
    for (const [, text] of HOSTILE) {
      const once = printable(text);
      expect(once).not.toMatch(BIDI_OR_CONTROL);
      expect(printable(once)).toBe(once);
    }
    expect(printable("<script>alert(1)</script>")).toBe("<script>alert(1)</script>");
    expect(printable("z\u200Bw\u200Dx\uFEFFy")).toBe("zwxy");
    expect(printable("a\u202Eb")).toBe("ab");
  });

  it("a zero-width character in a label does not turn into a '?' or a note about unprintable characters", async () => {
    const { scene, sim } = hostileScene("z\u200Bw\u200Cx\u200Dy\u2060v\uFEFFq");
    const tc = testCanvas();
    const bundle = await buildExports(request(scene, sim, ["pdf"]), tc.factory);
    expect(bundle.notes.filter((n) => /couldn't be printed/.test(n))).toEqual([]);
    const read = await readPdf(fileEnding(bundle, ".pdf").bytes);
    expect(read.text).toContain("zwxyvq");
    expect(read.text).not.toContain("?");
  }, 60_000);
});

describe("8. a tampered scene file, saved again", () => {
  it("the new save re-derives the notice, the time, the physics and the fingerprint instead of trusting the file", async () => {
    const { scene, sim } = twoVehicle();
    const original = await sceneFile(scene, sim, "2026-01-01T00:00:00Z");
    const tampered = {
      ...JSON.parse(original.text),
      disclaimer: "This is an expert reconstruction and proves fault.",
      createdAt: "2001-01-01T00:00:00Z",
      fingerprint: "0000 0000 0000 0000",
      physicsVersion: "9.9.9",
      derived: { frictionCoefficient: 99, assumptions: ["trust me"], warnings: [], vehicles: [] },
    };
    const parsed = parseSceneFile(new TextEncoder().encode(JSON.stringify(tampered)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.disclaimer).toContain("expert reconstruction"); // parsed as it was, never repaired in place

    const tc = testCanvas();
    // The app hands the opened file straight on as the scene; the exports must not carry its extras forward.
    const bundle = await buildExports(request(parsed.value, sim, ["pdf", "json"]), tc.factory);
    const json = fileEnding(bundle, ".json").bytes;
    const saved = JSON.parse(new TextDecoder().decode(json)) as Record<string, unknown>;
    expect(saved.disclaimer).toBe(DISCLAIMER_LONG);
    expect(saved.createdAt).toBe(CREATED);
    expect(saved.physicsVersion).toBe(sim.physicsVersion);
    expect(saved).not.toHaveProperty("fingerprint");
    expect((saved.derived as { frictionCoefficient: number }).frictionCoefficient).toBe(sim.frictionCoefficient);
    expect((saved.derived as { assumptions: unknown }).assumptions).toEqual(sim.assumptions);
    expect(JSON.stringify(saved)).not.toContain("trust me");
    expect(JSON.stringify(saved)).not.toContain("proves fault");

    // The fingerprint is the hash of the new bytes: it differs from the old file's, and the PDF prints the new one.
    expect(bundle.stamp.fingerprintHex).toBe(await sha256Hex(new TextDecoder().decode(json)));
    expect(bundle.stamp.fingerprintHex).not.toBe(original.stamp.fingerprintHex);
    const read = await readPdf(fileEnding(bundle, ".pdf").bytes);
    expect(read.text).toContain(bundle.stamp.fingerprintHex);
    expect(read.text).toContain(DISCLAIMER_LONG);
    expect(read.text).not.toContain("proves fault");
  }, 60_000);

  it("an untouched file saved again with the same clock gives the same bytes and fingerprint", async () => {
    const { scene, sim } = twoVehicle();
    const first = await sceneFile(scene, sim, CREATED);
    const parsed = parseSceneFile(new TextEncoder().encode(first.text));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const again = await sceneFile(parsed.value, sim, CREATED);
    expect(again.text).toBe(first.text);
    expect(again.stamp.fingerprintHex).toBe(first.stamp.fingerprintHex);
  });

  it("a one-character edit to the file changes the fingerprint of the next save", async () => {
    const { scene, sim } = twoVehicle();
    const a = await sceneFile(scene, sim, CREATED);
    const edited = structuredClone(scene);
    edited.location.label += ".";
    const b = await sceneFile(edited, sim, CREATED);
    expect(b.stamp.fingerprintHex).not.toBe(a.stamp.fingerprintHex);
  });
});

describe("a result that cannot be printed", () => {
  it("numbers that are not finite stop the save with one plain sentence, not a half-made file", async () => {
    const { scene, sim } = twoVehicle();
    const broken: SimulationResult = { ...sim, frictionCoefficient: Number.NaN };
    const tc = testCanvas();
    let message = "";
    try { await buildExports(request(scene, broken, ["pdf", "json"]), tc.factory); } catch (e) { message = e instanceof Error ? e.message : "not an Error"; }
    expect(message).toBe("Scene contains a number that isn't finite.");
    expect(message).not.toMatch(/NaN|undefined|\bat \S+ \(/);
  }, 60_000);
});
