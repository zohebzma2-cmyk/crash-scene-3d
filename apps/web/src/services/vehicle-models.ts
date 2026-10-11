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

/** Largest GLB we accept (the provider's models are ~1.4 MB). */
export const MAX_MODEL_BYTES = 12_000_000;

/** A query worth asking about: a make and a model typed. */
export const askable = (q: VehicleModelQuery): boolean => q.make.trim().length > 0 && q.model.trim().length > 0;

export const modelKey = (q: VehicleModelQuery): string => `${q.year ?? ""}|${q.make.trim().toLowerCase()}|${q.model.trim().toLowerCase()}`;

const isGlb = (b: ArrayBuffer): boolean => b.byteLength >= 20 && new DataView(b).getUint32(0, true) === 0x46546c67;   // "glTF"
const truthy = (v: string | null): boolean => v != null && /^(1|true|yes)$/i.test(v.trim());

export function createVehicleModelsService(fetchFn: FetchLike, timeoutMs = API_TIMEOUT_MS * 2): VehicleModelsService {
  const cache = new Map<string, Promise<VehicleModelAsset | null>>();
  return {
    load(q, signal) {
      if (!askable(q)) return Promise.resolve(null);
      if (signal?.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
      const key = modelKey(q);
      let p = cache.get(key);
      if (!p) {
        p = fetchModel(fetchFn, q, timeoutMs);
        cache.set(key, p);
        // A failure isn't remembered: the next viewer opening asks again.
        void p.then((r) => { if (!r) cache.delete(key); });
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

async function fetchModel(fetchFn: FetchLike, q: VehicleModelQuery, timeoutMs: number): Promise<VehicleModelAsset | null> {
  const params = new URLSearchParams({ year: q.year == null ? "" : String(q.year), make: q.make.trim(), model: q.model.trim() });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(`${MODEL_ROUTE}?${params}`, { signal: ctrl.signal, credentials: "omit", headers: { Accept: "model/gltf-binary, application/json" } });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    if (/json/i.test(type)) return null;            // {"fallback": true} or a ProxyError: our own model
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len > MAX_MODEL_BYTES) return null;
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength > MAX_MODEL_BYTES || !isGlb(bytes)) return null;
    return { bytes, watermarked: truthy(res.headers.get("watermarked")) || truthy(res.headers.get("x-watermarked")) };
  } catch {
    return null;
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
