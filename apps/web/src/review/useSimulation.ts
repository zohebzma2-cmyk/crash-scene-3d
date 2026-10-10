// The simulation for the current scene and roads, through the physics service. Nothing it throws
// reaches the screen as a stack: it becomes a plain message.
import { useMemo } from "react";
import type { Scene, SimulationOutcome } from "@csd/core";
import { useServices } from "../services/context";
import { useRoads } from "../state/Roads";

export const SIM_FAILED_TEXT = "We couldn't build the picture from these details. Check them and try again.";

/** null while the roads are still loading. */
export function useSimulation(scene: Scene): SimulationOutcome | null {
  const services = useServices();
  const roads = useRoads();
  const waiting = roads.status === "loading";
  return useMemo<SimulationOutcome | null>(() => {
    if (waiting) return null;
    try {
      return services.physics.simulate(scene, roads.net);
    } catch {
      return { ok: false, errors: [{ code: "sim-failed", text: SIM_FAILED_TEXT, vehicleIds: [] }] };
    }
  }, [scene, roads.net, services, waiting]);
}
