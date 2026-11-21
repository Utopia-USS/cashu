import type { ReactNode } from "react";
import type { StoreClient } from "../client/types.js";
import { StoreClientContext } from "./context.js";

/**
 * Provides the store client at the app root: `createSyncClient` on the phone and in tests,
 * `createPortClient` in the desktop renderer. The client is a stable service; create it once.
 */
export function StoreProvider({ client, children }: { client: StoreClient; children: ReactNode }) {
  return <StoreClientContext value={client}>{children}</StoreClientContext>;
}
