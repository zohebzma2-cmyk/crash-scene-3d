// Previews of the REAL files from the exports service: PNGs as images from blob URLs, the scene
// file as its canonical text, and the PDF's pages drawn by pdf.js. All text is shown as text.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { ExportBundle, ExportFile } from "@csd/core";
import { Icon } from "../icons/Icon";
import { useElementSize } from "../lib/dom";
import { useServices } from "../services/context";
import type { PdfPreviewDocument } from "../services/types";

export type PreviewKind = "pdf" | "png" | "json";

export const findFile = (bundle: ExportBundle, kind: PreviewKind): ExportFile | undefined =>
  bundle.files.find((f) => (kind === "pdf" ? f.mime === "application/pdf" : kind === "png" ? f.mime === "image/png" : f.mime === "application/json"));

/** Object URLs for the bundle's files, revoked when the bundle changes or the step goes away. */
export function useObjectUrls(bundle: ExportBundle | null): ReadonlyMap<ExportFile, string> {
  const urls = useMemo(() => {
    const map = new Map<ExportFile, string>();
    for (const f of bundle?.files ?? []) map.set(f, URL.createObjectURL(new Blob([new Uint8Array(f.bytes)], { type: f.mime })));
    return map;
  }, [bundle]);
  useEffect(() => () => { for (const u of urls.values()) URL.revokeObjectURL(u); }, [urls]);
  return urls;
}

export function PngPreview({ url }: { url: string }) {
  return <img className="preview-img" src={url} alt="Preview of the diagram picture that will be saved" data-testid="png-preview" />;
}

export function JsonPreview({ file }: { file: ExportFile }) {
  // The scene file's own canonical text, exactly as saved.
  const text = useMemo(() => new TextDecoder().decode(file.bytes), [file]);
  return <pre className="json-preview" tabIndex={0} aria-label="Scene file contents" data-testid="json-preview">{text}</pre>;
}

export function PdfPreview({ file }: { file: ExportFile }) {
  const { pdf } = useServices();
  const [doc, setDoc] = useState<PdfPreviewDocument | null>(null);
  const [failed, setFailed] = useState(false);
  const [page, setPage] = useState(1);
  const [ref, size] = useElementSize<HTMLDivElement>({ w: 600, h: 800 });
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let off = false;
    let opened: PdfPreviewDocument | null = null;
    pdf.open(file.bytes).then(
      (d) => { if (off) { d.destroy(); return; } opened = d; setDoc(d); setPage(1); setFailed(false); },
      () => { if (!off) setFailed(true); },
    );
    return () => { off = true; opened?.destroy(); setDoc(null); };
  }, [pdf, file]);

  useEffect(() => {
    if (!doc || !canvas.current) return;
    let off = false;
    doc.renderPage(page, canvas.current, size.w).catch(() => { if (!off) setFailed(true); });
    return () => { off = true; };
  }, [doc, page, size.w]);

  if (failed) return <p className="hint" role="status">We couldn't draw the PDF here. The saved file is unaffected.</p>;
  return (
    <div className="preview-pdf" ref={ref} data-testid="pdf-preview">
      <canvas ref={canvas} className="preview-canvas" aria-label={`Preview of page ${page} of the PDF summary`} role="img" />
      {doc && doc.numPages > 1 ? (
        <div className="preview-pager">
          <span>{doc.numPages} pages</span>
          <button type="button" className="btn btn-quiet btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous page</button>
          <span aria-live="polite">Page {page} of {doc.numPages}</span>
          <button type="button" className="btn btn-quiet btn-sm" disabled={page >= doc.numPages} onClick={() => setPage((p) => p + 1)}>Next page</button>
        </div>
      ) : null}
    </div>
  );
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A full-size view of a preview, inside the page: a modal dialog with the content at full width.
 * Esc closes it, Tab stays inside it, and focus goes back to the button that opened it.
 * (A new tab would inherit our strict CSP and could blank the browser's own PDF viewer.)
 */
export function FullSizeDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const d = ref.current;
    const opener = document.activeElement as HTMLElement | null;
    if (d) {
      if (typeof d.showModal === "function") d.showModal();
      else d.setAttribute("open", "");
    }
    closeBtn.current?.focus();
    return () => {
      if (d?.open && typeof d.close === "function") d.close();
      opener?.focus?.();
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDialogElement>) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if (e.key !== "Tab") return;
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  return (
    <dialog ref={ref} className="full-size-dialog" aria-label={title} onKeyDown={onKeyDown} onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <div className="full-size-head">
        <h2>{title}</h2>
        <button ref={closeBtn} type="button" className="icon-btn" aria-label="Close the full size view" onClick={onClose}><Icon name="close" /></button>
      </div>
      <div className="full-size-body">{children}</div>
    </dialog>
  );
}
