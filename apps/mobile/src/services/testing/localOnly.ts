// The sync side of a test kit's services: no vault sessions, a runner with nothing to drive. Screens
// under test read their vaults straight from the synthetic stores.
import { createSyncRunner } from "../../sync/syncRunner";
import type { Services } from "../services";

export const LOCAL_ONLY: Pick<Services, "vaults" | "sync" | "closeSessions"> = {
  vaults: {
    get: () => undefined,
    list: () => [],
    unavailable: () => undefined,
    unavailableVaults: () => [],
  },
  sync: createSyncRunner({ targets: () => [], now: () => 0 }),
  closeSessions: async () => {},
};
