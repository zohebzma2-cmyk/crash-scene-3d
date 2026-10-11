// Catalog 3D models (GLB) through our own proxy (round B), the one client of PROXY_ROUTES.vehicleModel:
//   GET /api/vehicles/model?make=&model=[&year=]  ->  model/gltf-binary (MEDIA_HEADERS.watermarked: "true" when the
//   provider's free-tier mark is in the mesh), or 200 JSON {fallback: true, reason} (MEDIA_HEADERS.fallback too).
// The URL comes from media.ts's `vehicleModelUrl` (it checks the make and model text, leaves the year out when it
// isn't known and never asks about a motorcycle). Anything but a GLB keeps our low-poly model, silently.
// A "there is no model" answer (no-make, no-model, moto-not-in-plan) is remembered for a while; a passing one
// (quota, busy, upstream, not-configured) or an error isn't, so the next viewer opening asks again.
import { MEDIA_HEADERS, PROXY_ROUTES, type MediaFallbackReason } from "@csd/core";
import { API_TIMEOUT_MS, type FetchLike } from "./http";
import { vehicleModelUrl, type VehicleRef } from "./media";

export type VehicleModelQuery = VehicleRef;

export interface VehicleModelAsset {
  readonly bytes: ArrayBuffer;
  readonly watermarked: boolean;
}

export interface VehicleModelsService {
  /** The catalog GLB for a vehicle, or null when there is none (or it couldn't be had). Rejects only with an AbortError. */
  load(q: VehicleModelQuery, signal?: AbortSignal): Promise<VehicleModelAsset | null>;
}

/** Largest GLB we accept (the provider's models are ~1.4 MB). */
export const MAX_MODEL_BYTES = 12_000_000;

/** How many fetched models the session keeps (each up to MAX_MODEL_BYTES). */
export const CACHE_MODELS = 4;

/** How long a "no catalog model" answer is remembered in this session. */
export const NO_MODEL_TTL_MS = 30 * 60_000;

/** Fallback reasons that mean "this vehicle has no catalog model": remembered. The others are passing. */
export const LASTING_FALLBACKS: readonly MediaFallbackReason[] = ["no-make", "no-model", "moto-not-in-plan"];

/** A query worth asking about: a URL can be made (a usable make and model, not a motorcycle). */
export const askable = (q: VehicleModelQuery): boolean => vehicleModelUrl(q) !== null;

/** The session key of a query: its URL. */
export const modelKey = (q: VehicleModelQuery): string => vehicleModelUrl(q) ?? "";

const isGlb = (b: ArrayBuffer): boolean => b.byteLength >= 20 && new DataView(b).getUint32(0, true) === 0x46546c67;   // "glTF"

interface Answer { readonly asset: VehicleModelAsset | null; /** The route said there is no model for this vehicle (not a passing failure). */ readonly noModel: boolean }

export function createVehicleModelsService(fetchFn: FetchLike, timeoutMs = API_TIMEOUT_MS * 2, now: () => number = () => Date.now()): VehicleModelsService {
  const cache = new Map<string, Promise<VehicleModelAsset | null>>();
  const noModel = new Map<string, number>();
  return {
    load(q, signal) {
      const url = vehicleModelUrl(q);
      if (!url) return Promise.resolve(null);
      if (signal?.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
      const none = noModel.get(url);
      if (none !== undefined && now() - none < NO_MODEL_TTL_MS) return Promise.resolve(null);
      let p = cache.get(url);
      if (!p) {
        const answer = fetchModel(fetchFn, url, timeoutMs);
        p = answer.then((a) => a.asset);
        cache.set(url, p);
        // A few models are kept for the session (a viewer reopened, two vehicles of the same model); older ones go.
        while (cache.size > CACHE_MODELS) cache.delete(cache.keys().next().value!);
        void answer.then((a) => {
          if (a.asset) return;
          cache.delete(url);
          if (a.noModel) noModel.set(url, now());
        });
      }
      if (!signal) return p;
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(new DOMException("aborted", "AbortError"));
        signal.addEventListener("abort", onAbort, { once: true });
        p.then((r) => { signal.removeEventListener("abort", onAbort); if (!signal.aborted) resolve(r); });
      });
    },
  };
}

async function fetchModel(fetchFn: FetchLike, url: string, timeoutMs: number): Promise<Answer> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const none = (lasting: boolean): Answer => ({ asset: null, noModel: lasting });
  try {
    const res = await fetchFn(url, { signal: ctrl.signal, credentials: "omit", headers: { Accept: "model/gltf-binary, application/json" } });
    if (!res.ok) return none(false);
    const type = res.headers.get("content-type") ?? "";
    if (/json/i.test(type)) {
      // {fallback: true, reason}: lasting only when the reason says this vehicle has no model.
      const body = (await res.json().catch(() => null)) as { fallback?: unknown; reason?: unknown } | null;
      const reason = (typeof body?.reason === "string" ? body.reason : res.headers.get(MEDIA_HEADERS.fallback)) as MediaFallbackReason | null;
      return none(body?.fallback === true && reason !== null && LASTING_FALLBACKS.includes(reason));
    }
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len > MAX_MODEL_BYTES) return none(false);
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength > MAX_MODEL_BYTES || !isGlb(bytes)) return none(false);
    return { asset: { bytes, watermarked: res.headers.get(MEDIA_HEADERS.watermarked) === "true" }, noModel: false };
  } catch {
    return none(false);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fixtures mode: a fetch for the model route that answers like the proxy. Two synthetic models built by
 * scripts/make-fixture-glb.mjs, for make "Synthetic": "Box car" (named Body / Glass / Tire materials) and "Baked car"
 * (one material, paint baked into its texture, like the catalog's), both marked watermarked so the note is exercised.
 * Every other request goes to `next` (roundB/images' media fixtures, which follow ?media=).
 */
export function createFixtureModelFetch(urls: Readonly<Record<string, () => Promise<string>>>, next: FetchLike): FetchLike {
  const files: Record<string, string> = { "synthetic|box car": "synthetic-box-car.glb", "synthetic|baked car": "synthetic-baked-car.glb" };
  return async (input, init) => {
    const [path, query = ""] = input.split("?");
    if (path !== PROXY_ROUTES.vehicleModel) return next(input, init);
    const q = new URLSearchParams(query);
    const name = files[`${(q.get("make") ?? "").toLowerCase()}|${(q.get("model") ?? "").toLowerCase()}`];
    const entry = name ? Object.entries(urls).find(([p]) => p.endsWith(`/${name}`)) : undefined;
    if (!entry) return next(input, init);
    const url = await entry[1]();
    let bytes: ArrayBuffer;
    if (url.startsWith("data:")) {
      // Vite inlines a small asset as a data: URL, and connect-src 'self' doesn't allow fetching one: decode it here.
      const bin = atob(url.slice(url.indexOf(",") + 1));
      bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0)).buffer;
    } else {
      const res = await fetch(url, init?.signal ? { signal: init.signal } : undefined);
      if (!res.ok) return next(input, init);
      bytes = await res.arrayBuffer();
    }
    return new Response(bytes, { status: 200, headers: { "content-type": "model/gltf-binary", [MEDIA_HEADERS.watermarked]: "true" } });
  };
}
