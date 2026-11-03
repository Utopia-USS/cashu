// @cashu/store-react/client: the React-free store client (snapshot cache + adapters).
export { type CacheOptions, QueryCache } from "./cache.js";
export { type MessagePortLike, messagePortChannel } from "./channel.js";
export {
  ALWAYS_ONLINE,
  type ConnectionSource,
  ConnectionState,
  type ConnectionStatus,
  isStale,
} from "./connection.js";
export { RemoteStoreError } from "./errors.js";
export { createPortClient, type PortClientOptions } from "./port.js";
export { deepEqual, replaceEqual } from "./structural.js";
export {
  type AnyCommand,
  type Channel,
  type CommandAttempt,
  type CommandOutcome,
  DEVICE_TARGET,
  type QueryEntry,
  type SnapshotState,
  type StoreClient,
  type Target,
} from "./types.js";
