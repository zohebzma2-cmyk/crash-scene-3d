// NHTSA vPIC through our proxy (/api/vehicles/*). Only the make text and the model year are sent.
//
// Request etiquette (docs/PROXY-BUSY.md): one request per make and model year, never per keystroke.
//  - The makes list is fetched once a session; a typed make is matched to it ("chevy" and "Chevrolet " are both
//    Chevrolet) and the model list is asked for under the list's spelling, so every spelling shares one request.
//  - A make the list doesn't know (a half-typed "Chev", a typo) waits a little longer before it is asked for,
//    and the wait is dropped when the claimant types on (the caller's signal).
//  - Model lists are cached for the session (memory and sessionStorage); the model box filters them locally.
//  - A "busy" answer is tried again after its Retry-After, up to 2.5 s in all, before the card says so.
import { MAKE_ALIASES, PROXY_ROUTES, normName, resolveName, type VehicleModelResult } from "@csd/core";
import { abortableSleep, getJsonRetrying, type FetchLike } from "./http";
import { ServiceError, type ModelsOptions, type VehiclesService } from "./types";

/** What the vehicle card shows (followed by "Pick the type below.") when the lookup really failed. */
export const VEHICLE_LOOKUP_MESSAGES = {
  busy: "The vehicle list is busy right now.",
  timeout: "The vehicle list is slow to answer right now.",
  network: "We couldn't reach the vehicle list.",
  other: "We couldn't load the vehicle list right now.",
} as const;

/** Extra wait before asking for a make the makes list doesn't know (on top of the card's own pause). */
export const UNKNOWN_MAKE_WAIT_MS = 800;
/** After the makes list failed (even after the retries), it isn't asked for again for this long. */
export const MAKES_RETRY_AFTER_MS = 30_000;

/** The comparison form of a make: lowercase letters and digits only ("Mercedes-Benz" = "mercedes benz"). */
const squash = normName;

/**
 * The makes list's own spelling of a typed make, by exact name or an everyday name from core's MAKE_ALIASES
 * ("chevy", "vw", "merc", "beemer", "harley"...); null when it isn't one. The picker ranks with the same table.
 */
export function resolveMake(text: string, makes: readonly string[]): string | null {
  if (normName(text).length < 2) return null;
  return resolveName(text, makes, { aliases: MAKE_ALIASES });
}

const STORE_PREFIX = "csd.vpic.v1.";

/** sessionStorage, when the browser lets us (private windows and blocked storage just skip it). */
function sessionGet<T>(key: string): T | null {
  try {
    const raw = globalThis.sessionStorage?.getItem(STORE_PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function sessionSet(key: string, value: unknown): void {
  try {
    globalThis.sessionStorage?.setItem(STORE_PREFIX + key, JSON.stringify(value));
  } catch {
    // full or blocked: the memory cache still holds it for this page
  }
}

/** A failure the card can show as it is: worded for the vehicle list, never "map". */
function vehicleError(e: unknown): unknown {
  if (e instanceof DOMException && e.name === "AbortError") return e;
  if (!(e instanceof ServiceError)) return new ServiceError(VEHICLE_LOOKUP_MESSAGES.other, "upstream");
  const text = e.code === "busy" ? VEHICLE_LOOKUP_MESSAGES.busy
    : e.code === "timeout" ? VEHICLE_LOOKUP_MESSAGES.timeout
    : e.code === "network" ? VEHICLE_LOOKUP_MESSAGES.network
    : VEHICLE_LOOKUP_MESSAGES.other;
  return new ServiceError(text, e.code, e.retryAfterS);
}

/** Resolve with `p`, or reject with an AbortError when `signal` fires first (p itself carries on for others). */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then((v) => { signal.removeEventListener("abort", onAbort); resolve(v); }, (e: unknown) => { signal.removeEventListener("abort", onAbort); reject(e); });
  });
}

export interface VehiclesDeps {
  readonly sleep?: (ms: number) => Promise<void>;
}

export function createVehiclesService(fetchFn: FetchLike, deps: VehiclesDeps = {}): VehiclesService {
  let makesPromise: Promise<string[]> | null = null;
  let makesList: string[] | null = null;
  const models = new Map<string, Promise<VehicleModelResult[]>>();
  const sleep = deps.sleep;

  function makes(): Promise<string[]> {
    if (!makesPromise) {
      const stored = sessionGet<string[]>("makes");
      if (Array.isArray(stored) && stored.length > 0) { makesList = stored; makesPromise = Promise.resolve(stored); }
    }
    makesPromise ??= getJsonRetrying<unknown>(fetchFn, PROXY_ROUTES.makes, sleep ? { sleep } : {})
      .then((r) => {
        const list = Array.isArray(r) ? r.filter((m): m is string => typeof m === "string") : [];
        makesList = list;
        if (list.length > 0) sessionSet("makes", list);
        return list;
      })
      .catch((e: unknown) => {
        // Keep the failure for a while: asking again on every lookup is the traffic this service exists to avoid.
        const failed = makesPromise;
        setTimeout(() => { if (makesPromise === failed) makesPromise = null; }, MAKES_RETRY_AFTER_MS);
        throw vehicleError(e);
      });
    return makesPromise;
  }

  /** One request per make and year for the whole session, shared by every card that asks. */
  function modelList(make: string, year: number): Promise<VehicleModelResult[]> {
    const key = `${year}|${squash(make)}`;
    let p = models.get(key);
    if (p) return p;
    const stored = sessionGet<VehicleModelResult[]>(`models.${key}`);
    if (Array.isArray(stored)) {
      p = Promise.resolve(stored);
    } else {
      p = getJsonRetrying<unknown>(fetchFn, `${PROXY_ROUTES.models}?${new URLSearchParams({ make, year: String(year) })}`, sleep ? { sleep } : {})
        .then((r) => {
          const list = Array.isArray(r) ? (r as VehicleModelResult[]) : [];
          sessionSet(`models.${key}`, list);
          return list;
        })
        .catch((e: unknown) => { models.delete(key); throw vehicleError(e); });
    }
    models.set(key, p);
    return p;
  }

  return {
    makes,
    canonicalMake(text) {
      return makesList ? resolveMake(text, makesList) : null;
    },
    async models(make, year, opts: ModelsOptions = {}) {
      const typed = make.trim();
      // The makes list is fetched once; without it (it failed) the typed text is asked for as it is, after the
      // same longer pause as an unknown make, so a half-typed make still isn't asked for.
      const list = await untilAborted(makes().catch((): string[] => []), opts.signal);
      const known = resolveMake(typed, list);
      if (!known) await abortableSleep(UNKNOWN_MAKE_WAIT_MS, opts.signal, sleep);
      return untilAborted(modelList(known ?? typed, year), opts.signal);
    },
  };
}
