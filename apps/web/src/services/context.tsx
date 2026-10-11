import { createContext, useContext, type ReactNode } from "react";
import type { Services } from "./types";

const ServicesContext = createContext<Services | null>(null);

export function ServicesProvider({ services, children }: { services: Services; children: ReactNode }) {
  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>;
}

export function useServices(): Services {
  const s = useContext(ServicesContext);
  if (!s) throw new Error("ServicesProvider is missing.");
  return s;
}

/** The services when a provider is there, else null (components that also render on their own in tests). */
export function useOptionalServices(): Services | null {
  return useContext(ServicesContext);
}
