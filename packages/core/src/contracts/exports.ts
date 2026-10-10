// What the exports package takes and returns. Files are made on the device;
// nothing is uploaded. Every file carries the disclaimer, the save time and
// the SHA-256 fingerprint of the scene file from the same save.
import type { RoadNetwork } from "./roads";
import type { Scene } from "./scene";
import type { SimulationResult } from "./simulation";

export const DISCLAIMER_SHORT = "Illustration only. This shows what you described. It is not an expert reconstruction and does not decide fault.";
export const DISCLAIMER_LONG = "This 3D illustration was made in your browser by InsurifyAI from details you entered: location, vehicles, directions and estimated speeds. It is a simplified picture to help explain your account. It is not an expert accident reconstruction, expert opinion or evidence of fault, and real vehicle movement may have been different.";

export type ExportFormat = "pdf" | "png-impact" | "png-rest" | "png-diagram" | "json";

/** One save: one timestamp and one fingerprint for every file in it. */
export interface ExportStamp {
  /** ISO 8601 UTC, seconds precision, the real time of saving. */
  readonly createdAt: string;
  /** SHA-256 hex of the scene file bytes. */
  readonly fingerprintHex: string;
  /** First 16 hex characters in groups of four, e.g. "a3f9 1c2e 77b0 4d18". */
  readonly fingerprintShort: string;
}

/** Brand fonts as raw bytes (TTF/OTF/WOFF) so PDF and canvas output use them. */
export interface BrandFonts {
  readonly sansRegular: Uint8Array;
  readonly sansBold: Uint8Array;
  readonly monoRegular: Uint8Array;
}

export interface ExportRequest {
  readonly scene: Scene;
  readonly sim: SimulationResult;
  readonly roads: RoadNetwork | null;
  readonly formats: readonly ExportFormat[];
  /** PNG bytes captured from the 3D viewer at impact and at final rest (required for those formats). */
  readonly stills?: { readonly impact?: Uint8Array; readonly rest?: Uint8Array };
  /** PNG of the visible map tiles with the pin (from tiles already loaded; never fetched for export). */
  readonly mapThumbnail?: Uint8Array;
  readonly fonts: BrandFonts;
  /** Injected so tests can fix it. Defaults to the real clock. */
  readonly now?: () => Date;
}

export interface ExportFile {
  readonly name: string;
  readonly mime: "application/pdf" | "image/png" | "application/json";
  readonly bytes: Uint8Array;
}

export interface ExportBundle {
  readonly stamp: ExportStamp;
  readonly files: readonly ExportFile[];
  /** Requested files that were left out, with a plain-language reason. Empty when nothing was skipped. */
  readonly skipped: ReadonlyArray<{ readonly format: ExportFormat; readonly reason: string }>;
  /** Plain-language notes for the person saving (a file added or left out, overflow to page 2, characters that couldn't be printed). Empty when there is nothing to say. */
  readonly notes: readonly string[];
}
