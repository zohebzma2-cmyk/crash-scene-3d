// Canonical JSON (sorted keys, no whitespace, UTF-8) and its SHA-256: the
// fingerprint printed on every export. Uses Web Crypto (browser and Node 22+).
/** How many levels of arrays and objects a saved scene may nest. A real scene is about 6 deep. */
export const MAX_CANONICAL_DEPTH = 64;

export function canonicalJson(value: unknown): string {
  return canon(value, 0);
}

function canon(value: unknown, depth: number): string {
  const isContainer = value !== null && typeof value === "object";
  if (isContainer && depth >= MAX_CANONICAL_DEPTH) throw new Error("This scene is nested too deeply to save.");
  if (Array.isArray(value)) return `[${value.map((v) => canon(v, depth + 1)).join(",")}]`;
  if (isContainer) {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().filter((k) => obj[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canon(obj[k], depth + 1)}`).join(",")}}`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Scene contains a number that isn't finite.");
  return JSON.stringify(value);
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** First 16 hex characters in groups of four: "a3f9 1c2e 77b0 4d18". */
export function shortFingerprint(hex: string): string {
  return (hex.slice(0, 16).match(/.{4}/g) ?? []).join(" ");
}
