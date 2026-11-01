// @cashu/store: the event-sourced store every runtime uses (desktop utility process, phone, CLI).
// Spec: packages/store/spec/events.md, gid.md. Platform pieces come in through `SqlDriver` adapters.
export {
  addManualPosition,
  revalue,
  setDepreciation,
  setNote,
} from "./assets/commands.js";
export { assetsModule } from "./assets/index.js";
export { deleteCashTransaction, importStatement, setCushion } from "./budget/commands.js";
export { budgetModule } from "./budget/index.js";
export { canonicalJson } from "./canonical.js";
export {
  type Clock,
  type Command,
  type CommandContext,
  type CommandEnv,
  type CommandOutcome,
  type CommandRefusal,
  type CommandResult,
  defineCommand,
  type EmitOptions,
  type EventWriter,
  InvalidEmitError,
  type Lease,
  ok,
  refuse,
  runCommand,
  storeWriter,
} from "./command.js";
export {
  createProfile,
  openAccount,
  recordBalance,
  removeAccount,
  renameAccount,
  renameProfile,
  restoreAccount,
  setAccountType,
  setModules,
  setProfileSettings,
} from "./core/commands.js";
export { coreModule } from "./core/index.js";
export {
  CONTRIBUTIONS,
  type Contributions,
  type DeriveContext,
  type DerivedWrite,
  type Deriver,
  type DirtyPartitions,
  type FoldContext,
  type FoldEvent,
  type FoldMembers,
  type IdentityClaim,
  type IdentityConflict,
  type IdentityKind,
  type Materializer,
  type ModuleContributions,
  type ViewSql,
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
export * as investmentsCommands from "./investments/commands/index.js";
export { investmentsModule } from "./investments/index.js";
export * as investmentsPerformance from "./investments/performance/index.js";
export * as investmentsQueries from "./investments/queries/index.js";
export * as investmentsResearch from "./investments/research/index.js";
export { addLoan, setLoan, setPaymentMatching } from "./loans/commands.js";
export { loansModule } from "./loans/index.js";
export {
  type ApplyResult,
  isCorruption,
  Store,
  StoreCorruptError,
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
