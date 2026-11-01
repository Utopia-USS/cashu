// @cashu/node-host: Node-only adapters shared by the Node hosts in apps/ (the CLI, the sync daemon;
// later the desktop store process and parity tooling). Only apps import it (depcruise
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
export { type NodeSqliteOptions, openNodeSqlite, ReadOnlyDriverError } from "./nodeSqlite.js";
