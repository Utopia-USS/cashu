// @cashu/node-host/sqlite: the node:sqlite `SqlDriver`, the way a Node process opens a database file.
// Opening stores is the local host's job: depcruise `only-host-opens-stores` lets only apps/host (and
// the Expo app, with its own driver) import this entry or a SQLite binding.
export {
  backupNodeSqlite,
  ExclusiveOpenError,
  type NodeSqliteOptions,
  openNodeSqlite,
  ReadOnlyDriverError,
} from "./nodeSqlite.js";
