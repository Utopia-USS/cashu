// @cashu/store: the event-sourced store every runtime uses (desktop utility process, phone, CLI).
// Spec: packages/store/spec/events.md, gid.md. Platform pieces come in through `SqlDriver` adapters.
export { budgetModule } from "./budget/index.js";
export { canonicalJson } from "./canonical.js";
export { coreModule } from "./core/index.js";
export type {
  FoldContext,
  FoldEvent,
  FoldMembers,
  IdentityClaim,
  IdentityConflict,
  IdentityKind,
  Materializer,
  ViewSql,
} from "./engine/types.js";
export { type Decoded, decodeEnvelope, decodeWire, type ParkReason } from "./envelope.js";
export * as v1 from "./events/v1/index.js";
export {
  type DetGid,
  detGid,
  detGidFor,
  type GidTable,
  mintUlid,
  newVaultSalt,
  type VaultSalt,
  vaultSalt,
} from "./gid.js";
export { HybridClock, type MetaClockStore, metaClockStore } from "./hlc.js";
export { investmentsModule } from "./investments/index.js";
export {
  type ApplyResult,
  Store,
  type StoreOptions,
  type WireBatch,
} from "./materialize.js";
export { builtinModules } from "./modules.js";
export {
  EventRegistry,
  type EventTypeDef,
  type EventVersionDef,
  ModuleRegistry,
  type StoreModule,
} from "./registry.js";
export {
  exportSnapshot,
  importSnapshot,
  type StoreSnapshot,
  type ViewHash,
  viewHash,
} from "./snapshot.js";
export { type BetterSqlite3Database, betterSqlite3Driver } from "./sql/better-sqlite3.js";
export type { ColumnDef, ColumnType, IndexDef, TableDef } from "./sql/ddl.js";
export type { SqlDriver, SqlRow, SqlRunResult, SqlStatement, SqlValue } from "./sql/driver.js";
export { type ExpoSqliteDatabase, expoSqliteDriver } from "./sql/expo-sqlite.js";
export type { TablesListener } from "./subscribe.js";
export type { Payload, Upcaster } from "./upcast.js";
