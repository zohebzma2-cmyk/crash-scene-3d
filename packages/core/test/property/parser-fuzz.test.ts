// Fuzzing the scene parser: parseScene (the in-app path) and parseSceneFile (the "open a scene file" path in SaveStep).
// For every input: it never throws; it is ok:true or ok:false with plain sentences (no HTML, no zod wording); a scene it
// accepts never makes simulate() fail with an internal error; Object.prototype is never changed; every case is fast.
import { afterAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { MAX_SCENE_BYTES, parseScene, parseSceneFile, simulate } from "../../src";
import { assertAllFinite } from "../physics-helpers";
import { REAL_NETS, fcParams, report, runs, sceneCaseArb } from "./arbitraries";
import { sampleScene } from "../fixtures";

/** Wall-clock budget for one parse, ms. zod on a 1 MB file is well under this; catastrophic backtracking is not. */
const PARSE_BUDGET_MS = 250;

const protoKeys = (): string[] => Object.getOwnPropertyNames(Object.prototype).sort();
const PROTO_BEFORE = protoKeys();

function expectPlainErrors(errors: readonly string[], label: string): void {
  expect(errors.length, label).toBeGreaterThan(0);
  for (const e of errors) {
    expect(typeof e, label).toBe("string");
    expect(e.length, label).toBeGreaterThan(0);
    expect(e.length, `${label}: message length`).toBeLessThan(400);
    expect(e, `${label}: no HTML`).not.toMatch(/[<>]/);
    expect(e, `${label}: no zod wording`).not.toMatch(/^(Invalid input|Too (small|big)|Invalid (string|option|literal|key|value)|Unrecognized key)|expected .* received/i);
    expect(e, `${label}: no raw values`).not.toMatch(/undefined|NaN|\[object/);
  }
}

function timed<T>(f: () => T, label: string): T {
  const t0 = performance.now();
  const out = f();
  const ms = performance.now() - t0;
  expect(ms, `${label}: took ${ms.toFixed(1)} ms`).toBeLessThan(PARSE_BUDGET_MS);
  return out;
}

const stats = { accepted: 0, refused: 0, simulated: 0 };

/** One parse result: the shape is right, and an accepted scene simulates without an internal error. */
function check(r: ReturnType<typeof parseScene> | ReturnType<typeof parseSceneFile>, label: string): void {
  expect(typeof r.ok).toBe("boolean");
  if (!r.ok) { stats.refused++; expectPlainErrors(r.errors, label); return; }
  stats.accepted++;
  for (const roads of [null, REAL_NETS["t-bone-intersection"]]) {
    const out = simulate(r.value, roads);
    expect(out.ok || !out.errors.some((e) => e.code === "cannot-work-out"), `${label}: simulate() hit an internal error`).toBe(true);
    if (out.ok) { stats.simulated++; assertAllFinite(out.result, label); }
  }
  expect(protoKeys()).toEqual(PROTO_BEFORE);
}

// ---------------------------------------------------------------- mutations of a valid scene

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Path = Array<string | number>;

/** Every path to an object or array member, in a fixed order. */
function paths(v: unknown, at: Path = []): Path[] {
  if (at.length >= 12) return []; // a deep nest planted by an earlier mutation is not walked into
  if (Array.isArray(v)) return v.flatMap((x, i) => [[...at, i], ...paths(x, [...at, i])]);
  if (v && typeof v === "object") return Object.keys(v).flatMap((k) => [[...at, k], ...paths((v as Record<string, unknown>)[k], [...at, k])]);
  return [];
}

const NASTY_STRINGS = [
  "NaN", "Infinity", "-Infinity", "1e309", "-0", "0x1F", "25 mph", " 25", "", "\u0000", "‮", "😀🚗💥", "é".normalize("NFD"),
  "<script>alert(1)</script>", "<img src=x onerror=alert(1)>", "javascript:alert(1)", "${7*7}", "{{7*7}}", "__proto__", "constructor", "toString",
  "A".repeat(301), "x".repeat(100_000), "a".repeat(5000) + "!", "2026-02-30", "2026-10-02T00:00:00Z", "99:99", "9".repeat(400),
];
const NASTY_NUMBERS = [Number.NaN, Infinity, -Infinity, 1e308, -1e308, Number.MAX_SAFE_INTEGER + 2, Number.MIN_VALUE, -0, 0.05, 25.05, 359.9999999, 360, -1e-12, 2 ** 53, 1e-320];

/** A deep nest is planted as this marker and built only when applied, so fast-check never has to print it. */
const DEEP = "__deep_nest__";
const deep = (n: number): Json => { let v: Json = 1; for (let i = 0; i < n; i++) v = i % 2 ? [v] : { k: v }; return v; };

type Mutation =
  | { op: "drop"; at: number }
  | { op: "dup"; at: number; from: number }
  | { op: "set"; at: number; value: unknown }
  | { op: "key"; at: number; key: string; value: unknown };

const valueArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constantFrom<unknown>(...NASTY_STRINGS, ...NASTY_NUMBERS, null, undefined, true, false, [], {}),
  fc.jsonValue({ maxDepth: 3 }),
  fc.string({ unit: "binary", maxLength: 40 }),
  fc.double(),
  fc.integer({ min: 1, max: 1000 }).map((n) => ({ [DEEP]: n })), // deeper nests (100,000 levels) are in the fixed cases below; structuredClone in `dup` recurses
  fc.constant(JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"prototype": {"polluted": true}}}') as unknown),
);

