// "Break it on purpose": hostile and clumsy input against the pure contracts.
// Every case asserts two things: nothing throws or hangs, and the claimant sees an exact,
// plain-language sentence (no stack trace, no "undefined", no raw zod wording or paths).
import { afterEach, describe, expect, it, vi } from "vitest";
import { DISCLAIMER_LONG, LIMITS, MAX_CANONICAL_DEPTH, MAX_SCENE_BYTES, SCHEMA_VERSION, canonicalJson, parseScene, parseSceneFile, sha256Hex } from "../src";
import type { ParseResult, Scene } from "../src";
import { sampleScene } from "./fixtures";

const STAMP = { createdAt: "2026-10-09T20:52:18Z", disclaimer: DISCLAIMER_LONG };
const enc = (s: string) => new TextEncoder().encode(s);
/** A well-formed scene file (the scene plus the stamp), as bytes. */
const fileBytes = (scene: unknown, extra: Record<string, unknown> = {}) => enc(JSON.stringify({ ...(scene as object), ...STAMP, ...extra }));

/** What a claimant must never see in an error. */
const RAW = /undefined|\bNaN\b|Infinity|\bnull\b|\[object|Invalid input|expected \w+, received|Too (small|big)|\bat \S+ \(|\.[cm]?[jt]sx?:\d|Error\b|\bzod\b|\$\.|vehicles\.\d|\bpath\b|\bstack\b/;
const FALLBACK = "Something in the scene isn't in the form we expect.";

function errorsOf<T>(r: ParseResult<T>): string[] {
  if (r.ok) throw new Error("expected the input to be refused, but it was accepted");
  return r.errors;
}
/** Every message is one readable sentence: capital letter, ends with a full stop, nothing technical. */
function expectPlain(errors: readonly string[]) {
  expect(errors.length).toBeGreaterThan(0);
  for (const e of errors) {
    expect(e, e).not.toMatch(RAW);
    expect(e, e).toMatch(/^(Vehicle [A-D]: )?[A-Z][^\n]*[.)]$/);
    expect(e.length, e).toBeLessThan(200);
  }
}
type Mutable = { location: Record<string, unknown>; vehicles: Array<Record<string, unknown>> } & Record<string, unknown>;
const mutable = () => sampleScene() as unknown as Mutable;
const withLoc = (patch: Record<string, unknown>) => { const s = mutable(); Object.assign(s.location, patch); return s; };
const withoutLoc = (key: string) => { const s = mutable(); delete s.location[key]; return s; };
const withSpeed = (speed: unknown, i = 0) => { const s = mutable(); s.vehicles[i]!.speed = speed; return s; };

afterEach(() => { vi.unstubAllGlobals(); });

describe("1. missing coordinates", () => {
  const LAT = "The location is missing its latitude.";
  const LON = "The location is missing its longitude.";
  const cases: Array<[string, () => unknown, string[]]> = [
    ["no lat", () => withoutLoc("lat"), [LAT]],
    ["no lon", () => withoutLoc("lon"), [LON]],
    ["lat null", () => withLoc({ lat: null }), [LAT]],
    ["lon null", () => withLoc({ lon: null }), [LON]],
    ["lat undefined", () => withLoc({ lat: undefined }), [LAT]],
    ["neither", () => { const s = withoutLoc("lat"); delete s.location.lon; return s; }, [LAT, LON]],
    ["both null", () => withLoc({ lat: null, lon: null }), [LAT, LON]],
  ];
  for (const [name, make, expected] of cases) {
    it(`parseScene: ${name}`, () => {
      const errors = errorsOf(parseScene(make()));
      expect(errors).toEqual(expected);
      expectPlain(errors);
    });
    it(`parseSceneFile: ${name}`, () => {
      const errors = errorsOf(parseSceneFile(fileBytes(make())));
      expect(errors).toEqual(expected);
      expectPlain(errors);
    });
  }

  it("a scene with no location at all is 'missing'; one that is the wrong kind of thing is 'isn't readable'", () => {
    for (const bad of [undefined, null]) expect(errorsOf(parseScene({ ...sampleScene(), location: bad }))).toEqual(["The scene is missing its location."]);
    for (const bad of [5, "Nashua", [], true]) expect(errorsOf(parseScene({ ...sampleScene(), location: bad }))).toEqual(["The scene's location isn't readable."]);
  });

  it("every other section says 'missing' when absent or null and 'isn't readable' when it is something else", () => {
    const sections: Array<[string, string, string]> = [
      ["claim", "The scene is missing its claim details.", "The scene's claim details aren't readable."],
      ["occurred", "The scene is missing the date of the crash.", "The scene's date of the crash isn't readable."],
      ["road", "The scene is missing the road condition.", "The scene's road condition isn't readable."],
      ["vehicles", "The scene is missing its vehicles.", "The scene's vehicles aren't readable."],
    ];
    for (const [key, missing, unreadable] of sections) {
      for (const bad of [undefined, null]) expect(errorsOf(parseScene({ ...sampleScene(), [key]: bad })), `${key} ${bad}`).toEqual([missing]);
      for (const bad of [7, "x", true, key === "vehicles" ? {} : []]) {
        const errors = errorsOf(parseScene({ ...sampleScene(), [key]: bad }));
        // (a piece of text has a length, so the "at least two vehicles" check can add its own plain sentence)
        expect(errors[0], `${key} ${JSON.stringify(bad)}`).toBe(unreadable);
        if (typeof bad !== "string") expect(errors).toEqual([unreadable]);
        expectPlain(errors);
      }
    }
    const s = sampleScene() as unknown as { claim: Record<string, unknown> };
    s.claim.vehicle = null;
    expect(errorsOf(parseScene(s))).toEqual(["The claim is missing its vehicle details."]);
    s.claim.vehicle = "Honda";
    expect(errorsOf(parseScene(s))).toEqual(["The claim's vehicle details aren't readable."]);
  });
});

describe("2. bad latitude and longitude", () => {
  const LAT_RANGE = "The latitude has to be between −90 and 90.";
  const LON_RANGE = "The longitude has to be between −180 and 180.";
  const LAT_NUM = "The latitude has to be a number between −90 and 90.";
  const LON_NUM = "The longitude has to be a number between −180 and 180.";

  it("refuses out-of-range values with the range in the sentence", () => {
    for (const lat of [91, -91, 90.0000001, 1e308, -1e308]) expect(errorsOf(parseScene(withLoc({ lat })))).toEqual([LAT_RANGE]);
    for (const lon of [181, -181, 180.0000001, 1e308, -1e308]) expect(errorsOf(parseScene(withLoc({ lon })))).toEqual([LON_RANGE]);
  });

  it("accepts exactly the edges of the range", () => {
    for (const [lat, lon] of [[90, 180], [-90, -180], [0, 0]] as const) expect(parseScene(withLoc({ lat, lon })).ok).toBe(true);
  });

  it("NaN and Infinity are 'not a number', never 'missing' and never printed as NaN", () => {
    for (const lat of [Number.NaN, Infinity, -Infinity]) expect(errorsOf(parseScene(withLoc({ lat })))).toEqual([LAT_NUM]);
    for (const lon of [Number.NaN, Infinity, -Infinity]) expect(errorsOf(parseScene(withLoc({ lon })))).toEqual([LON_NUM]);
  });

  it("text is refused, even text that looks like a number", () => {
    for (const lat of ["42.7", "north", "", " ", "4.2e1", true, {}, [], [42.7]]) {
      const errors = errorsOf(parseScene(withLoc({ lat })));
      expect(errors).toEqual([LAT_NUM]);
      expectPlain(errors);
    }
    for (const lon of ["-71.4", "west", "", {}, [-71.4]]) expect(errorsOf(parseScene(withLoc({ lon })))).toEqual([LON_NUM]);
  });

  it("through a file: out of range, and numbers that JSON cannot carry (1e999 becomes Infinity, NaN is invalid JSON)", () => {
    expect(errorsOf(parseSceneFile(fileBytes(withLoc({ lat: 91 }))))).toEqual([LAT_RANGE]);
    const text = new TextDecoder().decode(fileBytes(sampleScene())).replace(/"lat":[-\d.]+/, '"lat":1e999');
    expect(errorsOf(parseSceneFile(enc(text)))).toEqual([LAT_NUM]);
    const nan = new TextDecoder().decode(fileBytes(sampleScene())).replace(/"lat":[-\d.]+/, '"lat":NaN');
    expect(errorsOf(parseSceneFile(enc(nan)))).toEqual(["That file isn't a scene file we can read (it isn't valid JSON)."]);
  });

  it("latitude and longitude swapped: caught when it lands out of range, accepted when both happen to fit", () => {
    // San Francisco swapped: lat -122.4 is not a latitude.
    expect(errorsOf(parseScene(withLoc({ lat: -122.4194, lon: 37.7749 })))).toEqual([LAT_RANGE]);
    // Nashua swapped (the example in the brief): -71.46 / 42.76 are both legal numbers, so the schema cannot tell.
    // This is by design: a pin is placed on the map, and the map is what the claimant checks.
    const swapped = parseScene(withLoc({ lat: -71.46, lon: 42.76 }));
    expect(swapped.ok).toBe(true);
    // Both out of range: both are said.
    expect(errorsOf(parseScene(withLoc({ lat: -122.4, lon: 200 })))).toEqual([LAT_RANGE, LON_RANGE]);
  });
});

describe("3. speeds", () => {
  const FAST = `Vehicle A: That's faster than we can illustrate. Enter ${LIMITS.maxSpeedMph} mph or less.`;
  const known = (mph: unknown) => withSpeed({ kind: "known", mph });
  const unsure = (limitMph: unknown) => withSpeed({ kind: "unsure", limitMph });

  it("300 mph (twice the maximum) gets a friendly capped message that names the cap", () => {
    expect(LIMITS.maxSpeedMph).toBe(150);
    expect(errorsOf(parseScene(known(300)))).toEqual([FAST]);
    expect(errorsOf(parseScene(known(150.01)))).toEqual([FAST]);
    expect(parseScene(known(150)).ok).toBe(true);
  });

  it("1e308 mph and Infinity", () => {
    expect(errorsOf(parseScene(known(1e308)))).toEqual([FAST]);
    expect(errorsOf(parseScene(known(Number.MAX_VALUE)))).toEqual([FAST]);
    expect(errorsOf(parseScene(known(Infinity)))).toEqual(["Vehicle A: The speed should be a number of mph."]);
  });

  it("negative speed, -0 and NaN", () => {
    expect(errorsOf(parseScene(known(-5)))).toEqual(["Vehicle A: The speed can't be below 0 mph."]);
    expect(errorsOf(parseScene(known(-1e-9)))).toEqual(["Vehicle A: The speed can't be below 0 mph."]);
    expect(errorsOf(parseScene(known(Number.NaN)))).toEqual(["Vehicle A: The speed should be a number of mph."]);
    expect(parseScene(known(-0)).ok).toBe(true);
  });

  it("text, null and a missing speed", () => {
    expect(errorsOf(parseScene(known("30")))).toEqual(["Vehicle A: The speed should be a number of mph."]);
    expect(errorsOf(parseScene(known(null)))).toEqual(["Vehicle A: The speed should be a number of mph (it's missing)."]);
    expect(errorsOf(parseScene(withSpeed(undefined)))).toEqual(["Vehicle A: Each moving vehicle needs a speed, or 'not sure' (it's missing)."]);
    expect(errorsOf(parseScene(withSpeed({ kind: "fast", mph: 10 })))).toEqual(["Vehicle A: Each moving vehicle needs a speed, or 'not sure'."]);
  });

  it("the vehicle letter follows the vehicle, not the position", () => {
    expect(errorsOf(parseScene(withSpeed({ kind: "known", mph: 300 }, 1)))).toEqual(["Vehicle B: That's faster than we can illustrate. Enter 150 mph or less."]);
  });

  it("'not sure' with a posted limit of 300, 0, negative, or text", () => {
    expect(errorsOf(parseScene(unsure(300)))).toEqual([`Vehicle A: The speed limit can't be above ${LIMITS.maxLimitMph} mph.`]);
    expect(errorsOf(parseScene(unsure(0)))).toEqual([`Vehicle A: The speed limit can't be below ${LIMITS.minLimitMph} mph.`]);
    expect(errorsOf(parseScene(unsure(-30)))).toEqual([`Vehicle A: The speed limit can't be below ${LIMITS.minLimitMph} mph.`]);
    expect(errorsOf(parseScene(unsure(Number.NaN)))).toEqual(["Vehicle A: The speed limit should be a number of mph."]);
    expect(errorsOf(parseScene(unsure("25")))).toEqual(["Vehicle A: The speed limit should be a number of mph."]);
    // null is the documented "I don't know the limit".
    expect(parseScene(unsure(null)).ok).toBe(true);
    expect(parseScene(unsure(LIMITS.minLimitMph)).ok).toBe(true);
    expect(parseScene(unsure(LIMITS.maxLimitMph)).ok).toBe(true);
  });

  it("0 mph is accepted by the schema for a moving action: the physics-side check says 'nothing moving' (see breakit-physics)", () => {
    expect(parseScene(known(0)).ok).toBe(true);
  });

  it("every vehicle parked is refused here, in plain words", () => {
    const s = mutable();
    for (const v of s.vehicles) v.action = "parked";
    expect(errorsOf(parseScene(s))).toEqual(["At least one vehicle has to be moving."]);
  });

  it("a speed in a saved file is held to the same limits", () => {
    expect(errorsOf(parseSceneFile(fileBytes(known(300))))).toEqual([FAST]);
  });
});

describe("5. hostile text in labels (core)", () => {
  const HOSTILE = [
    "<script>alert(1)</script>",
    '"><img src=x onerror=alert(1)>',
    "javascript:alert(1)",
    "a\u202Eb\u2066c\u2069 \u200Bz\u200Dw\uFEFFq",
    "line\nbreak\ttab\u0000nul\u001b[31m",
    "\ud800 lone surrogate",
  ];
  const fill = (text: string): Scene => {
    const s = sampleScene();
    s.claim.number = text.slice(0, LIMITS.maxTextChars);
    s.claim.vehicle.make = text.slice(0, 60);
    s.claim.vehicle.model = text.slice(0, 80);
    s.location.label = text;
    s.location.nearLabel = text;
    s.vehicles[0]!.travel.roadName = text;
    s.vehicles[0]!.make = text.slice(0, 60);
    s.vehicles[0]!.model = text.slice(0, 80);
    return s;
  };

  for (const text of HOSTILE) {
    it(`keeps ${JSON.stringify(text).slice(0, 40)} as plain text in every label field and round-trips`, async () => {
      const scene = fill(text);
      const r = parseScene(scene);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.location.label).toBe(text);
      expect(r.value.location.nearLabel).toBe(text);
      expect(r.value.vehicles[0]!.travel.roadName).toBe(text);
      expect(r.value.vehicles[0]!.make).toBe(text.slice(0, 60));
      expect(r.value.claim.vehicle.model).toBe(text.slice(0, 80));
      expect(r.value.claim.number).toBe(text);

      // Canonical JSON: valid JSON, same value back, plain ASCII for control and lone-surrogate characters.
      const canon = canonicalJson(r.value);
      expect(JSON.parse(canon)).toEqual(r.value);
      expect(canon).not.toMatch(/[\u0000-\u001f]/);
      // The bytes we hash are the bytes we save: a lone surrogate must not become U+FFFD on the way to UTF-8.
      expect(new TextDecoder().decode(new TextEncoder().encode(canon))).toBe(canon);
      expect(await sha256Hex(canon)).toMatch(/^[0-9a-f]{64}$/);

      // And through a saved file.
      const back = parseSceneFile(fileBytes(r.value));
      expect(back.ok && back.value.location.label).toBe(text);
    });
  }

  it("quotes and backslashes are escaped by canonicalJson, and keys are escaped too", () => {
    const canon = canonicalJson({ 'k"ey</script>': 'va"l\\ue</script><!--', n: 1 });
    expect(canon).toBe('{"k\\"ey</script>":"va\\"l\\\\ue</script><!--","n":1}');
    expect(JSON.parse(canon)).toEqual({ 'k"ey</script>': 'va"l\\ue</script><!--', n: 1 });
  });

  it("text over the length limit is refused with the limit in the sentence", () => {
    const s = sampleScene();
    s.location.label = "<script>".repeat(100);
    expect(errorsOf(parseScene(s))).toEqual([`The place name is too long (${LIMITS.maxTextChars} characters at most).`]);
    const t = sampleScene();
    t.claim.number = "x".repeat(41);
    expect(errorsOf(parseScene(t))).toEqual(["The claim number is too long (40 characters at most)."]);
  });

  it("text fields that are not text are refused plainly (numbers, objects, null where text is required)", () => {
    for (const bad of [5, {}, [], true, Number.NaN]) {
      const s = mutable();
      s.location.label = bad;
      expect(errorsOf(parseScene(s))).toEqual(["The place name should be text."]);
    }
    // null and absent are different from "wrong kind": those are the missing ones.
    for (const bad of [null, undefined]) {
      const s = mutable();
      s.location.label = bad;
      expect(errorsOf(parseScene(s))).toEqual(["The place name should be text (it's missing)."]);
    }
  });
});

