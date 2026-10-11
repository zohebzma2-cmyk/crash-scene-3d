// The only place the browser talks to the network, and only to its own origin (/api/*).
import { TIMEOUT_MESSAGE, type ProxyError, type ProxyErrorCode } from "@csd/core";
import { ServiceError, type ServiceErrorCode } from "./types";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Every /api call gives up after this. The proxy always answers (with a JSON ProxyError at worst) by about 8 s. */
export const API_TIMEOUT_MS = 9500;

export const NETWORK_MESSAGE = "We couldn't reach the map service. Check your connection and try again.";
export const GENERIC_MESSAGE = "Something went wrong with the map service. Please try again in a moment.";

const PROXY_CODES: readonly ProxyErrorCode[] = ["busy", "timeout", "upstream", "bad-request", "not-found"];

function asProxyError(body: unknown): ProxyError | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.message !== "string" || typeof b.code !== "string") return null;
  if (!PROXY_CODES.includes(b.code as ProxyErrorCode)) return null;
  return { code: b.code as ProxyErrorCode, message: b.message, ...(typeof b.retryAfterS === "number" ? { retryAfterS: b.retryAfterS } : {}) };
}

/** GET JSON from our own /api. Failures become ServiceError with a message that is safe to show as text. */
export async function getJson<T>(fetchFn: FetchLike, url: string, timeoutMs = API_TIMEOUT_MS, signal?: AbortSignal): Promise<T> {
  if (!url.startsWith("/api/")) throw new ServiceError(GENERIC_MESSAGE, "bad-request");
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  // The caller giving up (a newer keystroke) is not a timeout: it stays an AbortError for the caller to ignore.
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  let res: Response;
  try {
    res = await fetchFn(url, { signal: ctrl.signal, credentials: "omit", headers: { Accept: "application/json" } });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      if (signal?.aborted) throw e;
      throw new ServiceError(TIMEOUT_MESSAGE, "timeout");
    }
    throw new ServiceError(NETWORK_MESSAGE, "network");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  if (!res.ok) {
    let body: unknown = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    const pe = asProxyError(body);
    const code: ServiceErrorCode = pe?.code ?? (res.status === 429 ? "busy" : "upstream");
    // The body's retryAfterS, else the Retry-After header (seconds).
    const header = Number(res.headers.get("retry-after"));
    const retryAfterS = pe?.retryAfterS ?? (Number.isFinite(header) && header >= 0 && res.headers.has("retry-after") ? header : undefined);
    throw new ServiceError(pe?.message ?? GENERIC_MESSAGE, code, retryAfterS);
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new ServiceError(GENERIC_MESSAGE, "bad-response");
  }
}

/** GET bytes (terrain tiles) from our own /api. */
export async function getBytes(fetchFn: FetchLike, url: string, timeoutMs = API_TIMEOUT_MS): Promise<Uint8Array> {
  if (!url.startsWith("/api/")) throw new ServiceError(GENERIC_MESSAGE, "bad-request");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { signal: ctrl.signal, credentials: "omit" });
    if (!res.ok) throw new ServiceError(GENERIC_MESSAGE, "upstream");
    return new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    if (e instanceof ServiceError) throw e;
    if (e instanceof DOMException && e.name === "AbortError") throw new ServiceError(TIMEOUT_MESSAGE, "timeout");
    throw new ServiceError(NETWORK_MESSAGE, "network");
  } finally {
    clearTimeout(timer);
  }
}
