import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex, shortFingerprint, formatDistance, formatSpeed, directionCaption, boundWord, joinClauses, MPH_TO_MPS } from "../src";

describe("canonical JSON and fingerprint", () => {
  it("sorts keys and drops whitespace so equal scenes hash equally", async () => {
    const a = canonicalJson({ b: 1, a: [2, { d: 3, c: "x" }] });
    expect(a).toBe('{"a":[2,{"c":"x","d":3}],"b":1}');
    const h = await sha256Hex(a);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(shortFingerprint(h)).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){3}$/);
    expect(await sha256Hex(canonicalJson({ a: [2, { c: "x", d: 3 }], b: 1 }))).toBe(h);
  });
  it("refuses non-finite numbers", () => {
    expect(() => canonicalJson({ x: Number.NaN })).toThrow(/finite/);
  });
});

describe("formatter (SI in, text out)", () => {
  it("formats ranges in feet and meters", () => {
    expect(formatDistance({ lo: 4.9, mid: 5.8, hi: 6.7 }).text).toBe("16–22 ft / 4.9–6.7 m");
    expect(formatDistance(22.35).text).toBe("73 ft / 22.4 m");
  });
  it("formats speeds from m/s", () => {
    expect(formatSpeed(25 * MPH_TO_MPS).text).toBe("25 mph");
    expect(formatSpeed({ lo: 20 * MPH_TO_MPS, mid: 25 * MPH_TO_MPS, hi: 30 * MPH_TO_MPS }, { both: true }).text).toBe("20–30 mph · 32–48 km/h");
  });
  it("uses road-relative directions and keeps street-name case", () => {
    expect(boundWord(358)).toBe("northbound");
    expect(directionCaption({ action: "straight", travel: { bearingDeg: 2, roadId: null, roadName: "Main Street", lane: null } })).toBe("Northbound on Main Street");
    expect(directionCaption({ action: "backing", travel: { bearingDeg: 92, roadId: null, roadName: null, lane: null } })).toBe("Backing up, facing east");
  });
  it("doesn't repeat words when joining clauses", () => {
    expect(joinClauses(["going straight", "going straight", "heading north"])).toBe("going straight, heading north");
    // a word that ends one clause and starts the next is said once
    expect(joinClauses(["was going straight", "straight on Main Street"])).toBe("was going straight, on Main Street");
    // words inside a clause, such as a repeated name, are never collapsed
    expect(joinClauses(["northbound on Walla Walla Road"])).toBe("northbound on Walla Walla Road");
    expect(joinClauses(["your car (A)", "was parked", "facing south on Walla Walla Road"])).toBe("your car (A), was parked, facing south on Walla Walla Road");
    expect(joinClauses(["  spaced   out ", "", "clauses"])).toBe("spaced out, clauses");
  });
});