describe("6. a 50 MB file", () => {
  it("is refused by its size alone: no TextDecoder, no JSON.parse, and fast", () => {
    const big = new Uint8Array(50_000_000).fill(0x20);
    const parse = vi.spyOn(JSON, "parse");
    const decoder = vi.fn();
    vi.stubGlobal("TextDecoder", class { constructor() { decoder(); } decode() { throw new Error("must not decode"); } });
    const t0 = performance.now();
    const errors = errorsOf(parseSceneFile(big));
    const ms = performance.now() - t0;
    expect(errors).toEqual(["That file is too big to be a scene file (50.0 MB; the limit is 1 MB)."]);
    expectPlain(errors);
    expect(parse).not.toHaveBeenCalled();
    expect(decoder).not.toHaveBeenCalled();
    expect(ms).toBeLessThan(50);
  });

  it("MAX_SCENE_BYTES + 1 is refused before any decode; exactly MAX_SCENE_BYTES is read", () => {
    const parse = vi.spyOn(JSON, "parse");
    const over = new Uint8Array(MAX_SCENE_BYTES + 1).fill(0x20);
    expect(errorsOf(parseSceneFile(over))).toEqual(["That file is too big to be a scene file (it's over the 1 MB limit)."]);
    // never overstated: 1,199,999 bytes is "1.1 MB", not "1.2 MB"; 2.5 MB reads as such
    expect(errorsOf(parseSceneFile(new Uint8Array(1_199_999)))).toEqual(["That file is too big to be a scene file (1.1 MB; the limit is 1 MB)."]);
    expect(errorsOf(parseSceneFile(new Uint8Array(2_500_000)))).toEqual(["That file is too big to be a scene file (2.5 MB; the limit is 1 MB)."]);
    expect(parse).not.toHaveBeenCalled();

    // Exactly at the limit, a real scene padded with spaces is still opened.
    const base = fileBytes(sampleScene());
    const exact = new Uint8Array(MAX_SCENE_BYTES).fill(0x20);
    exact.set(base);
    expect(exact.byteLength).toBe(MAX_SCENE_BYTES);
    const ok = parseSceneFile(exact);
    expect(ok.ok).toBe(true);
    expect(parse).toHaveBeenCalledTimes(1);

    // One byte more and the same scene is refused.
    const one = new Uint8Array(MAX_SCENE_BYTES + 1).fill(0x20);
    one.set(base);
    expect(parseSceneFile(one).ok).toBe(false);
  });

  it("an empty file and a file of NUL bytes at the limit give the unreadable-file sentence", () => {
    const unreadable = "That file isn't a scene file we can read (it isn't valid JSON).";
    expect(errorsOf(parseSceneFile(new Uint8Array(0)))).toEqual([unreadable]);
    expect(errorsOf(parseSceneFile(new Uint8Array(MAX_SCENE_BYTES)))).toEqual([unreadable]);
  });
});

