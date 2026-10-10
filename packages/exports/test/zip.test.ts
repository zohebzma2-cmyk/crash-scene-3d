import { describe, expect, it } from "vitest";
import { crc32, unzipStored, zipFiles } from "../src/zip";

const enc = (s: string) => new TextEncoder().encode(s);

describe("stored zip", () => {
  it("computes the standard CRC-32", () => {
    expect(crc32(enc("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it("round-trips names and bytes exactly, in order", () => {
    const files = [
      { name: "crash-scene-CLM-EX-1001.json", bytes: enc('{"a":1}') },
      { name: "crash-scene-CLM-EX-1001.pdf", bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 255, 7]) },
      { name: "crash-scene-CLM-EX-1001-diagram.png", bytes: new Uint8Array(70_000).map((_, i) => (i * 31) & 255) },
    ];
    const zip = zipFiles(files, new Date("2026-10-09T20:52:18Z"));
    expect([...zip.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const back = unzipStored(zip);
    expect(back.map((f) => f.name)).toEqual(files.map((f) => f.name));
    back.forEach((f, i) => expect([...f.bytes]).toEqual([...files[i]!.bytes]));
  });

  it("refuses unsafe names and detects damage", () => {
    expect(() => zipFiles([{ name: "../x.json", bytes: enc("{}") }], new Date())).toThrow(/name/);
    expect(() => zipFiles([{ name: "a/b.json", bytes: enc("{}") }], new Date())).toThrow(/name/);
    const zip = zipFiles([{ name: "a.json", bytes: enc("{\"x\":1}") }], new Date());
    zip[31 + "a.json".length] = (zip[31 + "a.json".length] ?? 0) ^ 0xff; // flip a data byte
    expect(() => unzipStored(zip)).toThrow(/damaged/);
    expect(() => unzipStored(enc("not a zip"))).toThrow(/zip/);
  });
});
