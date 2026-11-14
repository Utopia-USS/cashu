export {
  BUDGET_IMPORT_FORMAT,
  BUDGET_IMPORT_FORMAT_VERSION,
  BUDGET_IMPORTER_ID,
  LEGACY_BUDGET_IMPORT_FORMAT,
  LEGACY_BUDGET_IMPORTER_ID,
} from "./canonical/constants.js";
export {
  type BudgetValidationReport,
  looksLikeBudgetDocument,
  parseBudgetDocument,
  reportAsDict,
  reportSummary,
  validateBudgetDocument,
} from "./canonical/document.js";
export { type BudgetIssue, formatIssue, type IssueKind, issueCode } from "./canonical/issues.js";
export { BUDGET_IMPORT_SCHEMA_FILE, budgetImportSchemaText } from "./canonical/jsonSchema.js";
export { type CanonicalResult, canonicalOk } from "./canonical/validate.js";
/** Public API of budget ingestion: parsed shapes, Polish formats, the v2 content hash. */

export {
  contentKeyV2,
  dedupHashV2,
  type HashInput,
  merchantKey,
  stripTxDateSuffix,
} from "./contentKey.js";
export { type ImportPlan, planImport, type RowStatus, type StoredTxn } from "./dedup.js";
export { type NewTransaction, toNewTransaction } from "./newTransaction.js";
export { findAccountNumber, parsePlAmount, parsePlDate } from "./plFormats.js";
export {
  csvBankIds,
  detectBank,
  matchScore,
  parseBankStatement,
  parseStatementFile,
} from "./statements/registry.js";
export type { BankId, StatementFailure, StatementResult } from "./statements/result.js";
export {
  type AccountNumberOrigin,
  type DatedAmount,
  memo,
  type ParsedStatement,
  type RawJson,
  type RawTransaction,
  type TxnSource,
} from "./types.js";
