// Save generated files to the device (nothing is uploaded).
//
// One save = one download. Browsers treat several downloads from one tap
// differently (Chrome asks before the second, iOS Safari keeps only the first),
// so a save with more than one file is delivered as a single stored ZIP named
// after the scene file. A lone file downloads as itself.
import type { ExportBundle, ExportFile } from "@csd/core";
import { zipFiles } from "@csd/exports";

export interface DownloadItem {
  readonly name: string;
  readonly mime: string;
  readonly bytes: Uint8Array;
}

export function downloadFile(file: DownloadItem): void {
  const blob = new Blob([new Uint8Array(file.bytes)], { type: file.mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  // iOS Safari reads the blob after the click returns; keep the URL alive a while.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** What one save delivers: the lone file, or one ZIP of all of them. */
export function bundleDownload(bundle: ExportBundle): DownloadItem | null {
  const files = bundle.files;
  if (files.length === 0) return null;
  if (files.length === 1) return files[0]!;
  const json = files.find((f) => f.mime === "application/json") ?? files[0]!;
  const base = json.name.replace(/\.[a-z]+$/i, "");
  return { name: `${base}.zip`, mime: "application/zip", bytes: zipFiles(files, new Date(bundle.stamp.createdAt)) };
}

export const FILE_WORDS: Readonly<Record<ExportFile["mime"], string>> = {
  "application/pdf": "PDF summary",
  "image/png": "pictures",
  "application/json": "scene file",
};