describe("7. malformed JSON", () => {
  const UNREADABLE = "That file isn't a scene file we can read (it isn't valid JSON).";
  const NOT_A_SCENE = "That doesn't look like a crash scene.";
  const validText = () => new TextDecoder().decode(fileBytes(sampleScene()));

  it("truncated input, trailing commas, a lone brace and other broken text", () => {
    const valid = validText();
    for (const text of [valid.slice(0, valid.length - 1), valid.slice(0, 40), valid.slice(0, -1) + ",}", "{", "}", "{,}", '{"a":1,}', "[1,]", "{'a':1}", "undefined", "NaN", "{\"a\":NaN}", "", "   ", "\u0000"]) {
      const errors = errorsOf(parseSceneFile(enc(text)));
      expect(errors, JSON.stringify(text.slice(0, 20))).toEqual([UNREADABLE]);
      expectPlain(errors);
    }
  });

  it("a UTF-8 byte order mark is ignored, and a file that is only a BOM is just unreadable", () => {
    const withBom = enc(`\uFEFF${validText()}`);
    expect(withBom[0]).toBe(0xef);
    expect(parseSceneFile(withBom).ok).toBe(true);
    expect(errorsOf(parseSceneFile(enc("\uFEFF")))).toEqual([UNREADABLE]);
  });

  it("invalid UTF-8 bytes anywhere are refused as unreadable, never decoded into replacement characters", () => {
    const valid = fileBytes(sampleScene());
    for (const bad of [[0xff], [0xc3, 0x28], [0xe2, 0x82], [0xf0, 0x28, 0x8c, 0xbc], [0xed, 0xa0, 0x80]]) {
      const bytes = new Uint8Array(valid.length + bad.length);
      bytes.set(valid.subarray(0, 10));
      bytes.set(bad, 10);
      bytes.set(valid.subarray(10), 10 + bad.length);
      expect(errorsOf(parseSceneFile(bytes))).toEqual([UNREADABLE]);
    }
    expect(errorsOf(parseSceneFile(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])))).toEqual([UNREADABLE]);
    // UTF-16 text (what some editors save) is not UTF-8 JSON.
    const utf16 = new Uint8Array(validText().length * 2);
    new DataView(utf16.buffer).setUint16(0, 0xfeff, true);
    expect(errorsOf(parseSceneFile(utf16))).toEqual([UNREADABLE]);
  });

  it("JSON that is a number, string, array, boolean or null is 'not a crash scene'", () => {
    for (const text of ["0", "42", "-1e5", '"a string"', '"{}"', "[]", "[1,2,3]", "[{}]", "true", "false", "null"]) {
      const errors = errorsOf(parseSceneFile(enc(text)));
      expect(errors, text).toEqual([NOT_A_SCENE]);
      expectPlain(errors);
    }
    for (const x of [0, 42, "text", [], [1], true, null, undefined]) expect(errorsOf(parseScene(x))).toEqual([NOT_A_SCENE]);
  });

  it("an empty object has no version, and says so instead of listing every missing part", () => {
    const errors = errorsOf(parseSceneFile(enc("{}")));
    expect(errors).toEqual(["This file doesn't say which version of the tool saved it, so it can't be opened."]);
    expectPlain(errors);
  });

  it("a right-version file missing every other part lists each part in plain words", () => {
    const errors = errorsOf(parseSceneFile(enc(JSON.stringify({ schemaVersion: SCHEMA_VERSION }))));
    expect(errors).toEqual(expect.arrayContaining([
      "The scene is missing its claim details.",
      "The scene is missing its location.",
      "The scene is missing the date of the crash.",
      "The scene is missing the road condition.",
      "The scene is missing its vehicles.",
      "The save time is missing or malformed.",
      "This file is missing the illustration notice.",
    ]));
    expectPlain(errors);
  });

  it("100,000 levels of nested arrays: no stack overflow, no hang, a plain message", () => {
    const depth = 100_000;
    const t0 = performance.now();
    const errors = errorsOf(parseSceneFile(enc("[".repeat(depth) + "]".repeat(depth))));
    expect(errors).toEqual([NOT_A_SCENE]);
    // Nested objects, and an unclosed pile of brackets.
    expect(errorsOf(parseSceneFile(enc('{"a":'.repeat(depth) + "1" + "}".repeat(depth))))).toEqual(["This file doesn't say which version of the tool saved it, so it can't be opened."]);
    expect(errorsOf(parseSceneFile(enc("[".repeat(depth))))).toEqual([UNREADABLE]);
    expect(performance.now() - t0).toBeLessThan(2_000);
  });

  it("a valid scene whose 'derived' block is 100,000 levels deep is still opened without recursion on our side", () => {
    const depth = 100_000;
    const text = validText().replace(/}$/, `,"derived":${"[".repeat(depth)}${"]".repeat(depth)}}`);
    expect(parseSceneFile(enc(text)).ok).toBe(true);
  });

  it("duplicate keys: the last one wins, and what is validated is exactly what is used", () => {
    const valid = validText();
    const goodLoc = JSON.stringify(sampleScene().location);
    const badLoc = JSON.stringify({ ...sampleScene().location, lat: 999 });
    // good first, bad last: refused (a trailing bad value cannot hide behind an earlier good one)
    expect(errorsOf(parseSceneFile(enc(valid.replace(/}$/, `,"location":${badLoc}}`))))).toEqual(["The latitude has to be between −90 and 90."]);
    // bad first, good last: accepted, and the value is the good one
    const r = parseSceneFile(enc(valid.replace(/^{/, `{"location":${badLoc},`).replace(/}$/, `,"location":${goodLoc}}`)));
    expect(r.ok && r.value.location.lat).toBe(sampleScene().location.lat);
    // a duplicated schemaVersion cannot smuggle an old version past the check
    expect(errorsOf(parseSceneFile(enc(valid.replace(/}$/, ',"schemaVersion":2}'))))).toEqual(["This scene file is from a different version of the tool and can't be opened."]);
  });

  it("__proto__ and constructor keys never pollute Object.prototype or the parsed scene", () => {
    const evil = '"__proto__":{"polluted":"yes","isAdmin":true},"constructor":{"prototype":{"polluted2":"yes"}},"prototype":{"polluted3":"yes"}';
    const valid = validText();
    const planted = valid
      .replace(/^{/, `{${evil},`)
      .replace('"location":{', `"location":{${evil},`)
      .replace('"travel":{', `"travel":{${evil},`)
      .replace(/}$/, `,"derived":{${evil}}}`);
    expect(planted).toContain('"__proto__"');
    const r = parseSceneFile(enc(planted));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.getPrototypeOf(r.value)).toBe(Object.prototype);
      expect(Object.getPrototypeOf(r.value.location)).toBe(Object.prototype);
      expect((r.value as Record<string, unknown>).polluted).toBeUndefined();
      expect((r.value.location as Record<string, unknown>).isAdmin).toBeUndefined();
      // unknown keys are dropped from the scene itself
      expect(Object.keys(r.value.location)).not.toContain("__proto__");
      expect(Object.keys(r.value.location)).not.toContain("constructor");
      // 'derived' is free-form and passes through, but as plain own data
      const derived = r.value.derived as Record<string, unknown>;
      expect(Object.getPrototypeOf(derived)).toBe(Object.prototype);
      expect((derived as { polluted?: unknown }).polluted).toBeUndefined();
      // canonical JSON of it is stable and re-parses to the same text
      const canon = canonicalJson(r.value);
      expect(canonicalJson(JSON.parse(canon))).toBe(canon);
    }
    for (const key of ["polluted", "polluted2", "polluted3", "isAdmin"]) {
      expect(({} as Record<string, unknown>)[key]).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(Object.prototype, key)).toBe(false);
    }
    // the same keys handed to parseScene directly (as an already-parsed object)
    const direct = parseScene(JSON.parse(`{${evil}}`));
    expect(direct.ok).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("8. wrong schema version, and a tampered file", () => {
  const DIFFERENT = "This scene file is from a different version of the tool and can't be opened.";
  const NO_VERSION = "This file doesn't say which version of the tool saved it, so it can't be opened.";
  const withVersion = (v: unknown) => ({ ...sampleScene(), schemaVersion: v });

  it("2, 4, '3', 3.5, -1, null and 0 are all 'different version'; missing says it has no version", () => {
    for (const v of [2, 4, "3", 3.5, -1, 0, 3.0000001, [3], { v: 3 }, true]) {
      expect(errorsOf(parseScene(withVersion(v))), String(v)).toEqual([DIFFERENT]);
      expect(errorsOf(parseSceneFile(fileBytes(withVersion(v)))), String(v)).toEqual([DIFFERENT]);
    }
    const none = sampleScene() as unknown as Record<string, unknown>;
    delete none.schemaVersion;
    expect(errorsOf(parseScene(none))).toEqual([NO_VERSION]);
    expect(errorsOf(parseSceneFile(fileBytes(none)))).toEqual([NO_VERSION]);
    expect(errorsOf(parseScene(withVersion(undefined)))).toEqual([NO_VERSION]);
    // null is as good as absent
    expect(errorsOf(parseScene(withVersion(null)))).toEqual([NO_VERSION]);
    expect(errorsOf(parseSceneFile(fileBytes(withVersion(null))))).toEqual([NO_VERSION]);
  });

  it("a wrong version is reported by itself, even when the rest of the file is also wrong", () => {
    const messy = { schemaVersion: 2, location: { lat: "x" }, vehicles: 7 };
    expect(errorsOf(parseSceneFile(enc(JSON.stringify(messy))))).toEqual([DIFFERENT]);
    expect(errorsOf(parseScene(messy))).toEqual([DIFFERENT]);
  });

  it("only the current version opens", () => {
    expect(SCHEMA_VERSION).toBe(3);
    expect(parseSceneFile(fileBytes(sampleScene())).ok).toBe(true);
  });

  // What is checked when a file was edited by hand. The file has no fingerprint field: the
  // fingerprint is the SHA-256 of the file's own bytes, printed on the PDF and PNGs, so a changed
  // file simply has a different fingerprint. Nothing the file claims about itself is trusted.
  it("an edited disclaimer or save time is still opened as data (the app re-derives both when it saves)", () => {
    const r = parseSceneFile(fileBytes(sampleScene(), { disclaimer: "This is an expert reconstruction and proves fault.", createdAt: "2001-01-01T00:00:00Z" }));
    expect(r.ok).toBe(true);
    // the parser does not repair or replace them; it reports the file as it is
    expect(r.ok && r.value.disclaimer).toBe("This is an expert reconstruction and proves fault.");
    // ... so the app must never print file.disclaimer: it prints DISCLAIMER_LONG (see exports breakit: the saved file and PDF carry the real notice)
    expect(DISCLAIMER_LONG).not.toContain("proves fault");
  });

  it("a missing, empty or non-text disclaimer, or a malformed save time, is refused in plain words", () => {
    const NOTICE = "This file is missing the illustration notice.";
    const TIME = "The save time is missing or malformed.";
    expect(errorsOf(parseSceneFile(fileBytes(sampleScene(), { disclaimer: "" })))).toEqual([NOTICE]);
    expect(errorsOf(parseSceneFile(fileBytes(sampleScene(), { disclaimer: 7 })))).toEqual([NOTICE]);
    expect(errorsOf(parseSceneFile(fileBytes(sampleScene(), { disclaimer: null })))).toEqual([NOTICE]);
    for (const createdAt of ["yesterday", "2026-13-45T00:00:00Z", "", 20261009, null]) {
      expect(errorsOf(parseSceneFile(fileBytes(sampleScene(), { createdAt }))), String(createdAt)).toEqual([TIME]);
    }
    const noStamp = enc(JSON.stringify(sampleScene()));
    expect(errorsOf(parseSceneFile(noStamp))).toEqual([TIME, NOTICE]);
  });

  it("a made-up fingerprint or other extra field is dropped, never kept or trusted", () => {
    const r = parseSceneFile(fileBytes(sampleScene(), { fingerprint: "0000 0000 0000 0000", fingerprintHex: "0".repeat(64), physicsVersion: "9.9.9" }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).not.toHaveProperty("fingerprint");
      expect(r.value).not.toHaveProperty("fingerprintHex");
      expect(r.value).not.toHaveProperty("physicsVersion");
    }
  });

  it("an edited 'derived' block is carried as opaque data and never read by the parser", () => {
    const r = parseSceneFile(fileBytes(sampleScene(), { derived: { frictionCoefficient: 99, assumptions: ["trust me"] } }));
    expect(r.ok && r.value.derived).toEqual({ frictionCoefficient: 99, assumptions: ["trust me"] });
  });
});

