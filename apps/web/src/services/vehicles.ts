// NHTSA vPIC through our proxy (/api/vehicles/*). Only the make text and the model year are sent.
// Both lists are cached for the page session: the makes once, the models once per make and year
// ("Chevrolet" and "chevrolet" are the same request). The picker never asks while someone is still
// typing a make; it asks once the make is known (see VehicleCard).
import { PROXY_ROUTES, normName, type VehicleModelResult } from "@csd/core";
import { getJson, type FetchLike } from "./http";
import type { VehiclesService } from "./types";

export function createVehiclesService(fetchFn: FetchLike): VehiclesService {
  let makesPromise: Promise<string[]> | null = null;
  const models = new Map<string, Promise<VehicleModelResult[]>>();
  return {
    makes() {
      makesPromise ??= getJson<string[]>(fetchFn, PROXY_ROUTES.makes).then((r) => (Array.isArray(r) ? r.filter((m) => typeof m === "string") : [])).catch((e: unknown) => { makesPromise = null; throw e; });
      return makesPromise;
    },
    models(make, year) {
      const key = `${year}|${normName(make)}`;
      let p = models.get(key);
      if (!p) {
        p = getJson<VehicleModelResult[]>(fetchFn, `${PROXY_ROUTES.models}?${new URLSearchParams({ make: make.trim(), year: String(year) })}`)
          .then((r) => (Array.isArray(r) ? r.filter((m) => m != null && typeof m.name === "string") : []))
          .catch((e: unknown) => { models.delete(key); throw e; });
        models.set(key, p);
      }
      return p;
    },
  };
}
