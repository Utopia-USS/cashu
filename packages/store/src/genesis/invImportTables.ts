// Table specs of investment accounts, imports, transactions, positions, renames, manual valuations
// and the global instruments + aliases (S26 spec 3.1, 2.3; split from tables.ts by size).
import {
  bool,
  day,
  dayN,
  dec,
  decN,
  int,
  intN,
  jsonList,
  type TableSpec,
  text,
  textN,
  ts,
} from "./columns.js";
import type * as R from "./rows.js";

const ID: readonly string[] = ["id"];

interface InvImportTables {
  readonly invAccountSettings: TableSpec<R.InvAccountSettingsRow>;
  readonly invImportBatches: TableSpec<R.InvImportBatchRow>;
  readonly invTransactions: TableSpec<R.InvTransactionRow>;
  readonly invPositionSnapshots: TableSpec<R.InvPositionSnapshotRow>;
  readonly invInstrumentRenames: TableSpec<R.InvInstrumentRenameRow>;
  readonly invManualValuations: TableSpec<R.InvManualValuationRow>;
  readonly invInstruments: TableSpec<R.InvInstrumentRow>;
  readonly invInstrumentAliases: TableSpec<R.InvInstrumentAliasRow>;
}

export const INV_IMPORT_TABLES: InvImportTables = {
  invAccountSettings: {
    table: "inv_account_settings",
    key: ["account_id"],
    fields: {
      accountId: int,
      wrapper: text,
      importer: textN,
      mappingYaml: textN,
      createdAt: ts,
      updatedAt: ts,
    },
  },
  invImportBatches: {
    table: "inv_import_batches",
    key: ID,
    fields: {
      id: int,
      profileId: int,
      accountId: int,
      importer: text,
      broker: text,
      fileName: text,
      fileSha256: text,
      archivePath: textN,
      txnCount: int,
      duplicateCount: int,
      positionCount: int,
      renameCount: int,
      statusChangeCount: int,
      instrumentCount: int,
      correctionCount: int,
      warnings: jsonList,
      createdAt: ts,
    },
  },
  invTransactions: {
    table: "inv_transactions",
    key: ID,
    fields: {
      id: int,
      accountId: int,
      type: text,
      tradeDate: day,
      settleDate: dayN,
      instrumentId: intN,
      quantity: decN,
      price: decN,
      currency: text,
      grossAmount: dec,
      fee: dec,
      tax: dec,
      cashAmount: dec,
      cashCurrency: text,
      fxRate: decN,
      splitRatio: decN,
      note: textN,
      source: text,
      importBatchId: intN,
      externalRef: textN,
      dedupHash: text,
      createdAt: ts,
    },
  },
  invPositionSnapshots: {
    table: "inv_position_snapshots",
    key: ID,
    fields: {
      id: int,
      accountId: int,
      instrumentId: int,
      asOf: day,
      quantity: dec,
      currency: text,
      avgPrice: decN,
      marketValue: decN,
      importBatchId: intN,
      createdAt: ts,
    },
  },
  invInstrumentRenames: {
    table: "inv_instrument_renames",
    key: ID,
    fields: {
      id: int,
      profileId: int,
      date: day,
      oldInstrumentId: int,
      newInstrumentId: int,
      note: textN,
      importBatchId: intN,
      createdAt: ts,
    },
  },
  invManualValuations: {
    table: "inv_manual_valuations",
    key: ID,
    fields: {
      id: int,
      profileId: int,
      instrumentId: int,
      asOf: day,
      unitValue: dec,
      currency: text,
      note: textN,
      createdAt: ts,
    },
  },
  invInstruments: {
    table: "inv_instruments",
    key: ID,
    fields: {
      id: int,
      name: text,
      currency: text,
      assetClass: text,
      symbol: textN,
      isin: textN,
      mic: textN,
      region: textN,
      sector: textN,
      tags: jsonList,
      needsClassification: bool,
      valuationMode: text,
      status: text,
      createdAt: ts,
      updatedAt: ts,
    },
  },
  invInstrumentAliases: {
    table: "inv_instrument_aliases",
    key: ID,
    fields: {
      id: int,
      instrumentId: int,
      namespace: text,
      value: text,
      guessed: bool,
      createdAt: ts,
    },
  },
};
