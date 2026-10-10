// The browser side of the exports package: a canvas factory and the brand fonts.
// Fonts are the self-hosted Fontsource WOFF files (fontkit can't read WOFF2),
// fetched from our own origin, so CSP connect-src 'self' holds. This is the one
// home for both; app services import from here.
import type { BrandFonts } from "@csd/core";
import type { CanvasFactory, CanvasLike } from "@csd/exports";
import sansRegularUrl from "@fontsource/plus-jakarta-sans/files/plus-jakarta-sans-latin-400-normal.woff?url";
import sansBoldUrl from "@fontsource/plus-jakarta-sans/files/plus-jakarta-sans-latin-700-normal.woff?url";
import monoRegularUrl from "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff?url";

/** Family names used only inside export canvases, so they never clash with the page's @font-face rules. */
export const EXPORT_FAMILIES = { sans: "CSD Export Sans", mono: "CSD Export Mono" } as const;
export const FONT_URLS = Object.freeze({ sansRegular: sansRegularUrl, sansBold: sansBoldUrl, monoRegular: monoRegularUrl });

const FONT_ERROR = "The brand fonts couldn't be loaded for the export.";
type Fetcher = (url: string) => Promise<Response>;

async function bytesOf(url: string, fetchFn: Fetcher): Promise<Uint8Array> {
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(FONT_ERROR);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error(FONT_ERROR);
  return bytes;
}

let fontsOnce: Promise<BrandFonts> | null = null;

const fetchAll = (fetchFn: Fetcher): Promise<BrandFonts> =>
  Promise.all([bytesOf(FONT_URLS.sansRegular, fetchFn), bytesOf(FONT_URLS.sansBold, fetchFn), bytesOf(FONT_URLS.monoRegular, fetchFn)])
    .then(([sansRegular, sansBold, monoRegular]) => ({ sansRegular, sansBold, monoRegular }));

/**
 * The brand font files. With the real fetch they are fetched once per page (a failure is
 * retried on the next call); an injected fetcher (tests) always fetches.
 */
export function loadBrandFonts(fetchFn?: Fetcher): Promise<BrandFonts> {
  if (fetchFn) return fetchAll(fetchFn);
  fontsOnce ??= fetchAll((u) => fetch(u)).catch((e: unknown) => { fontsOnce = null; throw e; });
  return fontsOnce;
}

const copy = (b: Uint8Array): ArrayBuffer => b.slice().buffer as ArrayBuffer;
const hasOffscreen = () => typeof OffscreenCanvas === "function";

/** Fonts already added to document.fonts, keyed by the bytes object they came from. */
const registered = new WeakMap<BrandFonts, Promise<void>>();

export function createBrowserCanvasFactory(): CanvasFactory {
  return {
    create(width: number, height: number): CanvasLike {
      if (hasOffscreen()) return new OffscreenCanvas(width, height);
      return Object.assign(document.createElement("canvas"), { width, height });
    },
    async toPng(canvas: CanvasLike): Promise<Uint8Array> {
      if (hasOffscreen() && canvas instanceof OffscreenCanvas) {
        return new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
      }
      if (!(canvas instanceof HTMLCanvasElement)) throw new Error("The picture couldn't be made in this browser.");
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("The picture couldn't be made in this browser.");
      return new Uint8Array(await blob.arrayBuffer());
    },
    async registerFonts(fonts: BrandFonts): Promise<{ sans: string; mono: string }> {
      let once = registered.get(fonts);
      if (!once) {
        once = (async () => {
          const faces = [
            new FontFace(EXPORT_FAMILIES.sans, copy(fonts.sansRegular), { weight: "400" }),
            new FontFace(EXPORT_FAMILIES.sans, copy(fonts.sansBold), { weight: "700" }),
            new FontFace(EXPORT_FAMILIES.mono, copy(fonts.monoRegular), { weight: "400" }),
          ];
          await Promise.all(faces.map((f) => f.load()));
          for (const f of faces) document.fonts.add(f);
        })();
        registered.set(fonts, once);
        once.catch(() => registered.delete(fonts));
      }
      await once;
      return { ...EXPORT_FAMILIES };
    },
  };
}
