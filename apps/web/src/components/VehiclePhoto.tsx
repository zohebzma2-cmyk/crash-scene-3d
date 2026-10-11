// The stock front 3/4 photo of the picked year, make and model on the vehicle card, fetched by our server
// and served from our own origin (/api/vehicles/image). Asked only once a model from the list is picked
// (`ready`) and typing has settled. While it loads: our type icon with a spinner. With no photo (none known,
// no keys, over quota, offline): our type icon, quietly. Never an error.
import { useEffect, useState } from "react";
import { PRESETS, vehicleName, type SceneVehicle } from "@csd/core";
import { Icon } from "../icons/Icon";
import { useServices } from "../services/context";
import { MEDIA_SETTLE_MS } from "./MakeLogo";

export interface VehiclePhotoProps {
  readonly vehicle: SceneVehicle;
  /** A make and a model from the list are picked: the photo may be asked for. */
  readonly ready: boolean;
}

export function VehiclePhoto({ vehicle: v, ready }: VehiclePhotoProps) {
  const { media } = useServices();
  const url = ready ? media.vehicleImageUrl({ year: v.year, make: v.make, model: v.model, type: v.type }) : null;
  const [shown, setShown] = useState<{ url: string; src: string | null } | null>(null);

  useEffect(() => {
    if (!url) return;
    let off = false;
    const timer = window.setTimeout(() => {
      void media.objectUrl(url).then((r) => { if (!off) setShown({ url, src: r?.src ?? null }); });
    }, MEDIA_SETTLE_MS);
    return () => { off = true; window.clearTimeout(timer); };
  }, [url, media]);

  const current = url !== null && shown?.url === url ? shown : null;
  const loading = url !== null && current === null;
  const src = current?.src ?? null;
  const state = loading ? "loading" : src ? "photo" : "icon";
  return (
    <div className="vehicle-photo" data-photo={state} aria-busy={loading || undefined}>
      {src ? <img src={src} alt={`Stock photo of a ${vehicleName(v) ?? "vehicle"}`} /> : <Icon name={PRESETS[v.type].icon} className="icon-lg" />}
      {loading ? <span className="spinner" aria-hidden="true" /> : null}
    </div>
  );
}
