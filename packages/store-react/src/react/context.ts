// The two contexts of the bindings: the store client (a stable service, provided once at the app
// root) and the current profile (the vault whose store `useQuery` reads; a string, so its identity is
// stable while the profile stays the same).
import { createContext, use } from "react";
import type { StoreClient } from "../client/types.js";

export const StoreClientContext = createContext<StoreClient | null>(null);
export const ProfileContext = createContext<string | null>(null);

export class StoreBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreBindingError";
  }
}

/** The store client of the app root (`StoreProvider`). */
export function useStoreClient(): StoreClient {
  const client = use(StoreClientContext);
  if (client === null) throw new StoreBindingError("useStoreClient needs a StoreProvider above it");
  return client;
}