const mutationArb: fc.Arbitrary<Mutation> = fc.oneof(
  fc.record({ op: fc.constant("drop" as const), at: fc.nat() }),
  fc.record({ op: fc.constant("dup" as const), at: fc.nat(), from: fc.nat() }),
  fc.record({ op: fc.constant("set" as const), at: fc.nat(), value: valueArb }),
  fc.record({ op: fc.constant("key" as const), at: fc.nat(), key: fc.constantFrom("__proto__", "constructor", "prototype", "toString", "hasOwnProperty", "extra", "😀"), value: valueArb }),
);

/** A fresh copy of a planted value (constants are shared between runs, and a shared object could be made circular). */
const build = (v: unknown): unknown => {
  if (!v || typeof v !== "object") return v;
  return DEEP in v ? deep((v as Record<string, number>)[DEEP]!) : JSON.parse(JSON.stringify(v));
};
function getAt(root: unknown, p: Path): unknown { return p.reduce<unknown>((o, k) => (o as Record<string | number, unknown>)[k], root); }

/** Set an own property the way JSON.parse does (never through the __proto__ setter). */
const put = (obj: Record<string | number, unknown>, key: string | number, value: unknown): void => {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
};

/** Apply mutations to a deep copy. Keys like __proto__ are set as own properties (as JSON.parse would make them). */
function mutate(base: unknown, ms: readonly Mutation[]): unknown {
  const root = { v: structuredClone(base) as unknown };
  for (const m of ms) {
    const all = paths(root.v);
    if (all.length === 0) break;
    const p = all[m.at % all.length]!;
    const parent = p.length === 1 ? root.v : getAt(root.v, p.slice(0, -1));
    const key = p[p.length - 1]!;
    if (!parent || typeof parent !== "object") continue;
    const obj = parent as Record<string | number, unknown>;
    if (m.op === "drop") { if (Array.isArray(obj)) obj.splice(key as number, 1); else delete obj[key]; }
    else if (m.op === "dup") put(obj, key, structuredClone(getAt(root.v, all[m.from % all.length]!)));
    else if (m.op === "set") put(obj, key, build(m.value));
    else {
      const target = getAt(root.v, p);
      if (target && typeof target === "object" && !Array.isArray(target)) Object.defineProperty(target, m.key, { value: build(m.value), enumerable: true, writable: true, configurable: true });
    }
  }
  return root.v;
}