describe("any single wrong field gives plain sentences (sweep)", () => {
  type Path = Array<string | number>;
  const leaves = (v: unknown, path: Path = [], out: Path[] = []): Path[] => {
    if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v)) leaves(x, [...path, Array.isArray(v) ? Number(k) : k], out);
    else out.push(path);
    return out;
  };
  const setAt = (root: unknown, path: Path, value: unknown) => {
    let cur = root as Record<string | number, unknown>;
    for (const k of path.slice(0, -1)) cur = cur[k] as Record<string | number, unknown>;
    if (value === undefined) delete cur[path[path.length - 1]!]; else cur[path[path.length - 1]!] = value;
  };
  const BAD: unknown[] = [undefined, null, "", "x", "<script>", 0, -1, 1e308, Number.NaN, Infinity, true, false, {}, [], [1], { kind: "known" }];

  it("never throws, never uses zod's wording, never falls back to the generic sentence", () => {
    let refused = 0;
    const generic = new Set<string>();
    for (const path of leaves(sampleScene())) {
      for (const bad of BAD) {
        const s = sampleScene();
        setAt(s, path, bad);
        let r: ParseResult<Scene>;
        expect(() => { r = parseScene(s); }, `${path.join(".")} = ${String(bad)}`).not.toThrow();
        r = parseScene(s);
        if (r.ok) continue;
        refused += 1;
        expectPlain(r.errors);
        if (r.errors.some((e) => e.endsWith(FALLBACK))) generic.add(`${path.join(".")} = ${JSON.stringify(bad)}`);
      }
    }
    expect(refused).toBeGreaterThan(300);
    // Every field has its own sentence; the generic one is only a safety net.
    expect([...generic]).toEqual([]);
  });

  it("whole sections replaced by the wrong kind of thing", () => {
    for (const key of ["claim", "location", "occurred", "road", "vehicles"]) {
      for (const bad of [undefined, null, 1, "x", [], {}, true]) {
        const r = parseScene({ ...sampleScene(), [key]: bad });
        if (!r.ok) { expectPlain(r.errors); expect(r.errors.filter((e) => e.endsWith(FALLBACK))).toEqual([]); }
      }
    }
    for (const bad of [[], [sampleScene().vehicles[0]], new Array(5).fill(sampleScene().vehicles[0]), [null, null], ["A", "B"], [{}, {}]]) {
      const r = parseScene({ ...sampleScene(), vehicles: bad });
      expect(r.ok).toBe(false);
      if (!r.ok) { expectPlain(r.errors); expect(r.errors.filter((e) => e.endsWith(FALLBACK))).toEqual([]); }
    }
  });
});

