// @cashu/node-host: Node-only adapters shared by the Node hosts in apps/ (the CLI,
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
export {
  diagnosticsDir,
  type FoundStartupFailure,
  readHostLogTail,
  readStartupFailureRecord,
  type StartupReportPaths,
  startupReportPaths,
  writeStartupFailureRecord,
  writeStartupFailureReport,
} from "./host/diagnostics.js";
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
  assertUpdateHandoverComplete,
  cancelUpdateAdmission,
  clearUpdateAdmissionAfterReplacement,
  commitUpdateDispatch,
  publishUpdateAdmission,
  readUpdateAdmission,
  recordUpdateHandoverComplete,
  recoverPreparedUpdateAdmission,
  UpdateAdmissionError,
  waitForHostLock,
} from "./host/updateAdmission.js";
export {
  type NodeLanguageOptions,
  type NodeLanguageSource,
  nodeLanguageSource,
} from "./language.js";
export { type ActivationOutcome, activateHost } from "./service/activation.js";
export {
  quoteSystemdArg,
  SYSTEMD_LAUNCHER,
  SYSTEMD_SERVICE,
  SYSTEMD_TIMER,
  type SystemdFiles,
  SystemdHostService,
  type SystemdRunner,
  type SystemdRuntime,
  systemdUnitTexts,
} from "./service/systemd.js";
export type {
  HostService,
  ServiceState,
  ServiceStatus,
  StartOutcome,
} from "./service/types.js";
