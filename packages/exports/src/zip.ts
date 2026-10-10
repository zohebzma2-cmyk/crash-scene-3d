// A minimal ZIP writer (stored, no compression): one download that works the
// same in Chrome, Safari and iOS, where several downloads from one tap are
// blocked or only the first one is kept. PNG and PDF are already compressed,
// so storing costs little. Pure TS, no DOM: runs in the browser and in Node.

export interface ZipEntry {
  readonly name: string;
  readonly bytes: Uint8Array;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS date and time (local fields of the given instant, as zip tools expect). */
function dosDateTime(d: Date): { date: number; time: number } {
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
  };
}

const MAX_ENTRY = 0xffffffff;

/** Build a ZIP (method 0, UTF-8 names) holding the entries in order. */
export function zipFiles(entries: readonly ZipEntry[], modified: Date): Uint8Array {
  const enc = new TextEncoder();
  const { date, time } = dosDateTime(modified);
  const names = entries.map((e) => enc.encode(e.name));
  for (const [i, e] of entries.entries()) {
    if (!e.name || e.name.includes("/") || e.name.includes("\\") || e.name.includes("..")) throw new Error("A file in the save has an unusable name.");
    if (e.bytes.length >= MAX_ENTRY || names[i]!.length > 0xffff) throw new Error("A file in the save is too large to put in one download.");
  }
  const local = entries.reduce((n, e, i) => n + 30 + names[i]!.length + e.bytes.length, 0);
  const central = entries.reduce((n, _e, i) => n + 46 + names[i]!.length, 0);
  const out = new Uint8Array(local + central + 22);
  const v = new DataView(out.buffer);
  let o = 0;
  const offsets: number[] = [];
  const crcs = entries.map((e) => crc32(e.bytes));
  const FLAG_UTF8 = 0x0800;
  entries.forEach((e, i) => {
    offsets.push(o);
    v.setUint32(o, 0x04034b50, true); v.setUint16(o + 4, 20, true); v.setUint16(o + 6, FLAG_UTF8, true);
    v.setUint16(o + 8, 0, true); v.setUint16(o + 10, time, true); v.setUint16(o + 12, date, true);
    v.setUint32(o + 14, crcs[i]!, true); v.setUint32(o + 18, e.bytes.length, true); v.setUint32(o + 22, e.bytes.length, true);
    v.setUint16(o + 26, names[i]!.length, true); v.setUint16(o + 28, 0, true);
    out.set(names[i]!, o + 30); out.set(e.bytes, o + 30 + names[i]!.length);
    o += 30 + names[i]!.length + e.bytes.length;
  });
  const cdStart = o;
  entries.forEach((e, i) => {
    v.setUint32(o, 0x02014b50, true); v.setUint16(o + 4, 20, true); v.setUint16(o + 6, 20, true); v.setUint16(o + 8, FLAG_UTF8, true);
    v.setUint16(o + 10, 0, true); v.setUint16(o + 12, time, true); v.setUint16(o + 14, date, true);
    v.setUint32(o + 16, crcs[i]!, true); v.setUint32(o + 20, e.bytes.length, true); v.setUint32(o + 24, e.bytes.length, true);
    v.setUint16(o + 28, names[i]!.length, true); v.setUint16(o + 30, 0, true); v.setUint16(o + 32, 0, true);
    v.setUint16(o + 34, 0, true); v.setUint16(o + 36, 0, true); v.setUint32(o + 38, 0, true); v.setUint32(o + 42, offsets[i]!, true);
    out.set(names[i]!, o + 46);
    o += 46 + names[i]!.length;
  });
  v.setUint32(o, 0x06054b50, true); v.setUint16(o + 4, 0, true); v.setUint16(o + 6, 0, true);
  v.setUint16(o + 8, entries.length, true); v.setUint16(o + 10, entries.length, true);
  v.setUint32(o + 12, o - cdStart, true); v.setUint32(o + 16, cdStart, true); v.setUint16(o + 20, 0, true);
  return out;
}

/** Read back a stored ZIP made by zipFiles (tests and the "open a saved file" path). */
export function unzipStored(zip: Uint8Array): ZipEntry[] {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("That isn't a zip file.");
  const count = v.getUint16(eocd + 10, true);
  let o = v.getUint32(eocd + 16, true);
  const dec = new TextDecoder("utf-8", { fatal: true });
  const out: ZipEntry[] = [];
  for (let k = 0; k < count; k++) {
    if (v.getUint32(o, true) !== 0x02014b50) throw new Error("The zip file is damaged.");
    if (v.getUint16(o + 10, true) !== 0) throw new Error("The zip file uses compression this tool doesn't read.");
    const size = v.getUint32(o + 24, true), nameLen = v.getUint16(o + 28, true), extra = v.getUint16(o + 30, true), comment = v.getUint16(o + 32, true);
    const at = v.getUint32(o + 42, true);
    const name = dec.decode(zip.subarray(o + 46, o + 46 + nameLen));
    const lName = v.getUint16(at + 26, true), lExtra = v.getUint16(at + 28, true);
    const data = zip.slice(at + 30 + lName + lExtra, at + 30 + lName + lExtra + size);
    if (crc32(data) !== v.getUint32(o + 16, true)) throw new Error("The zip file is damaged.");
    out.push({ name, bytes: data });
    o += 46 + nameLen + extra + comment;
  }
  return out;
}
