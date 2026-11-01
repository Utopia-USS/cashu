// @cashu/node-host: Node-only adapters shared by the Node hosts in apps/ (the CLI, the sync daemon,
// the local host process and its clients; later parity tooling). `host/` is the local host's platform
// glue (S56): the machine lock, run paths, the socket server and client, connect-or-start. Only apps import it (depcruise
// `node-host-is-for-apps`); every other package stays platform free and receives these through the
// interfaces wired at an app root (`SqlDriver`, `FolderFs`).
export { NodeFolderFs } from "./folderFs.js";
export {
  type GuardedPath,
  type GuardedPaths,
  RefusalError,
  refusePaths,
  resolveReal,
} from "./guard.js";
export {
  type ConnectHostOptions,
  connectHost,
  HostCallError,
  HostConnectError,
  type HostConnectErrorKind,
  type HostConnection,
} from "./host/client.js";
export {
  type ConnectOrStartOptions,
  type ConnectOrStartResult,
  connectOrStart,
  HOST_UNAVAILABLE_EXIT,
  HostStartError,
} from "./host/connectOrStart.js";
export { readDiscovery, readHostToken } from "./host/files.js";
export { acquireHostLock, HostLock } from "./host/lock.js";
export {
  ensurePrivateDir,
  type HostPathEnv,
  HostPathError,
  type HostRunPaths,
  hostRunPaths,
  MAX_SOCKET_PATH_BYTES,
} from "./host/paths.js";
export {
  HOST_BUSY_EXIT,
  HostBusyError,
  type HostSession,
  type RunningHost,
  type StartHostOptions,
  startHost,
} from "./host/server.js";
export { type SpawnHostOptions, spawnDetachedHost } from "./host/spawn.js";
export {
  type NodeLanguageOptions,
  type NodeLanguageSource,
  nodeLanguageSource,
} from "./language.js";
// TRANSITIONAL(S56c): the sync daemon still opens its databases through this root re-export; the
// driver's entry is `@cashu/node-host/sqlite`, which depcruise `only-host-opens-stores` keeps to
// apps/host. Remove these lines when S56c moves the daemon's loop into the host.
export {
  ExclusiveOpenError,
  type NodeSqliteOptions,
  openNodeSqlite,
  ReadOnlyDriverError,
} from "./nodeSqlite.js";
