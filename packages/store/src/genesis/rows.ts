// Genesis source rows (S26 spec 9.2 `rows.ts`, 3.1): one interface per Python table genesis reads,
// snake_case columns as camelCase fields, values decoded per spec 2.3: INTEGER -> number, BOOLEAN ->
// boolean, DecimalText / DATETIME / DATE -> canonical strings, `Source` -> its value, JSON ->
// unknown. Not read: the caches (price bars, fx, macro), change_events, mcp_calls, connectors,
// connector_runs, sync_*. Rows are local-id shaped; gids come later (ids.ts). The investments
// owner / agent state rows are in invStateRows.ts (split by size).
import type { Source } from "./values.js";

/** Decimal text in plain notation (`DECIMAL_RE`). */
type Dec = string;
/** `YYYY-MM-DDTHH:MM:SS[.f]Z`. */
type Ts = string;
/** `YYYY-MM-DD`. */
type Day = string;

export interface ProfileRow {
  readonly id: number;
  readonly slug: string;
  readonly name: string;
  readonly baseCurrency: string;
  readonly mcpPrivacy: string;
  readonly createdAt: Ts;
}

export interface ProfileModuleRow {
  readonly profileId: number;
  readonly moduleId: string;
  readonly enabled: boolean;
  readonly enabledAt: Ts;
}

export interface AccountRow {
  readonly id: number;
  readonly profileId: number;
  readonly bank: string;
  readonly name: string;
  readonly iban: string | null;
  readonly externalId: string | null;
  readonly currency: string;
  readonly type: string;
  readonly active: boolean;
  readonly createdAt: Ts;
  readonly removedAt: Ts | null;
}

export interface BalanceRow {
  readonly id: number;
  readonly accountId: number;
  readonly date: Day;
  readonly amount: Dec;
  readonly currency: string;
  readonly source: Source;
  readonly createdAt: Ts;
}

export interface TransactionRow {
  readonly id: number;
  readonly accountId: number;
  readonly bookingDate: Day;
  readonly valueDate: Day | null;
  readonly amount: Dec;
  readonly currency: string;
  readonly counterpartyName: string | null;
  readonly counterpartyIban: string | null;
  readonly description: string | null;
  readonly reference: string | null;
  readonly bankTransactionId: string | null;
  readonly source: Source;
  readonly dedupHash: string;
  readonly occurrence: number;
  readonly transferGroupId: string | null;
  readonly isInternalTransfer: boolean;
  readonly category: string | null;
  readonly categorySource: string | null;
  readonly raw: unknown;
  readonly importBatchId: number | null;
  readonly createdAt: Ts;
}

export interface CategoryRuleRow {
  readonly id: number;
  readonly profileId: number;
  readonly merchantKey: string;
  readonly category: string;
  readonly source: string;
  readonly locked: boolean;
  readonly createdAt: Ts;
}

export interface ImportBatchRow {
  readonly id: number;
  readonly profileId: number;
  readonly source: Source;
  readonly bank: string | null;
  readonly accountId: number | null;
  readonly filename: string | null;
  readonly startedAt: Ts;
  readonly finishedAt: Ts | null;
  readonly numSeen: number;
  readonly numInserted: number;
  readonly numDuplicates: number;
  readonly notes: string | null;
}

export interface LoanRow {
  readonly id: number;
  readonly accountId: number;
  readonly principal: Dec;
  readonly annualRate: Dec;
  readonly termMonths: number;
  readonly startDate: Day;
  readonly originationDate: Day | null;
  readonly paymentIban: string | null;
  readonly paymentText: string | null;
  readonly createdAt: Ts;
  readonly updatedAt: Ts;
}

export interface DepreciationRow {
  readonly id: number;
  readonly accountId: number;
  readonly purchasePrice: Dec;
  readonly purchaseDate: Day;
  readonly annualRate: Dec;
  readonly floor: Dec | null;
  readonly createdAt: Ts;
}

export interface AssetDetailsRow {
  readonly id: number;
  readonly accountId: number;
  readonly note: string | null;
  readonly createdAt: Ts;
  readonly updatedAt: Ts;
}

export interface InvAccountSettingsRow {
  readonly accountId: number;
  readonly wrapper: string;
  readonly importer: string | null;
  readonly mappingYaml: string | null;
  readonly createdAt: Ts;
  readonly updatedAt: Ts;
}

