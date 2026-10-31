/**
 * Importing contract of the investments module (S17a): the broker import contract, the canonical
 * `cashu-import` format (CSV and JSON), text decoding, cell value parsing, amount derivation, file
 * validation and the JSON Schema of the format. Pure: bytes in, parsed rows and warnings out.
 */

export {
  CANONICAL_BROKER_ID,
  CANONICAL_FORMAT,
  CANONICAL_FORMAT_VERSION,
  CanonicalImporter,
  CSV_COLUMNS,
  canonicalImporterId,
  FILE_FIELDS,
  JSON_TOP_LEVEL_KEYS,
  LEGACY_BROKER_ID,
  LEGACY_FORMAT,
  parseCanonicalCsv,
  parseCanonicalJson,
  RECORD_FIELDS,
  RECORD_KINDS,
  REQUIRED_CSV_COLUMNS,
  RecordKind,
} from "./canonical/index.js";
export {
  type AmountFailure,
  type AmountOutcome,
  CASH_INFLOW_TYPES,
  CASH_NEUTRAL_TYPES,
  CASH_OUTFLOW_TYPES,
  cashFromGross,
  type DerivedAmounts,
  type DeriveInput,
  deriveAmounts,
  grossFromCash,
  signedCash,
  toCashCurrency,
  toTradeCurrency,
} from "./cash.js";
export * from "./contract.js";
export {
  type DatedTime,
  type DateParse,
  type DatePattern,
  DECIMAL_SEPARATORS,
  type DecimalFormat,
  type DecimalParse,
  datePattern,
  decimalFormat,
  type PatternParse,
  parseDatetimeWithPatterns,
  parseDateWithPatterns,
  parseDecimal,
  THOUSANDS_SEPARATORS,
  tryParseDate,
  tryParseDatetime,
} from "./csvValues.js";
export { didYouMean } from "./didYouMean.js";
export { IMPORT_SCHEMA_FILE, importSchema, importSchemaText, SCHEMA_DRAFT } from "./jsonSchema.js";
export { DuplicateImporterError, ImporterRegistry, safeCanParse } from "./registry.js";
export { NEEDS_INSTRUMENT, NEEDS_QUANTITY, semanticIssues } from "./semantic.js";
export {
  decodeImportText,
  ENCODING_NAMES,
  hasUtf8Bom,
  ImportTextEncoding,
  parseEncoding,
  type TextDecodeFailure,
  type TextDecodeResult,
} from "./text.js";
export {
  MAX_FILE_BYTES,
  reportCorporateActionCount,
  reportOk,
  reportPositionCount,
  reportSummary,
  reportTxnCount,
  type ValidationReport,
  validateImport,
  validateImportFile,
} from "./validation.js";
