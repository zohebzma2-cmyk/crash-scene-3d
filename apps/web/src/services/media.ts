// Vehicle photos, 3D models and maker logos from our own /api (packages/proxy/src/media.ts). The browser never
// talks to a photo or logo provider: every URL here is same-origin, so the CSP stays 'self'. Only the year,
// make and model text are sent, and only once a make (logo) or a make and model (photo) has been picked.
//
// Every failure is "use our own picture": a 204, a JSON {fallback:true}, a 429, a timeout or no network all
// come back as null. Nothing here throws at the UI.
import { MEDIA_HEADERS, PROXY_ROUTES, type VehicleImageView, type VehicleType } from "@csd/core";
import type { CameraView } from "../viewer/types";
import { API_TIMEOUT_MS, type FetchLike } from "./http";

/** What identifies a vehicle for a photo or a model. */
export interface VehicleRef {
  readonly year: number | null;
  readonly make: string;
  readonly model: string;
  readonly type?: VehicleType;
}

export interface MediaAnswer {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  /** Photos: the angle served. */
  readonly view?: VehicleImageView;
  /** Models: the provider's free-tier watermark is baked into the mesh. */
  readonly watermarked?: boolean;
  /** Logos: whose it is (logo.dev's free plan needs a visible credit wherever its logos show). */
  readonly source?: "carimages" | "logodev";
}

export interface ImageOptions {
  readonly view?: VehicleImageView;
  /** 200, 400, 800 or 1200 px. */
  readonly width?: 200 | 400 | 800 | 1200;
}

export interface MediaService {
  vehicleImageUrl(v: VehicleRef, opts?: ImageOptions): string | null;
  vehicleModelUrl(v: VehicleRef): string | null;
  makeLogoUrl(make: string): string | null;
  /** GET once per URL per session (shared by every caller). Null: show our own icon or model. */
  probe(url: string): Promise<MediaAnswer | null>;
  /** A blob: URL for an <img> (img-src allows blob:), made once per URL and kept for the session. */
  objectUrl(url: string): Promise<{ readonly src: string; readonly answer: MediaAnswer } | null>;
  /**
   * The vehicle's front 3/4 photo as PNG bytes for the PDF and the PNG stills (WebP is converted in the
   * browser). `cachedOnly`: only a photo this session already loaded (the export never spends a provider call).
   */
  photoPng(v: VehicleRef, opts?: { cachedOnly?: boolean }): Promise<Uint8Array | null>;
  /** Has a logo.dev logo been shown? Then its credit must be visible on the page. */
  readonly logoCredit: { get(): boolean; subscribe(fn: () => void): () => void };
}

/** The angle for a camera of the 3D viewer (docs/decisions/0011-vehicle-images.md). Front 3/4 is the default. */
export function viewFor(camera: CameraView): VehicleImageView {
  switch (camera) {
    // From above, the side profile reads best as a flat label next to a plan view.
    case "top": return "side";
    // A driver's view looks at the other vehicle coming at it.
    case "driver-a":
    case "driver-b": return "front";
    default: return "front34";
  }
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const MAKE_OK = /^[A-Za-z0-9][A-Za-z0-9 .&'/-]{0,39}$/;
const MODEL_OK = /^[A-Za-z0-9][A-Za-z0-9 .&'/()+-]{0,59}$/;

export function vehicleImageUrl(v: VehicleRef, opts: ImageOptions = {}): string | null {
  const make = clean(v.make);
  const model = clean(v.model);
  if (!MAKE_OK.test(make) || !MODEL_OK.test(model)) return null;
  const q = new URLSearchParams({ make, model });
  if (v.year != null) q.set("year", String(v.year));
  if (opts.view && opts.view !== "front34") q.set("view", opts.view);
  if (opts.width && opts.width !== 400) q.set("width", String(opts.width));
  if (v.type === "motorcycle") q.set("type", "moto");
  return `${PROXY_ROUTES.vehicleImage}?${q}`;
}

export function vehicleModelUrl(v: VehicleRef): string | null {
  const make = clean(v.make);
  const model = clean(v.model);
  if (!MAKE_OK.test(make) || !MODEL_OK.test(model) || v.type === "motorcycle") return null;
  const q = new URLSearchParams({ make, model });
  if (v.year != null) q.set("year", String(v.year));
  return `${PROXY_ROUTES.vehicleModel}?${q}`;
}

export function makeLogoUrl(make: string): string | null {
  const name = clean(make);
  return MAKE_OK.test(name) ? `${PROXY_ROUTES.makeLogo}?${new URLSearchParams({ name })}` : null;
}

/** One answer from a media route, or null for "use our own". Never throws. */
async function fetchAnswer(fetchFn: FetchLike, url: string): Promise<MediaAnswer | null> {
  if (!url.startsWith("/api/")) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, { signal: ctrl.signal, credentials: "omit" });
    if (res.status !== 200) return null;
    const contentType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    // A JSON answer from a media route is a fallback ({fallback:true}); only pictures and models count.
    if (!/^image\/(webp|png|jpeg)$|^model\/gltf-binary$/.test(contentType)) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength === 0) return null;
    const view = res.headers.get(MEDIA_HEADERS.view);
    const source = res.headers.get(MEDIA_HEADERS.logoSource);
    return {
      bytes, contentType,
      ...(view ? { view: view as VehicleImageView } : {}),
      ...(res.headers.has(MEDIA_HEADERS.watermarked) ? { watermarked: res.headers.get(MEDIA_HEADERS.watermarked) === "true" } : {}),
      ...(source === "logodev" || source === "carimages" ? { source } : {}),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** PNG bytes start with this. */
const isPng = (b: Uint8Array) => b.byteLength > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

/** WebP/JPEG to PNG with the browser's own decoder (OffscreenCanvas). Null where the browser can't. */
async function toPng(answer: MediaAnswer): Promise<Uint8Array | null> {
  if (isPng(answer.bytes)) return answer.bytes;
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") return null;
  try {
    const bitmap = await createImageBitmap(new Blob([answer.bytes as BlobPart], { type: answer.contentType }));
    const cv = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = cv.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return new Uint8Array(await (await cv.convertToBlob({ type: "image/png" })).arrayBuffer());
  } catch {
    return null;
  }
}

export function createMediaService(fetchFn: FetchLike): MediaService {
  const answers = new Map<string, Promise<MediaAnswer | null>>();
  const objectUrls = new Map<string, Promise<{ src: string; answer: MediaAnswer } | null>>();
  let credit = false;
  const listeners = new Set<() => void>();
  const probe = (url: string) => {
    let p = answers.get(url);
    if (!p) {
      p = fetchAnswer(fetchFn, url).then((a) => {
        if (a?.source === "logodev" && !credit) { credit = true; listeners.forEach((fn) => fn()); }
        return a;
      });
      answers.set(url, p);
    }
    return p;
  };
  return {
    vehicleImageUrl, vehicleModelUrl, makeLogoUrl, probe,
    objectUrl(url) {
      let p = objectUrls.get(url);
      if (!p) {
        p = probe(url).then((answer) => {
          if (!answer || typeof URL.createObjectURL !== "function") return null;
          return { src: URL.createObjectURL(new Blob([answer.bytes as BlobPart], { type: answer.contentType })), answer };
        });
        objectUrls.set(url, p);
      }
      return p;
    },
    async photoPng(v, opts = {}) {
      const url = vehicleImageUrl(v);
      if (!url) return null;
      if (opts.cachedOnly && !answers.has(url)) return null;
      const answer = await probe(url);
      return answer ? toPng(answer) : null;
    },
    logoCredit: {
      get: () => credit,
      subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    },
  };
}
