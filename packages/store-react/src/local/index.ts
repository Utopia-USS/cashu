// @cashu/store-react/local: the store engine in this runtime (the phone, tests): open stores, the
// synchronous client. Kept apart from ./client so the desktop renderer never bundles the engine.
export { type LocalStores, UnknownTargetError, type VaultHandle } from "./stores.js";
export { createSyncClient } from "./sync.js";
