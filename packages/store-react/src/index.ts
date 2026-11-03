// @cashu/store-react: React bindings over the event store (data-flow.md). Clients come from ./client
// (`createPortClient`, desktop renderer, store channel v2 of @cashu/host-protocol/store through main's
// relay to the local host) or ./local (`createSyncClient`, phone and tests).
export type {
  AnyCommand,
  CommandAttempt,
  CommandOutcome,
  ConnectionStatus,
  StoreClient,
  Target,
} from "./client/index.js";
export { isStale } from "./client/index.js";
export { StoreBindingError, useStoreClient } from "./react/context.js";
export { ProfileProvider } from "./react/ProfileProvider.js";
export { StoreProvider } from "./react/StoreProvider.js";
export { type CommandHandle, useCommand } from "./react/useCommand.js";
export { useConnection } from "./react/useConnection.js";
export { useProfile } from "./react/useProfile.js";
export { useQuery } from "./react/useQuery.js";
export { useUiAction } from "./react/useUiAction.js";
