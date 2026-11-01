/** Read-only data sources for the TS parity producers (see packages/parity/README.md "Sources"). */

export type { Dataset } from "./datasets.ts";
export {
  DATASET_CLOCKS,
  datasetAsOf,
  datasetDir,
  goldenRoot,
  isDataset,
  labRoot,
} from "./datasets.ts";
export type {
  InvAliasRow,
  InvFxRateRow,
  InvInstrumentRow,
  InvManualValuationRow,
  InvPriceBarRow,
  InvProfileInstrumentRow,
  InvRenameRow,
  InvTransactionRow,
} from "./investments.ts";
export type {
  AssetDetailRow,
  DepreciationRow,
  LoanRow,
  RecordedBalanceRow,
} from "./loansAssets.ts";
export type { KeySpec, SqlRows, SqlValue } from "./naturalKeys.ts";
export { digest, NaturalKeys, SPECS } from "./naturalKeys.ts";
export type {
  AccountRow,
  BalanceRow,
  GenesisFiles,
  OpenOptions,
  ProfileRow,
  TransactionRow,
} from "./pythonDb.ts";
export { manifest, PythonDb, SourceChangedError, withPythonDb } from "./pythonDb.ts";
