// The only place the browser talks to the network, and only to its own origin (/api/*).
import { TIMEOUT_MESSAGE, type ProxyError, type ProxyErrorCode } from "@csd/core";
import { ServiceError, type ServiceErrorCode } from "./types";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Every /api call gives up after this. The proxy's own per-request deadline is 9.3 s (config.ts limits.timeoutMs),
 * so it always answers (with a JSON ProxyError at worst) by then; the browser waits a little longer so it receives
 * that answer — a worded "roads couldn't load" notice — rather than aborting first into a bare network error.
 */
export const API_TIMEOUT_MS = 10000;

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

/** A "busy" answer is tried again after its Retry-After until this much time has passed since the first try; only then is it shown. */
export const BUSY_TOTAL_WAIT_MS = 2500;
/** The shortest wait before a retry, and the one used when the proxy sends no Retry-After. */
const BUSY_MIN_WAIT_MS = 250;
const BUSY_DEFAULT_WAIT_MS = 1000;

export interface RetryOptions {
  readonly signal?: AbortSignal;
  /** Called before each retry (the UI may say "Busy, trying again…"). */
  readonly onBusy?: () => void;
  /** Wall time from the first try after which a busy answer is no longer retried (default BUSY_TOTAL_WAIT_MS). */
  readonly maxWaitMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Clock for the budget (ms; default Date.now). */
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

const abortError = () => new DOMException("aborted", "AbortError");
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Wait `ms`, or reject with an AbortError as soon as `signal` fires. */
export function abortableSleep(ms: number, signal?: AbortSignal, sleep: (ms: number) => Promise<void> = defaultSleep): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  if (!signal) return sleep(ms);
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    sleep(ms).then(() => { signal.removeEventListener("abort", onAbort); resolve(); }, reject);
  });
}

/**
 * Run `attempt`; a "busy" (429) failure is tried again after its Retry-After (at least 0.25 s, 1 s when none
 * is given), as many times as fit in `maxWaitMs` of waiting. The last busy error is thrown only after that.
 */
export async function retryBusy<T>(attempt: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const budget = opts.maxWaitMs ?? BUSY_TOTAL_WAIT_MS;
  const now = opts.now ?? Date.now;
  const start = now();
  let waited = 0;
  for (;;) {
    try {
      return await attempt();
    } catch (e) {
      if (!(e instanceof ServiceError) || e.code !== "busy") throw e;
      const wait = Math.max(BUSY_MIN_WAIT_MS, e.retryAfterS !== undefined ? e.retryAfterS * 1000 : BUSY_DEFAULT_WAIT_MS);
      // The budget is wall time from the first try (the proxy may already have queued each try for a while),
      // or the time slept when the clock doesn't move (an injected sleep), whichever is more. The proxy's
      // Retry-After is rounded up to whole seconds: if it doesn't fit, wait what is left instead.
      const left = budget - Math.max(waited, now() - start);
      if (left < BUSY_MIN_WAIT_MS) throw e;
      const ms = Math.min(wait, left);
      opts.onBusy?.();
      await abortableSleep(ms, opts.signal, opts.sleep);
      waited += ms;
    }
  }
}

/** getJson with retryBusy: what every /api JSON call should use unless it has its own retry. */
export function getJsonRetrying<T>(fetchFn: FetchLike, url: string, opts: RetryOptions = {}): Promise<T> {
  return retryBusy(() => getJson<T>(fetchFn, url, opts.timeoutMs ?? API_TIMEOUT_MS, opts.signal), opts);
}

/** GET bytes (terrain tiles) from our own /api. */
export async function getBytes(fetchFn: FetchLike, url: string, timeoutMs = API_TIMEOUT_MS): Promise<Uint8Array> {
  if (!url.startsWith("/api/")) throw new ServiceError(GENERIC_MESSAGE, "bad-request");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { signal: ctrl.signal, credentials: "omit" });
    if (res.status === 429) {
      const header = Number(res.headers.get("retry-after"));
      throw new ServiceError(GENERIC_MESSAGE, "busy", res.headers.has("retry-after") && Number.isFinite(header) && header >= 0 ? header : undefined);
    }
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
