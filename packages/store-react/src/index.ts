// @cashu/store-react: React bindings over the event store (data-flow.md). Clients come from ./client
// (`createPortClient`, desktop renderer) or ./local (`createSyncClient`, phone and tests); the port
// protocol is ./protocol and the store process side ./host.
export type { AnyCommand, StoreClient, Target } from "./client/index.js";
export { StoreBindingError, useStoreClient } from "./react/context.js";
export { ProfileProvider } from "./react/ProfileProvider.js";
export { StoreProvider } from "./react/StoreProvider.js";
export { type CommandHandle, useCommand } from "./react/useCommand.js";
export { useProfile } from "./react/useProfile.js";
export { useQuery } from "./react/useQuery.js";
