// @cashu/host-protocol/startup-failure: typed start-up / migration failures, their wire schemas, the
// allow-list redaction and the copy-paste agent prompt (T54 recovery screen). Platform free: the
// host, the migration CLI and Electron main do the file I/O; the renderer only parses and renders.
export {
  classifyStartupError,
  countFacts,
  errorCode,
  failureDetail,
  STARTUP_FACT_KEYS,
  STARTUP_FAILURE_CODES,
  STARTUP_FAILURE_DETAIL_NAMES,
  STARTUP_FAILURE_DETAILS,
  STARTUP_FAILURE_SPECS,
  STARTUP_STAGES,
  type StartupFacts,
  type StartupFailure,
  type StartupFailureCode,
  type StartupFailureDetail,
  StartupFailureError,
  type StartupStage,
  startupFailure,
} from "./codes.js";
export {
  appDisplayPath,
  commandPrefix,
  type RecoveryCommand,
  type RecoveryCommandInput,
  recoveryCommand,
  recoveryCommandSchema,
} from "./command.js";
export {
  MIGRATE_CANCEL,
  MIGRATE_CONFIRM,
  MIGRATE_STAGES,
  MIGRATE_UNPRICED_LABEL_MAX,
  MIGRATE_UNPRICED_MAX,
  type MigrateDone,
  type MigrateFailed,
  type MigrateLine,
  type MigrateStage,
  migrateDoneSchema,
  migrateFailedSchema,
  migrateLineSchema,
  migrateProgressSchema,
  migrateWordsSchema,
  parseMigrateLine,
  RECOVERY_WORDS,
  type RecoveryImportEvent,
  recoveryImportEventSchema,
  type UnpricedInstrument,
  unpricedInstrumentSchema,
} from "./migrateProtocol.js";
export { buildRecoveryPrompt, MIGRATION_RUNBOOK, recoveryCommands } from "./prompt.js";
export { PROMPT, type PromptLang } from "./prompt.strings.js";
export {
  appVersionLabel,
  buildLabel,
  formatLogLine,
  homeRelativePath,
  LOG_EVENTS,
  OUTSIDE_HOME,
  type SanitizedLogLine,
  type SanitizedLogTail,
  sanitizeLogTail,
} from "./redaction.js";
export { type StartupFailureContext, startupFailureReport } from "./report.js";
export {
  DIAGNOSTICS_DIR,
  MAX_FAILURE_FILE_BYTES,
  parseStartupFailureRecord,
  parseStartupFailureReport,
  STARTUP_FAILURE_RECORD,
  type StartupFailureRecord,
  type StartupFailureReport,
  startupFailureRecordSchema,
  startupFailureReportSchema,
} from "./schema.js";
