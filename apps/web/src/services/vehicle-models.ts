// Catalog 3D models (GLB) through our own proxy (round B). The route belongs to roundB/images:
//   GET /api/vehicles/model?year=&make=&model=  ->  GLB bytes (model/gltf-binary), or JSON {"fallback": true}
// A `watermarked` response header (or `x-watermarked`) set to 1/true marks a watermarked preview.
// Anything else (an error, a timeout, a body that isn't a GLB) is a fallback too: the viewer keeps our low-poly
// model, so a missing catalog model never shows as an error. Only the year, make and model text are sent.
import { API_TIMEOUT_MS, type FetchLike } from "./http";

/** Mirrors the proxy route of roundB/images; move to PROXY_ROUTES when the branches meet. */
export const MODEL_ROUTE = "/api/vehicles/model";

export interface VehicleModelQuery {
  readonly year: number | null;
  readonly make: string;
  readonly model: string;
}

export interface VehicleModelAsset {
  readonly bytes: ArrayBuffer;
  readonly watermarked: boolean;
}

export interface VehicleModelsService {
  /** The catalog GLB for a vehicle, or null when there is none (or it couldn't be had). Rejects only with an AbortError. */
  load(q: VehicleModelQuery, signal?: AbortSignal): Promise<VehicleModelAsset | null>;
}

/** How many fetched models the session keeps (each up to MAX_MODEL_BYTES). */
export const CACHE_MODELS = 4;

/** Largest GLB we accept (the provider's models are ~1.4 MB). */
export const MAX_MODEL_BYTES = 12_000_000;

/** A query worth asking about: a make and a model typed. */
export const askable = (q: VehicleModelQuery): boolean => q.make.trim().length > 0 && q.model.trim().length > 0;

export const modelKey = (q: VehicleModelQuery): string => `${q.year ?? ""}|${q.make.trim().toLowerCase()}|${q.model.trim().toLowerCase()}`;

const isGlb = (b: ArrayBuffer): boolean => b.byteLength >= 20 && new DataView(b).getUint32(0, true) === 0x46546c67;   // "glTF"
const truthy = (v: string | null): boolean => v != null && /^(1|true|yes)$/i.test(v.trim());

/** How long a "no catalog model" answer is remembered in this session. */
export const NO_MODEL_TTL_MS = 30 * 60_000;

export function createVehicleModelsService(fetchFn: FetchLike, timeoutMs = API_TIMEOUT_MS * 2, now: () => number = () => Date.now()): VehicleModelsService {
  const cache = new Map<string, Promise<VehicleModelAsset | null>>();
  const noModel = new Map<string, number>();
  return {
    load(q, signal) {
      if (!askable(q)) return Promise.resolve(null);
      if (signal?.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
      const key = modelKey(q);
      const none = noModel.get(key);
      if (none !== undefined && now() - none < NO_MODEL_TTL_MS) return Promise.resolve(null);
      let p = cache.get(key);
      if (!p) {
        const answer = fetchModel(fetchFn, q, timeoutMs);
        p = answer.then((a) => a.asset);
        cache.set(key, p);
        // A few models are kept for the session (a viewer reopened, two vehicles of the same model); older ones go.
        while (cache.size > CACHE_MODELS) cache.delete(cache.keys().next().value!);
        void answer.then((a) => {
          if (a.asset) return;
          cache.delete(key);
          // "No model for this vehicle" is remembered for a while, so each viewer opening doesn't ask again;
          // an error (network, timeout, a 5xx) isn't, so the next opening tries again.
          if (a.noModel) noModel.set(key, now());
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

interface Answer { readonly asset: VehicleModelAsset | null; /** The route said there is no model (not an error). */ readonly noModel: boolean }

async function fetchModel(fetchFn: FetchLike, q: VehicleModelQuery, timeoutMs: number): Promise<Answer> {
  const params = new URLSearchParams({ year: q.year == null ? "" : String(q.year), make: q.make.trim(), model: q.model.trim() });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const none = (noModel: boolean): Answer => ({ asset: null, noModel });
  try {
    const res = await fetchFn(`${MODEL_ROUTE}?${params}`, { signal: ctrl.signal, credentials: "omit", headers: { Accept: "model/gltf-binary, application/json" } });
    if (res.status === 404) return none(true);
    if (!res.ok) return none(false);
    const type = res.headers.get("content-type") ?? "";
    if (/json/i.test(type)) {
      // {"fallback": true}: no catalog model for this vehicle. Any other JSON (a ProxyError) is an error.
      const body = (await res.json().catch(() => null)) as { fallback?: unknown } | null;
      return none(body?.fallback === true);
    }
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len > MAX_MODEL_BYTES) return none(true);
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength > MAX_MODEL_BYTES || !isGlb(bytes)) return none(true);
    return { asset: { bytes, watermarked: truthy(res.headers.get("watermarked")) || truthy(res.headers.get("x-watermarked")) }, noModel: false };
  } catch {
    return none(false);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fixtures mode: never calls /api. Two synthetic models built by scripts/make-fixture-glb.mjs, for make "Synthetic":
 * "Box car" (named Body / Glass / Tire materials) and "Baked car" (one material, paint baked into its texture, like
 * the catalog's). Both are marked watermarked so the caption is exercised. Every other vehicle gets our own model.
 */
export function createFixtureVehicleModels(urls: Readonly<Record<string, () => Promise<string>>>, fetchFn: FetchLike): VehicleModelsService {
  const files: Record<string, string> = { "synthetic|box car": "synthetic-box-car.glb", "synthetic|baked car": "synthetic-baked-car.glb" };
  return {
    async load(q, signal) {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      const name = files[`${q.make.trim().toLowerCase()}|${q.model.trim().toLowerCase()}`];
      const entry = name ? Object.entries(urls).find(([path]) => path.endsWith(`/${name}`)) : undefined;
      if (!entry) return null;
      const url = await entry[1]();
      let bytes: ArrayBuffer;
      if (url.startsWith("data:")) {
        // Vite inlines a small asset as a data: URL, and connect-src 'self' doesn't allow fetching one: decode it here.
        const bin = atob(url.slice(url.indexOf(",") + 1));
        bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0)).buffer;
      } else {
        const res = await fetchFn(url, signal ? { signal } : undefined);
        if (!res.ok) return null;
        bytes = await res.arrayBuffer();
      }
      return isGlb(bytes) ? { bytes, watermarked: true } : null;
    },
  };
}
