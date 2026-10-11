import type { ExportRequest, SceneVehicle } from "@csd/core";

/**
 * Stock photos of the vehicles, injected like the canvas (the app gives the photos it already showed, as
 * PNG). Optional, and every answer may be null: the PDF and the stills look as before without a photo.
 */
export interface VehicleMediaProvider {
  vehiclePhoto(vehicle: SceneVehicle): Promise<Uint8Array | null>;
}

/** Minimal 2D canvas we draw on (OffscreenCanvas in the browser, a node canvas later). */
export interface CanvasLike {
  readonly width: number;
  readonly height: number;
  getContext(kind: "2d"): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
}
export interface CanvasFactory {
  create(width: number, height: number): CanvasLike;
  toPng(canvas: CanvasLike): Promise<Uint8Array>;
  /** Make the brand fonts available to the canvas by family name. */
  registerFonts(fonts: ExportRequest["fonts"]): Promise<{ sans: string; mono: string }>;
}
