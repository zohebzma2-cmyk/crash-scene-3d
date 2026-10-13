// `@csd/core/icon-strokes`: polyline strokes of the feature and answer icons on a 24-unit grid, for drawing them
// without the DOM (3D textures, the 2D diagram, PDF and PNG exports). Not in the core index; see feature-symbols.ts.
import geometry from "../../../design/icons/feature-geometry.json" with { type: "json" };
import type { IconStrokes } from "./feature-symbols";

export const iconStrokes = geometry as IconStrokes;