describe("3b. the tenths-of-a-mile-per-hour rule only judges numbers that are otherwise acceptable", () => {
  const TENTHS = "Use whole or tenths of a mile per hour, like 25 or 25.5.";
  const known = (mph: unknown) => withSpeed({ kind: "known", mph });
  const unsure = (limitMph: unknown) => withSpeed({ kind: "unsure", limitMph });

  it("out-of-range, non-finite and NaN speeds give exactly one message, the range or number one", () => {
    expect(errorsOf(parseScene(known(300)))).toEqual([`Vehicle A: That's faster than we can illustrate. Enter ${LIMITS.maxSpeedMph} mph or less.`]);
    expect(errorsOf(parseScene(known(300.05)))).toEqual([`Vehicle A: That's faster than we can illustrate. Enter ${LIMITS.maxSpeedMph} mph or less.`]);
    expect(errorsOf(parseScene(known(1e308)))).toEqual([`Vehicle A: That's faster than we can illustrate. Enter ${LIMITS.maxSpeedMph} mph or less.`]);
    expect(errorsOf(parseScene(known(-5.55)))).toEqual(["Vehicle A: The speed can't be below 0 mph."]);
    expect(errorsOf(parseScene(known(Infinity)))).toEqual(["Vehicle A: The speed should be a number of mph."]);
    expect(errorsOf(parseScene(known(-Infinity)))).toEqual(["Vehicle A: The speed should be a number of mph."]);
    expect(errorsOf(parseScene(known(Number.NaN)))).toEqual(["Vehicle A: The speed should be a number of mph."]);
    expect(errorsOf(parseScene(unsure(300.05)))).toEqual([`Vehicle A: The speed limit can't be above ${LIMITS.maxLimitMph} mph.`]);
    expect(errorsOf(parseScene(unsure(0.05)))).toEqual([`Vehicle A: The speed limit can't be below ${LIMITS.minLimitMph} mph.`]);
    expect(errorsOf(parseScene(unsure(Number.NaN)))).toEqual(["Vehicle A: The speed limit should be a number of mph."]);
  });

  it("an in-range speed finer than a tenth gets only the tenths message", () => {
    expect(errorsOf(parseScene(known(25.05)))).toEqual([`Vehicle A: ${TENTHS}`]);
    expect(errorsOf(parseScene(known(0.01)))).toEqual([`Vehicle A: ${TENTHS}`]);
    expect(errorsOf(parseScene(known(149.99)))).toEqual([`Vehicle A: ${TENTHS}`]);
    expect(errorsOf(parseScene(unsure(30.05)))).toEqual([`Vehicle A: ${TENTHS}`]);
  });

  it("whole and tenths values are fine, at the edges too", () => {
    for (const mph of [25, 25.3, 25.5, 0, 0.1, 149.9, LIMITS.maxSpeedMph]) expect(parseScene(known(mph)).ok, String(mph)).toBe(true);
    for (const limit of [LIMITS.minLimitMph, 30.3, LIMITS.maxLimitMph, null]) expect(parseScene(unsure(limit)).ok, String(limit)).toBe(true);
  });
});

