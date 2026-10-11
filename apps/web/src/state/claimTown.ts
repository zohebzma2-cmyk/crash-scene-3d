// The town and state on the claim ("Main Street and Park Street, Nashua, NH" -> "Nashua, NH"), and where it is.
// It is looked up once the claimant starts typing (never before), and only while there is no pin, so the first
// suggestions are already biased to the claim's town. Only the town and state go to the type-ahead, never the street. Also: a street in a town typed after a comma ("Elm St and Hanover St, Manchester NH").
import { useEffect, useState } from "react";
import type { LatLon } from "@csd/core";
import { mapConfig } from "../config/map";
import { useServices } from "../services/context";
import type { StreetInTown } from "../services/types";
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
  /** The claim's state as a two-letter code ("NH"), when known. */
  readonly state: string | null;
}

interface Found { readonly town: string; readonly point: LatLon | null; readonly state: string | null }

/**
 * The claim's town as text, and (once `want` is true) its place on the map, from the type-ahead service. Its own
 * session cache means each town is asked for once.
 */
export function useClaimTown(want: boolean): ClaimTown {
  const { doc } = useDoc();
  const { geo } = useServices();
  const town = claimTown(doc.claimAddress);
  const [found, setFound] = useState<Found | null>(null);
  const done = found !== null && found.town === town;
  useEffect(() => {
    if (!want || !town || done) return;
    const ctrl = new AbortController();
    geo.town(town, { signal: ctrl.signal }).then(
      (r) => setFound({ town, point: r ? r.point : null, state: r ? r.state : null }),
      (e: unknown) => { if (!(e instanceof DOMException && e.name === "AbortError")) setFound({ town, point: null, state: null }); },
    );
    return () => ctrl.abort();
  }, [want, town, done, geo]);
  if (found && found.town === town) return { town, status: found.point ? "ok" : "none", point: found.point, state: found.state };
  if (!want || !town) return { town, status: "idle", point: null, state: null };
  return { town, status: "loading", point: null, state: null };
}

export interface TypedTownStreet {
  /** "loading" while the street (or the town) is looked up; "none" when neither can be found. */
  readonly status: "idle" | "loading" | "ok" | "none";
  readonly value: StreetInTown | null;
}

/**
 * Street `name` in the town typed after the comma ("Elm St" in "Manchester NH"), once the text has rested for the
 * type-ahead pause. Null `town` (nothing typed after a comma) is idle and sends nothing.
 */
export function useStreetInTown(name: string | null, town: string | null): TypedTownStreet {
  const { geo } = useServices();
  const key = name && town ? `${name.toLowerCase()}|${town.toLowerCase()}` : null;
  const [found, setFound] = useState<{ key: string; value: StreetInTown | null } | null>(null);
  const done = found !== null && found.key === key;
  useEffect(() => {
    if (!key || !name || !town || done) return;
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => {
      geo.streetIn(name, town, { signal: ctrl.signal }).then(
        (value) => setFound({ key, value }),
        (e: unknown) => { if (!(e instanceof DOMException && e.name === "AbortError")) setFound({ key, value: null }); },
      );
    }, mapConfig.suggestDebounceMs);
    return () => { window.clearTimeout(timer); ctrl.abort(); };
    // `key` stands for the name and the town.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, done, geo]);
  if (!key) return { status: "idle", value: null };
  if (found && found.key === key) return { status: found.value ? "ok" : "none", value: found.value };
  return { status: "loading", value: null };
}
