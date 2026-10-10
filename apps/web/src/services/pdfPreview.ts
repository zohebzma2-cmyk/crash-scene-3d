// Renders the real PDF's pages to a canvas with pdfjs-dist, so the Save step previews the file
// that would be saved, not a re-creation. pdfjs is loaded on demand. Its worker is served from our
// own origin as a bundled asset (CSP worker-src 'self' blob:), and nothing here needs eval (no unsafe-eval).
// It is the legacy build (same version), which runs on iOS 17 and 18 Safari.
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import type { PdfPreviewDocument, PdfPreviewService } from "./types";

type PdfJs = typeof import("pdfjs-dist");
let loaded: Promise<PdfJs> | null = null;

function loadPdfJs(): Promise<PdfJs> {
  loaded ??= import("pdfjs-dist/legacy/build/pdf.mjs").then((m) => {
    m.GlobalWorkerOptions.workerPort = new Worker(workerUrl, { type: "module" });
    return m;
  });
  return loaded;
}

export function createPdfPreviewService(): PdfPreviewService {
  return {
    async open(bytes): Promise<PdfPreviewDocument> {
      const pdfjs = await loadPdfJs();
      // pdf.js takes ownership of the buffer it is given, so it gets a copy.
      const task = pdfjs.getDocument({ data: bytes.slice() });
      const doc = await task.promise;
      let running: { cancel(): void; promise: Promise<unknown> } | null = null;
      return {
        numPages: doc.numPages,
        async renderPage(n, canvas, cssWidthPx) {
          // One render per canvas at a time: stop the one in flight and wait for it to end.
          if (running) { running.cancel(); await running.promise.catch(() => undefined); }
          const page = await doc.getPage(n);
          const natural = page.getViewport({ scale: 1 });
          const ratio = window.devicePixelRatio || 1;
          const viewport = page.getViewport({ scale: (cssWidthPx / natural.width) * ratio });
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          const drawing = page.render({ canvas, viewport });
          running = drawing;
          await drawing.promise;
        },
        destroy() { void task.destroy(); },
      };
    },
  };
}