describe("10. canonicalJson refuses absurd nesting instead of overflowing the stack", () => {
  const TOO_DEEP = "This scene is nested too deeply to save.";
  const nestedArrays = (levels: number): unknown => { let v: unknown = 1; for (let i = 0; i < levels; i++) v = [v]; return v; };
  const nestedObjects = (levels: number): unknown => { let v: unknown = 1; for (let i = 0; i < levels; i++) v = { a: v }; return v; };

  it("10,000 levels of arrays or objects throw one plain sentence", () => {
    for (const make of [nestedArrays, nestedObjects]) {
      let message = "";
      try { canonicalJson(make(10_000)); } catch (e) { message = e instanceof Error ? e.message : "not an Error"; }
      expect(message).toBe(TOO_DEEP);
      expect(message).not.toMatch(RAW);
    }
  });

  it("the cap is exactly MAX_CANONICAL_DEPTH levels", () => {
    expect(MAX_CANONICAL_DEPTH).toBe(64);
    for (const make of [nestedArrays, nestedObjects]) {
      expect(() => canonicalJson(make(MAX_CANONICAL_DEPTH))).not.toThrow();
      expect(() => canonicalJson(make(MAX_CANONICAL_DEPTH + 1))).toThrow(TOO_DEEP);
    }
    expect(canonicalJson(nestedArrays(3))).toBe("[[[1]]]");
  });

  it("a cyclic value is refused the same way, not with a stack overflow", () => {
    const a: Record<string, unknown> = { name: "loop" };
    a.self = a;
    expect(() => canonicalJson(a)).toThrow(TOO_DEEP);
    const arr: unknown[] = [];
    arr.push(arr);
    expect(() => canonicalJson(arr)).toThrow(TOO_DEEP);
  });

  it("a real scene is nowhere near the cap, and a deep 'derived' block from an opened file is refused only when saving", () => {
    expect(() => canonicalJson({ ...sampleScene(), ...STAMP })).not.toThrow();
    const text = new TextDecoder().decode(fileBytes(sampleScene())).replace(/}$/, `,"derived":${"[".repeat(10_000)}${"]".repeat(10_000)}}`);
    const r = parseSceneFile(enc(text));
    expect(r.ok).toBe(true); // opening it is fine
    if (r.ok) expect(() => canonicalJson(r.value)).toThrow(TOO_DEEP);
  });

  it("the non-finite number sentence is unchanged", () => {
    expect(() => canonicalJson({ x: [Number.NaN] })).toThrow("Scene contains a number that isn't finite.");
  });
});

