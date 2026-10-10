// The town and state on the claim ("Main Street and Park Street, Nashua, NH" -> "Nashua, NH"), and where it is.
// It is only looked up when the claimant types "A and B" with nothing else to say where: never before typing.
import { useEffect, useState } from "react";
import type { LatLon } from "@csd/core";
import { useServices } from "../services/context";
import { useDoc } from "./DocProvider";

/** Everything after the street part: "Nashua, NH". Null when the address has no comma, so no town can be read. */
export function claimTown(address: string): string | null {
  const parts = address.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const town = parts.slice(1).join(", ");
  return town.length >= 3 && town.length <= 120 ? town : null;
}

export interface ClaimTown {
  readonly town: string | null;
  /** "idle" until wanted; "loading" while it is looked up; "none" when it can't be found. */
  readonly status: "idle" | "loading" | "ok" | "none";
  readonly point: LatLon | null;
}

interface Found { readonly town: string; readonly point: LatLon | null }

/**
 * The claim's town as text, and (once `want` is true) its place on the map, from the type-ahead service. Its own
 * session cache means each town is asked for once.
 */
export function useClaimTown(want: boolean): ClaimTown {
  const { doc } = useDoc();
  const { geo } = useServices();
  const town = claimTown(doc.claimAddress);
  const [found, setFound] = useState<Found | null>(null);
  useEffect(() => {
    if (!want || !town) return;
    const ctrl = new AbortController();
    geo.suggest(town, { signal: ctrl.signal }).then(
      (r) => {
        const hit = r.find((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
        setFound({ town, point: hit ? { lat: hit.lat, lon: hit.lon } : null });
      },
      (e: unknown) => { if (!(e instanceof DOMException && e.name === "AbortError")) setFound({ town, point: null }); },
    );
    return () => ctrl.abort();
  }, [want, town, geo]);
  if (!want || !town) return { town, status: "idle", point: null };
  if (found && found.town === town) return { town, status: found.point ? "ok" : "none", point: found.point };
  return { town, status: "loading", point: null };
}
