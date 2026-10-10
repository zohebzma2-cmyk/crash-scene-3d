// A small PNG reader so the 3D stills can be drawn onto our canvas without the
// canvas needing an image decoder (the injected CanvasFactory only creates,
// draws and encodes). Handles 8 and 16 bit grey, grey+alpha, RGB, RGBA and
// palette images that are not interlaced, which covers what a browser's
// canvas.toBlob produces. Input is untrusted, so sizes are capped before
// anything is allocated and inflating stops at the size the header promises.
export interface DecodedPng { readonly width: number; readonly height: number; readonly rgba: Uint8ClampedArray }

/** Largest picture we accept, per side. */
export const MAX_PNG_SIDE = 4096;
const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

/** Inflate zlib data, refusing to produce more than `expected` bytes. */
async function inflateExactly(data: Uint8Array, expected: number): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
  const reader = stream.getReader();
  const out = new Uint8Array(expected);
  let got = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (got + value.length > expected) throw new Error("The PNG holds more picture data than its size allows.");
      out.set(value, got);
      got += value.length;
    }
  } catch (e) {
    await reader.cancel().catch(() => undefined);
    if (e instanceof Error && /allows/.test(e.message)) throw e;
    throw new Error("The PNG data is damaged.");
  }
  if (got < expected) throw new Error("The PNG data is cut short.");
  return out;
}

export async function decodePng(bytes: Uint8Array): Promise<DecodedPng> {
  if (bytes.length < 33 || SIGNATURE.some((b, i) => bytes[i] !== b)) throw new Error("It isn't a PNG picture.");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  let width = 0, height = 0, depth = 0, ctype = 0, interlace = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let first = true;
  let ended = false;
  while (pos + 8 <= bytes.length) {
    const len = dv.getUint32(pos);
    const type = String.fromCharCode(bytes[pos + 4]!, bytes[pos + 5]!, bytes[pos + 6]!, bytes[pos + 7]!);
    if (pos + 12 + len > bytes.length) throw new Error("The PNG is cut short.");
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (first) {
      if (type !== "IHDR" || len !== 13) throw new Error("The PNG header is damaged.");
      first = false;
      width = dv.getUint32(pos + 8);
      height = dv.getUint32(pos + 12);
      depth = data[8]!;
      ctype = data[9]!;
      interlace = data[12]!;
      if (!width || !height) throw new Error("The PNG has no size.");
      if (width > MAX_PNG_SIDE || height > MAX_PNG_SIDE) throw new Error(`The PNG is too large (${MAX_PNG_SIDE} pixels is the most on a side).`);
      if (!DEPTHS[ctype]?.includes(depth)) throw new Error("This kind of PNG isn't supported.");
      if (data[10] !== 0 || data[11] !== 0) throw new Error("This kind of PNG isn't supported.");
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") { ended = true; break; }
    pos += 12 + len;
  }
  if (first) throw new Error("The PNG header is damaged.");
  if (!ended || idat.length === 0) throw new Error("The PNG is cut short.");
  if (interlace !== 0) throw new Error("Interlaced PNGs aren't supported.");
  const channels = CHANNELS[ctype]!;
  const total = idat.reduce((a, c) => a + c.length, 0);
  const joined = new Uint8Array(total);
  let o = 0;
  for (const c of idat) { joined.set(c, o); o += c.length; }
  const bitsPerPixel = channels * depth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const raw = await inflateExactly(joined, (stride + 1) * height);
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x]!;
      const a = x >= bpp ? px[dst + x - bpp]! : 0;
      const b = y > 0 ? px[dst - stride + x]! : 0;
      const c = x >= bpp && y > 0 ? px[dst - stride + x - bpp]! : 0;
      let r: number;
      switch (f) {
        case 0: r = v; break;
        case 1: r = v + a; break;
        case 2: r = v + b; break;
        case 3: r = v + ((a + b) >> 1); break;
        case 4: { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); break; }
        default: throw new Error("The PNG has a bad filter.");
      }
      px[dst + x] = r & 255;
    }
  }
  const rgba = new Uint8ClampedArray(width * height * 4);
  const sample = (row: number, idx: number): number => {
    // idx-th sample in the row; 16 bit keeps the high byte
    if (depth === 16) return px[row * stride + idx * 2]!;
    if (depth === 8) return px[row * stride + idx]!;
    const per = 8 / depth;
    const byte = px[row * stride + Math.floor(idx / per)]!;
    return (byte >> (8 - depth * ((idx % per) + 1))) & ((1 << depth) - 1);
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (ctype === 6) { for (let k = 0; k < 4; k++) rgba[i + k] = sample(y, x * 4 + k); }
      else if (ctype === 2) { for (let k = 0; k < 3; k++) rgba[i + k] = sample(y, x * 3 + k); rgba[i + 3] = 255; }
      else if (ctype === 0) { const g = sample(y, x); rgba[i] = rgba[i + 1] = rgba[i + 2] = depth < 8 ? Math.round((g * 255) / ((1 << depth) - 1)) : g; rgba[i + 3] = 255; }
      else if (ctype === 4) { const g = sample(y, x * 2); rgba[i] = rgba[i + 1] = rgba[i + 2] = g; rgba[i + 3] = sample(y, x * 2 + 1); }
      else {
        const idx = sample(y, x);
        if (!palette || idx * 3 + 2 >= palette.length) throw new Error("The PNG palette is missing.");
        rgba[i] = palette[idx * 3]!; rgba[i + 1] = palette[idx * 3 + 1]!; rgba[i + 2] = palette[idx * 3 + 2]!;
        rgba[i + 3] = trns && idx < trns.length ? trns[idx]! : 255;
      }
    }
  }
  return { width, height, rgba };
}
