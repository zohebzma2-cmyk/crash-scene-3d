// The colour chips (round B; roads and paths 2026-10-11). Catalog photos and models come in the catalog's own paint, so the
// chips never let a picture's colour pass for the claimant's:
//  - PaintChip: the picked colour ("Picked: Red"), nothing for "Not sure". With `photo`, it heads a catalog photo and says
//    so ("Catalog photo · Picked: Red"; just "Catalog photo" for "Not sure").
//  - CatalogColourChip: a catalog model that couldn't be tinted shows its own paint, so its chip names THAT colour
//    ("Catalog colour: White"), never the picked one the model doesn't show.
import type { CSSProperties } from "react";
import { catalogColourChipText, catalogPhotoChipText, paintOf, pickedChipText, type Paintable, type VehiclePaint } from "@csd/core";

export function PaintChip({ vehicle, className, photo = false }: { vehicle: Paintable; className?: string; photo?: boolean }) {
  const p = paintOf(vehicle);
  if (!p && !photo) return null;
  return (
    <span className={`paint-chip${className ? ` ${className}` : ""}`} data-paint-chip={vehicle.id}>
      {p ? <span className="paint-dot" style={{ "--swatch": p.hex.toLowerCase() } as CSSProperties} aria-hidden="true" /> : null}
      <span>{photo ? catalogPhotoChipText(p) : pickedChipText(p!)}</span>
    </span>
  );
}

export function CatalogColourChip({ vehicleId, paint }: { vehicleId: string; paint: VehiclePaint }) {
  return (
    <span className="paint-chip" data-catalog-chip={vehicleId}>
      <span className="paint-dot" style={{ "--swatch": paint.hex.toLowerCase() } as CSSProperties} aria-hidden="true" />
      <span>{catalogColourChipText(paint)}</span>
    </span>
  );
}
