import { createHash } from "node:crypto";

/** The caller's IP as Netlify (or a proxy in front) reports it; "unknown" when absent. */
export function clientIp(req: Request): string {
  const nf = req.headers.get("x-nf-client-connection-ip");
  if (nf) return nf.trim();
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return (fwd.split(",")[0] ?? "").trim() || "unknown";
  return "unknown";
}

/**
 * What identifies one caller for rate limits. IPv4 as is; IPv6 by its /64 (one household or
 * device owns a whole /64 and can rotate through it freely, so single addresses would let one
 * person dodge the limit); IPv4-mapped IPv6 as the IPv4 address.
 */
export function limitIdentity(ip: string): string {
  const s = ip.trim().toLowerCase().split("%")[0] as string;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (mapped) return mapped[1] as string;
  if (!s.includes(":")) return s;
  const [headText = "", tailText] = s.split("::");
  const head = headText === "" ? [] : headText.split(":");
  const tail = tailText === undefined || tailText === "" ? [] : tailText.split(":");
  const groups = tailText === undefined ? head : [...head, ...Array<string>(Math.max(0, 8 - head.length - tail.length)).fill("0"), ...tail];
  return `${groups.slice(0, 4).map((g) => g.padStart(4, "0")).join(":")}/64`;
}

/**
 * One-way caller key: SHA-256 of the caller identity + the UTC date (a daily salt, so keys can't
 * be followed across days) + a server-side secret. Raw IPs are never stored or logged.
 */
export function hashUserKey(ip: string, nowMs: number, secret = ""): string {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  return createHash("sha256").update(`${secret}|${day}|${limitIdentity(ip)}`).digest("hex").slice(0, 32);
}

/**
 * The secret for hashUserKey comes from PROXY_USER_SALT. In production it is required: hashing
 * with no secret would make caller keys guessable (IPv4 space is small enough to enumerate). An
 * empty salt is accepted only under `netlify dev`, with the memory store, or in tests.
 */
export function resolveSalt(env: Readonly<Record<string, string | undefined>>): { ok: true; salt: string } | { ok: false } {
  const salt = env.PROXY_USER_SALT ?? "";
  if (salt !== "") return { ok: true, salt };
  const local = env.NETLIFY_DEV === "true" || env.NETLIFY_LOCAL_MEMORY_STORE === "1" || env.VITEST !== undefined || env.NODE_ENV === "test";
  return local ? { ok: true, salt: "" } : { ok: false };
}