describe("9. the crash date has to be a real day that isn't in the future", () => {
  const NOT_REAL = "The date isn't a real date. Use the date the crash happened.";
  const FUTURE = "The date is in the future. Use the date the crash happened.";
  const onDate = (date: unknown) => { const s = mutable(); s.occurred = { ...(s.occurred as object), date }; return s; };

  afterEach(() => { vi.useRealTimers(); });

  it("refuses days that don't exist", () => {
    for (const d of ["2026-13-45", "2026-00-10", "2026-10-00", "2026-02-30", "2026-02-29", "2025-02-29", "2026-04-31", "2026-06-31", "2026-11-31", "2026-99-99", "0000-00-00"]) {
      expect(errorsOf(parseScene(onDate(d))), d).toEqual([NOT_REAL]);
      expect(errorsOf(parseSceneFile(fileBytes(onDate(d)))), d).toEqual([NOT_REAL]);
    }
  });

  it("accepts real days, including 29 February in a leap year, and refuses it in 1900 and 2100", () => {
    for (const d of ["2026-10-02", "2024-02-29", "2000-02-29", "2026-01-31", "2025-12-31", "2026-04-30"]) expect(parseScene(onDate(d)).ok, d).toBe(true);
    for (const d of ["1900-02-29", "2100-02-29"]) expect(errorsOf(parseScene(onDate(d))), d).toEqual([NOT_REAL]);
  });

  it("badly shaped dates keep the format sentence only", () => {
    for (const d of ["2026-1-2", "10/02/2026", "yesterday", "", "2026-10-02T10:00:00Z", 20261002]) {
      const errors = errorsOf(parseScene(onDate(d)));
      expect(errors, String(d)).toEqual([expect.stringMatching(/^The date should look like 2026-10-02\./)]);
      expectPlain(errors);
    }
  });

  it("refuses a date in the future, but allows one day ahead for time zones", () => {
    vi.useFakeTimers({ now: new Date("2026-10-09T23:30:00Z") });
    expect(parseScene(onDate("2026-10-09")).ok).toBe(true);
    expect(parseScene(onDate("2026-10-10")).ok).toBe(true); // tomorrow in UTC: someone already in it elsewhere
    expect(errorsOf(parseScene(onDate("2026-10-11")))).toEqual([FUTURE]);
    expect(errorsOf(parseScene(onDate("2027-01-01")))).toEqual([FUTURE]);
    expect(errorsOf(parseScene(onDate("9999-12-31")))).toEqual([FUTURE]);
    expect(errorsOf(parseSceneFile(fileBytes(onDate("2026-10-11"))))).toEqual([FUTURE]);
    expectPlain([NOT_REAL, FUTURE]);
  });

  it("moves with the clock and works across month and year ends", () => {
    vi.useFakeTimers({ now: new Date("2026-12-31T12:00:00Z") });
    expect(parseScene(onDate("2027-01-01")).ok).toBe(true);
    expect(errorsOf(parseScene(onDate("2027-01-02")))).toEqual([FUTURE]);
    vi.setSystemTime(new Date("2028-02-28T12:00:00Z"));
    expect(parseScene(onDate("2028-02-29")).ok).toBe(true);
    expect(errorsOf(parseScene(onDate("2028-03-01")))).toEqual([FUTURE]);
  });

  it("a date that is both unreal and far away only gets the 'not real' sentence", () => {
    expect(errorsOf(parseScene(onDate("9999-13-45")))).toEqual([NOT_REAL]);
  });
});
