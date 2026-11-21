// Stable services for screen hooks (cashu-ts-architecture data-flow.md, "Global state, by kind": a
// Context whose value never changes identity, provided at the app root).
import { createContext, type ReactNode, use } from "react";
import type { Services } from "./services";

const ServicesContext = createContext<Services | null>(null);

export function ServicesProvider({
  services,
  children,
}: {
  services: Services;
  children: ReactNode;
}) {
  return <ServicesContext value={services}>{children}</ServicesContext>;
}

export function useServices(): Services {
  const services = use(ServicesContext);
  if (services === null) throw new Error("useServices outside ServicesProvider");
  return services;
}
