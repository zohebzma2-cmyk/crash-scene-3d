// Exports API (signatures are locked). Files are made on the device; the canvas
// is injected so the same code can run server-side later.
import type { ExportBundle, ExportFile, ExportFormat, ExportRequest } from "@csd/core";
import type { CanvasFactory } from "./canvas-types";
import { buildModel, fileClaim } from "./model";
import { buildPdf } from "./pdf";
import { buildDiagramPng, buildStillPng } from "./png";
import { sceneFile } from "./scene-file";

export type { CanvasFactory, CanvasLike } from "./canvas-types";
export { sceneFile } from "./scene-file";
export { footerBandHeight } from "./png";
export { PNG_METERS_PER_PIXEL_KEY } from "./png-meta";
export { zipFiles, unzipStored, crc32, type ZipEntry } from "./zip";

const utf8 = (s: string) => new TextEncoder().encode(s);
const why = (e: unknown) => (e instanceof Error && e.message ? e.message : "unknown problem");

/** ISO 8601 UTC, seconds precision, e.g. 2026-10-09T20:52:18Z. */
function isoSeconds(d: Date): string {
  if (Number.isNaN(d.getTime())) throw new Error("The clock gave an invalid time.");
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** One save: all requested files, one timestamp, one fingerprint. */
export async function buildExports(req: ExportRequest, canvas: CanvasFactory): Promise<ExportBundle> {
  const createdAt = isoSeconds((req.now ?? (() => new Date()))());
  const { text, stamp } = await sceneFile(req.scene, req.sim, createdAt);
  const model = buildModel(req.scene, req.sim, stamp);
  const base = `crash-scene-${fileClaim(req.scene.claim.number)}`;
  const wanted = new Set(req.formats);
  const files: ExportFile[] = [];
  const skipped: Array<{ format: ExportFormat; reason: string }> = [];
  const notes: string[] = [];

  // Every PDF and PNG prints the scene file's fingerprint, so the file it belongs to is always saved with them.
  const needsFingerprintFile = !wanted.has("json") && (wanted.has("pdf") || wanted.has("png-diagram") || wanted.has("png-impact") || wanted.has("png-rest"));
  if (wanted.has("json") || needsFingerprintFile) {
    files.push({ name: `${base}.json`, mime: "application/json", bytes: utf8(text) });
  }

  if (wanted.has("pdf")) {
    try {
      const pdf = await buildPdf({
        model, scene: req.scene, sim: req.sim, roads: req.roads, fonts: req.fonts, createdAt,
        ...(req.mapThumbnail ? { mapThumbnail: req.mapThumbnail } : {}),
        sceneFileName: `${base}.json`,
      });
      files.push({ name: `${base}.pdf`, mime: "application/pdf", bytes: pdf.bytes });
      notes.push(...pdf.notes);
    } catch (e) {
      skipped.push({ format: "pdf", reason: `The PDF couldn't be made (${why(e)}), so it was left out.` });
    }
  }

  const pngs = (["png-diagram", "png-impact", "png-rest"] as const).filter((f) => wanted.has(f));
  if (pngs.length) {
    let fam: { sans: string; mono: string } | null = null;
    try { fam = await canvas.registerFonts(req.fonts); } catch (e) {
      for (const format of pngs) skipped.push({ format, reason: `The brand fonts couldn't be loaded (${why(e)}), so this picture was left out.` });
    }
    if (fam) {
      if (wanted.has("png-diagram")) {
        try {
          files.push({ name: `${base}-diagram.png`, mime: "image/png", bytes: await buildDiagramPng({ model, sim: req.sim, roads: req.roads }, canvas, fam) });
        } catch (e) {
          skipped.push({ format: "png-diagram", reason: `The diagram picture couldn't be made (${why(e)}), so it was left out.` });
        }
      }
      for (const [format, key, suffix, what, caption] of [
        ["png-impact", "impact", "impact", "the moment of impact", "Moment of impact"],
        ["png-rest", "rest", "final-rest", "final rest", "Final rest"],
      ] as const) {
        if (!wanted.has(format)) continue;
        const still = req.stills?.[key];
        if (!still || still.length === 0) { skipped.push({ format, reason: `The 3D picture of ${what} wasn't captured, so this file was left out.` }); continue; }
        try {
          const shown = model.adjustedNotes.length ? `${caption}: the picture uses a different hit side than entered (see the PDF)` : caption;
          files.push({ name: `${base}-${suffix}.png`, mime: "image/png", bytes: await buildStillPng(still, shown, model, canvas, fam) });
        } catch (e) {
          skipped.push({ format, reason: `The 3D picture of ${what} couldn't be read (${why(e)}), so this file was left out.` });
        }
      }
    }
  }
  // Only say the scene file was added for the others if at least one other file made it into the save.
  if (needsFingerprintFile && files.length > 1) notes.unshift("The scene file was added so the fingerprint on the other files can be checked.");
  return { stamp, files, skipped, notes };
}