export interface InvImportBatchRow {
  readonly id: number;
  readonly profileId: number;
  readonly accountId: number;
  readonly importer: string;
  readonly broker: string;
  readonly fileName: string;
  readonly fileSha256: string;
  readonly archivePath: string | null;
  readonly txnCount: number;
  readonly duplicateCount: number;
  readonly positionCount: number;
  readonly renameCount: number;
  readonly statusChangeCount: number;
  readonly instrumentCount: number;
  readonly correctionCount: number;
  readonly warnings: unknown;
  readonly createdAt: Ts;
}

export interface InvTransactionRow {
  readonly id: number;
  readonly accountId: number;
  readonly type: string;
  readonly tradeDate: Day;
  readonly settleDate: Day | null;
  readonly instrumentId: number | null;
  readonly quantity: Dec | null;
  readonly price: Dec | null;
  readonly currency: string;
  readonly grossAmount: Dec;
  readonly fee: Dec;
  readonly tax: Dec;
  readonly cashAmount: Dec;
  readonly cashCurrency: string;
  readonly fxRate: Dec | null;
  readonly splitRatio: Dec | null;
  readonly note: string | null;
  /** The investments `TxnSource` value (`import`, `manual`, `reconciliation`, ...), stored as is. */
  readonly source: string;
  readonly importBatchId: number | null;
  readonly externalRef: string | null;
  readonly dedupHash: string;
  readonly createdAt: Ts;
}

export interface InvPositionSnapshotRow {
  readonly id: number;
  readonly accountId: number;
  readonly instrumentId: number;
  readonly asOf: Day;
  readonly quantity: Dec;
  readonly currency: string;
  readonly avgPrice: Dec | null;
  readonly marketValue: Dec | null;
  readonly importBatchId: number | null;
  readonly createdAt: Ts;
}

export interface InvInstrumentRenameRow {
  readonly id: number;
  readonly profileId: number;
  readonly date: Day;
  readonly oldInstrumentId: number;
  readonly newInstrumentId: number;
  readonly note: string | null;
  readonly importBatchId: number | null;
  readonly createdAt: Ts;
}

export interface InvManualValuationRow {
  readonly id: number;
  readonly profileId: number;
  readonly instrumentId: number;
  readonly asOf: Day;
  readonly unitValue: Dec;
  readonly currency: string;
  readonly note: string | null;
  readonly createdAt: Ts;
}

/** Global in Python (no profile): exported per vault through the reference closure (4.6). */
export interface InvInstrumentRow {
  readonly id: number;
  readonly name: string;
  readonly currency: string;
  readonly assetClass: string;
  readonly symbol: string | null;
  readonly isin: string | null;
  readonly mic: string | null;
  readonly region: string | null;
  readonly sector: string | null;
  readonly tags: unknown;
  readonly needsClassification: boolean;
  readonly valuationMode: string;
  readonly status: string;
  readonly createdAt: Ts;
  readonly updatedAt: Ts;
}

/** Global in Python, like its instrument. */
export interface InvInstrumentAliasRow {
  readonly id: number;
  readonly instrumentId: number;
  readonly namespace: string;
  readonly value: string;
  readonly guessed: boolean;
  readonly createdAt: Ts;
}

export interface ReviewRow {
  readonly id: number;
  readonly profileId: number;
  readonly module: string;
  readonly doneAt: Ts;
  readonly notes: string | null;
  readonly stats: unknown;
}

export interface ProposalRow {
  readonly id: number;
  readonly profileId: number;
  readonly kind: string;
  readonly status: string;
  readonly summary: string;
  readonly reason: string | null;
  readonly payload: unknown;
  readonly result: unknown;
  readonly source: string;
  readonly createdAt: Ts;
  readonly reviewedAt: Ts | null;
}

/**
 * Config (synced) plus the leader-local fetch state (`lastRunAt`, `lastStatus`, `lastOkAt`,
 * `backoffUntil`): never in an event, only in the device-local sidecar (spec 3.1, D-G10).
 */
export interface ConnectorBindingRow {
  readonly id: number;
  readonly profileId: number;
  readonly accountId: number;
  readonly connectorId: string;
  readonly paramsJson: unknown;
  readonly autoCommit: boolean;
  readonly cursor: string | null;
  readonly lastRunAt: Ts | null;
  readonly lastStatus: string | null;
  readonly lastOkAt: Ts | null;
  readonly backoffUntil: Ts | null;
  readonly createdAt: Ts;
  readonly updatedAt: Ts;
}
