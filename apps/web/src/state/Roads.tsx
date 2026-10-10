// Road data for the pin. After the pin is set, the roads around it are loaded (Overpass through
// the proxy), and the streets at the pin become the direction choices on the vehicles step.
// Moving the pin a little reuses the loaded roads; moving it far loads new ones.
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { RoadNetwork, StreetsAtPin } from "@csd/core";
import { useServices } from "../services/context";
import { ServiceError } from "../services/types";
import { useDoc } from "./DocProvider";

export type RoadsStatus = "idle" | "loading" | "ready" | "none" | "error";

export interface RoadsValue {
  readonly status: RoadsStatus;
  /** Null until loaded, and when there is nothing to draw. */
  readonly net: RoadNetwork | null;
  readonly streets: StreetsAtPin | null;
  readonly message: string | null;
}

const Ctx = createContext<RoadsValue>({ status: "idle", net: null, streets: null, message: null });

/** A pin this close to the loaded area's center reuses the roads. The area is 250 m around its center. */
export const REUSE_RADIUS_M = 100;
export const LOAD_DEBOUNCE_MS = 700;

const M_PER_DEG = 111_320;
function metersBetween(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  return Math.hypot((a.lat - b.lat) * M_PER_DEG, (a.lon - b.lon) * M_PER_DEG * Math.cos((a.lat * Math.PI) / 180));
}

const FAILED_MESSAGE = "We couldn't load the roads here. You can still pick which way each vehicle was going.";

export function RoadsProvider({ children, debounceMs = LOAD_DEBOUNCE_MS }: { children: ReactNode; debounceMs?: number }) {
  const { doc, dispatch } = useDoc();
  const services = useServices();
  const { lat, lon } = doc.scene.location;
  const located = doc.located;
  const [net, setNet] = useState<RoadNetwork | null>(null);
  const [failed, setFailed] = useState<{ lat: number; lon: number; message: string } | null>(null);

  const pin = useMemo(() => ({ lat, lon }), [lat, lon]);
  const reusable = located && net != null && metersBetween(net.frame.origin, pin) < REUSE_RADIUS_M;
  const failedHere = located && failed != null && metersBetween(failed, pin) < REUSE_RADIUS_M;

  useEffect(() => {
    if (!located || reusable || failedHere) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      services.roads.load(pin).then(
        (n) => { if (!cancelled) { setNet(n); setFailed(null); } },
        (e: unknown) => { if (!cancelled) setFailed({ ...pin, message: e instanceof ServiceError ? e.message : FAILED_MESSAGE }); },
      );
    }, debounceMs);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [located, reusable, failedHere, pin, services, debounceMs]);

  const current = reusable ? net : null;
  const streets = useMemo(() => {
    if (!current) return null;
    try {
      return services.physics.streetsAtPin(current, services.physics.toLocal(current.frame, pin));
    } catch {
      return null;
    }
  }, [current, pin, services]);

  const signature = streets ? streets.directions.map((d) => `${d.roadId}|${d.label}`).join(";") : "";
  const directions = streets?.directions;
  useEffect(() => {
    if (directions && directions.length) dispatch({ type: "reconcile-travel", choices: directions });
    // The signature stands for the list: reconcile once per distinct set of choices.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, dispatch]);

  const status: RoadsStatus = !located ? "idle" : current ? (current.ways.length > 0 ? "ready" : "none") : failedHere ? "error" : "loading";
  const value = useMemo<RoadsValue>(
    () => ({ status, net: current && current.ways.length > 0 ? current : null, streets, message: failedHere ? (failed?.message ?? FAILED_MESSAGE) : null }),
    [status, current, streets, failedHere, failed],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRoads(): RoadsValue {
  return useContext(Ctx);
}
