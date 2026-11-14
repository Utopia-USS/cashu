// useConnection(): the store client's link to the process that runs the store (client/connection.ts),
// live. The desktop shell shows it ("starting the background service", stale data, "reconnected");
// on the phone it is always `online`.
import { useSyncExternalStore } from "react";
import type { ConnectionStatus } from "../client/connection.js";
import { useStoreClient } from "./context.js";

export function useConnection(): ConnectionStatus {
  const { connection } = useStoreClient();
  return useSyncExternalStore(connection.subscribe, connection.getSnapshot, connection.getSnapshot);
}