const fileOf = (scene: unknown): unknown => ({ ...(scene as object), createdAt: "2026-10-02T17:20:00.000Z", disclaimer: "Illustration only.", derived: { assumptions: [] } });
const bytesOf = (v: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(v) ?? "");

const N = runs(1000);

describe("fuzzing the scene parser", () => {
  afterAll(() => {
    report(`[parser fuzz] ${stats.accepted} accepted, ${stats.refused} refused, ${stats.simulated} simulate() results checked`);
    expect(protoKeys()).toEqual(PROTO_BEFORE);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it(`parseScene: ${N} arbitrary values never throw and get plain answers`, () => {
    fc.assert(fc.property(fc.oneof(fc.anything({ maxDepth: 4, withNullPrototype: true, withBoxedValues: true, withMap: true, withSet: true, withTypedArray: true, withSparseArray: true }), fc.jsonValue()), (v) => {
      check(timed(() => parseScene(v), "anything"), "anything");
    }), fcParams(N));
  });

  it(`parseScene: ${N} mutated valid scenes never throw, and what they accept simulates`, () => {
    fc.assert(fc.property(sceneCaseArb, fc.array(mutationArb, { minLength: 1, maxLength: 4 }), ({ scene }, ms) => {
      const v = mutate(scene, ms);
      check(timed(() => parseScene(v), "mutated"), `mutated ${JSON.stringify(ms).slice(0, 300)}`);
    }), fcParams(N));
  }, 120_000);

  it(`parseSceneFile: ${N} mutated scene files and random bytes never throw`, () => {
    const fileCase = fc.oneof(
      fc.array(mutationArb, { minLength: 0, maxLength: 4 }).map((ms) => bytesOf(mutate(fileOf(sampleScene()), ms))),
      fc.uint8Array({ maxLength: 2000 }),
      fc.string({ unit: "binary", maxLength: 500 }).map((s) => new TextEncoder().encode(s)),
      fc.jsonValue().map(bytesOf),
    );
    fc.assert(fc.property(fileCase, (bytes) => {
      check(timed(() => parseSceneFile(bytes), "file"), "file");
    }), fcParams(N));
  }, 120_000);

  it("the size limit is checked first, on the raw bytes, and quickly", () => {
    for (const n of [MAX_SCENE_BYTES + 1, MAX_SCENE_BYTES + 99_999, 5 * MAX_SCENE_BYTES]) {
      const r = timed(() => parseSceneFile(new Uint8Array(n).fill(0x20)), `size ${n}`);
      expect(r.ok).toBe(false);
      if (!r.ok) { expectPlainErrors(r.errors, `size ${n}`); expect(r.errors[0]).toMatch(/too big/); }
    }
    // Just under the limit: a valid file padded with whitespace still opens.
    const valid = bytesOf(fileOf(sampleScene()));
    const padded = new Uint8Array(MAX_SCENE_BYTES).fill(0x20);
    padded.set(valid);
    const r = timed(() => parseSceneFile(padded), "padded");
    expect(r.ok).toBe(true);
  });

  it("deep nesting, huge numbers and prototype keys in a file are refused plainly without pollution", () => {
    const cases: string[] = [
      `${"[".repeat(100_000)}${"]".repeat(100_000)}`,
      `{"schemaVersion":3,"claim":${'{"a":'.repeat(50_000)}1${"}".repeat(50_000)}}`,
      '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}',
      JSON.stringify(fileOf(sampleScene())).replace('"vehicles":', '"__proto__":{"polluted":true},"vehicles":'),
      JSON.stringify(fileOf(sampleScene())).replace('"mph":25', '"mph":1e999'),
      JSON.stringify(fileOf(sampleScene())).replace('"lat":42.7654', '"lat":-0'),
      JSON.stringify(fileOf(sampleScene())).replace('"bearingDeg":0', '"bearingDeg":"NaN"'),
    ];
    for (const c of cases) {
      const r = timed(() => parseSceneFile(new TextEncoder().encode(c)), c.slice(0, 40));
      check(r, c.slice(0, 40));
    }
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
});
