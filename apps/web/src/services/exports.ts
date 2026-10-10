// The Save step's door to @csd/exports. It adds what the exports package can't get by itself:
// the brand font bytes (from the self-hosted @fontsource files) and a browser canvas.
import type { BrandFonts, ExportBundle, ExportRequest } from "@csd/core";
import type { CanvasFactory } from "@csd/exports";
import type { ExportsService, ExportInput } from "./types";

export type { CanvasFactory, CanvasLike } from "@csd/exports";

export interface ExportsDeps {
  readonly buildExports: (req: ExportRequest, canvas: CanvasFactory) => Promise<ExportBundle>;
  readonly canvas: CanvasFactory;
  readonly loadFonts: () => Promise<BrandFonts>;
}

export function createExportsService(deps: ExportsDeps): ExportsService {
  return {
    async build(input: ExportInput) {
      const fonts = await deps.loadFonts();
      return deps.buildExports({ ...input, fonts }, deps.canvas);
    },
  };
}
