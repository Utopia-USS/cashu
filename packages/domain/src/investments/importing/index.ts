/**
 * Importing of the investments module: the broker import contract, the canonical `cashu-import` format
 * (CSV and JSON), the generic CSV importer and its YAML mapping, exchange hints, text decoding, cell
 * value parsing, amount derivation, file validation, the JSON Schema of the format (S17a, S17b), and
 * the pure import pipeline: instrument resolution, dedup hashes, chronological ordering, the import
 * plan and position reconciliation (S17c). Pure: bytes in, plans out; the store writes.
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
  AmountSign,
  CSV_FIELDS,
  CsvField,
  type CsvMapping,
  type CsvMappingInit,
  type CsvMappingIssue,
  type CsvMappingParse,
  csvMapping,
  csvMappingErrorText,
  csvMappingFromYaml,
  csvMappingIssueText,
  DEFAULT_DATE_FORMATS,
  DEFAULT_EXTENSIONS,
  GENERIC_CSV_BROKER_ID,
  IGNORE_TYPE,
  KNOWN_KEYS,
  MAPPING_VERSION,
  MAX_MAPPING_CHARS,
  RowErrorPolicy,
} from "./csvMapping.js";
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
  parseDatePattern,
  parseDatetimeWithPatterns,
  parseDateWithPatterns,
  parseDecimal,
  THOUSANDS_SEPARATORS,
  tryParseDate,
  tryParseDatetime,
} from "./csvValues.js";
export {
  contentKey,
  type DedupInput,
  type DedupInputInit,
  type DedupScope,
  decimalKey,
  dedupHash,
  dedupHashes,
  dedupInput,
  dedupInputFromParsed,
  dedupInputFromTransaction,
  dedupRef,
  fillKey,
  HASH_VERSION,
  occurrenceKey,
  parsedDedupInputs,
  reconciliationHash,
} from "./dedup.js";
export { didYouMean } from "./didYouMean.js";
export {
  CRYPTO,
  CRYPTO_TICKERS,
  cryptoBase,
  type ExchangeInfo,
  exchangeForHint,
  exchangeForMic,
  exchangeForYahooSuffix,
  isCryptoSymbol,
  MARKETS,
  type SplitSymbol,
  splitBrokerSymbol,
  stooqSymbol,
  US_LISTING,
  yahooSymbol,
} from "./exchanges.js";
export { GenericCsvImporter, ISIN_PATTERN, SNIFF_BYTES } from "./genericCsv.js";
export { IMPORT_SCHEMA_FILE, importSchema, importSchemaText, SCHEMA_DRAFT } from "./jsonSchema.js";
export {
  chronologicalRanks,
  createdAtStamps,
  DEFAULT_STEP_MICROS,
  isNewestFirst,
} from "./ordering.js";
export {
  type ImportPlan,
  type PlanImportOptions,
  type PlannedPosition,
  type PlannedRename,
  type PlannedRow,
  type PlannedStatusChange,
  planCanCommit,
  planDuplicateCount,
  planImport,
  planNewCount,
  transactionsToInsert,
} from "./plan.js";
export {
  type BrokerPosition,
  type BrokerPositionInit,
  brokerPosition,
  brokerPositionFromParsed,
  type PositionDiff,
  PositionDiffKind,
  type ProposedCorrection,
  positionDelta,
  type ReconcileOptions,
  type ReconciliationReport,
  reconcile,
  reportIsClean,
  reportMismatches,
} from "./reconciler.js";
export {
  DuplicateImporterError,
  defaultRegistry,
  ImporterRegistry,
  safeCanParse,
} from "./registry.js";
export {
  CurrencyEvidence,
  evidenceOf,
  guessAssetClass,
  hintFromPosition,
  hintFromTxn,
  hintIsEmpty,
  InMemoryInstrumentLookup,
  type InstrumentHint,
  type InstrumentHintInit,
  type InstrumentLookup,
  InstrumentMatch,
  InstrumentResolver,
  instrumentHint,
  isNewInstrument,
  type ResolvedInstrument,
  TRADE_TYPES,
} from "./resolver.js";
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
