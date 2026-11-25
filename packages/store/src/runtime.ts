// @cashu/store/runtime: what a runtime that opens vault stores in-process needs (the phone,
// `@cashu/store-react/local`): the engine, the built-in modules it folds with, the expo-sqlite adapter,
// the command runner and writer, the event catalog and the view hash. The root `@cashu/store` also
// re-exports every module's commands, queries, services and desktop read models; Metro (the phone)
// does not tree-shake, so importing the root there bundles all of them.
export {
  type CommandEnv,
  type CommandResult,
  type EventWriter,
  runCommand,
  storeWriter,
} from "./command.js";
export * as v1 from "./events/v1/index.js";
export { HybridClock } from "./hlc.js";
export { Store, type StoreOptions } from "./materialize.js";
export { builtinModules } from "./modules.js";
export { type ViewHash, viewHash } from "./snapshot.js";
export { type ExpoSqliteDatabase, expoSqliteDriver } from "./sql/expo-sqlite.js";
