// The picked colour, shown next to any catalog photo of the vehicle ("Picked: Red"). Catalog photos come in
// the catalog's own paint, so without this chip a red car could be shown silver. Renders nothing for
// "Not sure". HOOK for roundB/images: its VehiclePhoto renders <PaintChip vehicle={v} /> beside the photo
// (and the photo's alt text should not name a colour).
import type { CSSProperties } from "react";
import { paintOf, pickedChipText, type Paintable } from "@csd/core";

export function PaintChip({ vehicle, className }: { vehicle: Paintable; className?: string }) {
  const p = paintOf(vehicle);
  if (!p) return null;
  return (
    <span className={`paint-chip${className ? ` ${className}` : ""}`} data-paint-chip={vehicle.id}>
      <span className="paint-dot" style={{ "--swatch": p.hex.toLowerCase() } as CSSProperties} aria-hidden="true" />
      <span>{pickedChipText(p)}</span>
    </span>
  );
}
