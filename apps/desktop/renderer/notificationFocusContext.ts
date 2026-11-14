import { createContext } from "react";

/** A validated click's signal stays in memory and is scoped to its exact vault. */
export const NotificationSignalFocus = createContext<{ vault: string; signalId: string } | null>(
  null,
);
