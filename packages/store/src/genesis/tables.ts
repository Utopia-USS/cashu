// Table specs of the genesis source reader (S26 spec 3.1, 2.3): which Python tables genesis reads,
// their unique read order, and the codec of each column. Core, budget, loans, assets, agent layer
// and connector bindings here; investment imports and instruments in invImportTables.ts, the
// investments owner / agent state in invStateTables.ts. `PythonTables` is the decoded shape
// `readPythonSource` returns.
import {
  bool,
  day,
  dayN,
  dec,
  decN,
  int,
  intN,
  jsonN,
  jsonObject,
  source,
  type TableSpec,
  text,
  textN,
  ts,
  tsN,
} from "./columns.js";
import { INV_IMPORT_TABLES } from "./invImportTables.js";
import type * as S from "./invStateRows.js";
import { INV_STATE_TABLES } from "./invStateTables.js";
import type * as R from "./rows.js";

export interface PythonTables {
  readonly profiles: readonly R.ProfileRow[];
  readonly profileModules: readonly R.ProfileModuleRow[];
  readonly accounts: readonly R.AccountRow[];
  readonly balances: readonly R.BalanceRow[];
  readonly transactions: readonly R.TransactionRow[];
  readonly categoryRules: readonly R.CategoryRuleRow[];
  readonly importBatches: readonly R.ImportBatchRow[];
  readonly loans: readonly R.LoanRow[];
  readonly depreciations: readonly R.DepreciationRow[];
  readonly assetDetails: readonly R.AssetDetailsRow[];
  readonly invAccountSettings: readonly R.InvAccountSettingsRow[];
  readonly invImportBatches: readonly R.InvImportBatchRow[];
  readonly invTransactions: readonly R.InvTransactionRow[];
  readonly invPositionSnapshots: readonly R.InvPositionSnapshotRow[];
  readonly invInstrumentRenames: readonly R.InvInstrumentRenameRow[];
  readonly invManualValuations: readonly R.InvManualValuationRow[];
  readonly invInstruments: readonly R.InvInstrumentRow[];
  readonly invInstrumentAliases: readonly R.InvInstrumentAliasRow[];
  readonly invProfileInstruments: readonly S.InvProfileInstrumentRow[];
  readonly invStrategyVersions: readonly S.InvStrategyVersionRow[];
  readonly invTheses: readonly S.InvThesisRow[];
  readonly invTopicTheses: readonly S.InvTopicThesisRow[];
  readonly watchlistItems: readonly S.WatchlistItemRow[];
  readonly alerts: readonly S.AlertRow[];
  readonly invPlannedDeposits: readonly S.InvPlannedDepositRow[];
  readonly invSignals: readonly S.InvSignalRow[];
  readonly invRuleRuns: readonly S.InvRuleRunRow[];
  readonly invDecisions: readonly S.InvDecisionRow[];
  readonly invDecisionSignals: readonly S.InvDecisionSignalRow[];
  readonly invNotificationLog: readonly S.InvNotificationRow[];
  readonly researchRuns: readonly S.ResearchRunRow[];
  readonly researchNotes: readonly S.ResearchNoteRow[];
  readonly reviews: readonly R.ReviewRow[];
  readonly proposals: readonly R.ProposalRow[];
  readonly connectorBindings: readonly R.ConnectorBindingRow[];
}

export type TableSpecs = { readonly [K in keyof PythonTables]: TableSpec<PythonTables[K][number]> };

const ID: readonly string[] = ["id"];

export const TABLES: TableSpecs = {
  profiles: {
    table: "profiles",
    key: ID,
    fields: {
      id: int,
      slug: text,
      name: text,
      baseCurrency: text,
      mcpPrivacy: text,
      createdAt: ts,
    },
  },
  profileModules: {
    table: "profile_modules",
    key: ["profile_id", "module_id"],
    fields: { profileId: int, moduleId: text, enabled: bool, enabledAt: ts },
  },
  accounts: {
    table: "accounts",
    key: ID,
    fields: {
      id: int,
      profileId: int,
      bank: text,
      name: text,
      iban: textN,
      externalId: textN,
      currency: text,
      type: text,
      active: bool,
      createdAt: ts,
      removedAt: tsN,
    },
  },
  balances: {
    table: "balances",
    key: ID,
    fields: {
      id: int,
      accountId: int,
      date: day,
      amount: dec,
      currency: text,
      source,
      createdAt: ts,
    },
  },
  transactions: {
    table: "transactions",
    key: ID,
    fields: {
      id: int,
      accountId: int,
      bookingDate: day,
      valueDate: dayN,
      amount: dec,
      currency: text,
      counterpartyName: textN,
      counterpartyIban: textN,
      description: textN,
      reference: textN,
      bankTransactionId: textN,
      source,
      dedupHash: text,
      occurrence: int,
      transferGroupId: textN,
      isInternalTransfer: bool,
      category: textN,
      categorySource: textN,
      raw: jsonN,
      importBatchId: intN,
      createdAt: ts,
    },
  },
  categoryRules: {
    table: "category_rules",
    key: ID,
    fields: {
      id: int,
      profileId: int,
      merchantKey: text,
      category: text,
      source: text,
      locked: bool,
      createdAt: ts,
    },
  },
  importBatches: {
    table: "import_batches",
    key: ID,
    fields: {
      id: int,
      profileId: int,
      source,
      bank: textN,
      accountId: intN,
      filename: textN,
      startedAt: ts,
      finishedAt: tsN,
      numSeen: int,
      numInserted: int,
      numDuplicates: int,
      notes: textN,
    },
  },
  loans: {
    table: "loans",
    key: ID,
    fields: {
      id: int,
      accountId: int,
      principal: dec,
      annualRate: dec,
      termMonths: int,
      startDate: day,
      originationDate: dayN,
      paymentIban: textN,
      paymentText: textN,
      createdAt: ts,
      updatedAt: ts,
    },
  },
  depreciations: {
    table: "depreciations",
    key: ID,
    fields: {
      id: int,
      accountId: int,
      purchasePrice: dec,
      purchaseDate: day,
      annualRate: dec,
      floor: decN,
      createdAt: ts,
    },
  },
  assetDetails: {
    table: "asset_details",
    key: ID,
    fields: { id: int, accountId: int, note: textN, createdAt: ts, updatedAt: ts },
  },
  ...INV_IMPORT_TABLES,
  ...INV_STATE_TABLES,
  reviews: {
    table: "reviews",
    key: ID,
    fields: { id: int, profileId: int, module: text, doneAt: ts, notes: textN, stats: jsonObject },
  },
  proposals: {
    table: "proposals",
    key: ID,
    fields: {
      id: int,
      profileId: int,
      kind: text,
      status: text,
      summary: text,
      reason: textN,
      payload: jsonObject,
      result: jsonObject,
      source: text,
      createdAt: ts,
      reviewedAt: tsN,
    },
  },
  connectorBindings: {
    table: "connector_bindings",
    key: ID,
    fields: {
      id: int,
      profileId: int,
      accountId: int,
      connectorId: text,
      paramsJson: jsonObject,
      autoCommit: bool,
      cursor: textN,
      lastRunAt: tsN,
      lastStatus: textN,
      lastOkAt: tsN,
      backoffUntil: tsN,
      createdAt: ts,
      updatedAt: ts,
    },
  },
};
