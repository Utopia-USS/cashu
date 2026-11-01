/**
 * The pure core of an import preview: resolve, validate, hash and order one parsed file (port of
 * `importing/plan.py`).
 *
 * `planImport` is the import preview without the store: the caller supplies an `InstrumentLookup` and
 * a function telling which dedup hashes are already stored, then writes the plan on commit (new
 * instruments, new aliases, non-duplicate transactions, position snapshot rows, renames and status
 * changes).
 */

import { addMicroseconds, type DateTime, toStorage } from "../../dates.js";
import {
  type AccountId,
  EPOCH,
  type ImportBatchId,
  type Instrument,
  type InstrumentAlias,
  type InstrumentId,
  type InstrumentRename,
  InstrumentStatus,
  InvariantError,
  instrumentRename,
  type Transaction,
  type TxnId,
  TxnSource,
  transaction,
} from "../domain/index.js";
import {
  type ImportParseResult,
  type ImportWarning,
  ImportWarningKind,
  importWarning,
  type ParsedDelisting,
  type ParsedRename,
  type ParsedTxn,
} from "./contract.js";
import {
  dedupHash,
  dedupHashes,
  dedupInputFromParsed,
  HASH_VERSION_V2,
  occurrenceKey,
} from "./dedup.js";
import {
  candidateInstrumentKeys,
  type InstrumentKeySubject,
  instrumentKeyV2,
} from "./instrumentKey.js";
import { chronologicalRanks } from "./ordering.js";
import { type BrokerPosition, brokerPositionFromParsed } from "./reconciler.js";
import {
  CurrencyEvidence,
  hintFromPosition,
  hintFromTxn,
  hintIdentifiers,
  hintIsEmpty,
  type InstrumentLookup,
  type InstrumentMatch,
  InstrumentResolver,
  instrumentHint,
  type ResolvedInstrument,
} from "./resolver.js";
import { semanticIssues } from "./semantic.js";

/** One transaction row of a plan. */
export interface PlannedRow {
  readonly parsed: ParsedTxn;
  /**
   * What a commit writes: planned id, resolved (or planned) instrument id, dedup hash, and a
   * `createdAt` of `now + chronological rank` (re-stamp at commit, keeping the order).
   */
  readonly txn: Transaction;
  /** How the instrument was found; null for rows without an instrument. */
  readonly match: InstrumentMatch | null;
  /** True when a transaction with the same dedup hash is already stored (a commit skips it). */
  readonly isDuplicate: boolean;
}

export interface PlannedPosition {
  readonly parsedIndex: number;
  readonly position: BrokerPosition;
  readonly match: InstrumentMatch;
}

export interface PlannedRename {
  readonly parsed: ParsedRename;
  readonly rename: InstrumentRename;
}

export interface PlannedStatusChange {
  readonly parsed: ParsedDelisting;
  readonly instrumentId: InstrumentId;
  /** `DELISTED`, or `FROZEN` for a frozen delisting. */
  readonly status: InstrumentStatus;
}

/** What committing a parsed file would do. Nothing is written. */
export interface ImportPlan {
  readonly accountId: AccountId;
  /** Alias namespace / batch broker label (the file's `source` or the importer's id). */
  readonly brokerId: string;
  readonly batchId: ImportBatchId | null;
  readonly rows: readonly PlannedRow[];
  readonly positions: readonly PlannedPosition[];
  readonly renames: readonly PlannedRename[];
  readonly statusChanges: readonly PlannedStatusChange[];
  /** Every instrument referenced (existing and planned), by id, in first-reference order. */
  readonly instruments: ReadonlyMap<InstrumentId, Instrument>;
  /** Instruments a commit creates (`needsClassification: true`). */
  readonly newInstruments: readonly Instrument[];
  /** Aliases a commit adds to existing instruments. */
  readonly newAliases: ReadonlyMap<InstrumentId, readonly InstrumentAlias[]>;
  readonly warnings: readonly ImportWarning[];
  readonly blockingErrors: readonly ImportWarning[];
  readonly accountHint: string | null;
}

/** `ImportPlan.can_commit`. */
export function planCanCommit(plan: ImportPlan): boolean {
  return plan.blockingErrors.length === 0;
}

/** `ImportPlan.new_count`. */
export function planNewCount(plan: ImportPlan): number {
  return plan.rows.filter((row) => !row.isDuplicate).length;
}

/** `ImportPlan.duplicate_count`. */
export function planDuplicateCount(plan: ImportPlan): number {
  return plan.rows.filter((row) => row.isDuplicate).length;
}

/** `ImportPlan.transactions_to_insert`: non-duplicate transactions in `createdAt` order. */
export function transactionsToInsert(plan: ImportPlan): readonly Transaction[] {
  return plan.rows
    .filter((row) => !row.isDuplicate)
    .map((row) => ({ txn: row.txn, key: toStorage(row.txn.createdAt) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((entry) => entry.txn);
}

/**
 * The v2 dedup identity of a plan (gid.md 4.6): the account's gid replaces the local account id and
 * the broker instrument key (`instrumentKeyV2` over the resolved instrument with the import's aliases
 * added) replaces the local instrument id, so the hashes equal the ones genesis derives from the rows
 * Python stored (and the ones a later re-import computes).
 */
export interface DedupIdentityV2 {
  readonly accountGid: string;
  /** The gid of an instrument (stored or planned), read only by the `gid:` step of the key. */
  readonly instrumentGid: (instrumentId: InstrumentId) => string;
  /**
   * The gids a stored instrument had before merges folded them into its gid (the store's identity
   * record; none for a planned one): rows stored under `gid:<former>` stay duplicates after a merge.
   */
  readonly formerGids?: (instrumentId: InstrumentId) => readonly string[];
}

export interface PlanImportOptions {
  readonly accountId: AccountId;
  /** The alias namespace (use `effectiveBrokerId(importer, result)`). */
  readonly brokerId: string;
  readonly lookup: InstrumentLookup;
  /** The subset of `hashes` already stored (default: none). */
  readonly existingHashes?: (hashes: readonly string[]) => Iterable<string>;
  readonly batchId?: ImportBatchId | null;
  /** Base of the rows' `createdAt` (default the epoch). */
  readonly now?: DateTime;
  readonly txnIdFactory: () => TxnId;
  readonly instrumentIdFactory: () => InstrumentId;
  /**
   * Hash with the store's v2 identity instead of Python's v1 (local ids, the default). v2 counts
   * occurrences in chronological rank order, as the Python commit does when it writes the hashes,
   * and a row is a duplicate when its hash OR the hash under any other key its instrument has had
   * (`candidateInstrumentKeys`) is stored; each stored hash absorbs at most one row of the file.
   */
  readonly dedupV2?: DedupIdentityV2;
}

/**
 * Resolve, validate, hash and order `result` for an account. Rows are ranked chronologically (R9) into
 * `createdAt = now + rank ms`; hashes follow R8; new instruments follow R10.
 */
export function planImport(result: ImportParseResult, options: PlanImportOptions): ImportPlan {
  const { accountId, brokerId } = options;
  const batchId = options.batchId ?? null;
  const now = options.now ?? EPOCH;
  const warnings: ImportWarning[] = [];
  const blocking: ImportWarning[] = [];
  for (const warning of result.warnings) (warning.blocking ? blocking : warnings).push(warning);

  const resolver = new InstrumentResolver(options.lookup, brokerId, options.instrumentIdFactory);
  const seenNotes = new Set<string>();
  const addNotes = (resolution: ResolvedInstrument, row: number | null): void => {
    for (const note of resolution.notes) {
      if (seenNotes.has(note)) continue;
      seenNotes.add(note);
      warnings.push(importWarning({ message: note, row, kind: ImportWarningKind.INSTRUMENT_NOTE }));
    }
  };

  const txns = result.txns;
  const resolutions: (ResolvedInstrument | null)[] = [];
  for (const txn of txns) {
    const hint = hintFromTxn(txn);
    const resolution = hintIsEmpty(hint) ? null : resolver.resolve(hint);
    if (resolution !== null) addNotes(resolution, txn.rowIndex);
    resolutions.push(resolution);
    blocking.push(...semanticIssues(txn, resolution !== null));
  }

  const positions: PlannedPosition[] = [];
  result.positions.forEach((position, index) => {
    const hint = hintFromPosition(position);
    if (hintIsEmpty(hint)) {
      warnings.push(
        importWarning({
          message: "Position without symbol, ISIN or name skipped",
          kind: ImportWarningKind.MISSING_INSTRUMENT,
        }),
      );
      return;
    }
    const resolution = resolver.resolve(hint);
    addNotes(resolution, null);
    positions.push(
      Object.freeze({
        parsedIndex: index,
        position: brokerPositionFromParsed(position, resolution.instrumentId),
        match: resolution.match,
      }),
    );
  });

  const renames: PlannedRename[] = [];
  const statusChanges: PlannedStatusChange[] = [];
  for (const action of result.corporateActions) {
    if (action.kind === "rename") {
      const planned = planRename(action, resolver, warnings);
      if (planned !== null) renames.push(planned);
      continue;
    }
    const found = resolver.find({
      symbol: action.symbol,
      isin: action.isin,
      exchangeHint: action.exchangeHint,
    });
    if (found === null) {
      warnings.push(
        importWarning({
          message: `Delisting of unknown instrument ${action.symbol} ignored`,
          row: action.rowIndex,
          kind: ImportWarningKind.UNKNOWN_INSTRUMENT,
        }),
      );
      continue;
    }
    statusChanges.push(
      Object.freeze({
        parsed: action,
        instrumentId: found.instrumentId,
        status: action.frozen ? InstrumentStatus.FROZEN : InstrumentStatus.DELISTED,
      }),
    );
  }

  const ranks = chronologicalRanks(txns);
  const v2 =
    options.dedupV2 === undefined
      ? null
      : dedupHashesV2(txns, resolutions, ranks, resolver, brokerId, options.dedupV2);
  const hashes =
    v2?.hashes ??
    dedupHashes(
      txns.map((txn, i) => dedupInputFromParsed(txn, resolutions[i]?.instrumentId ?? null)),
      { accountId, brokerId },
    );
  const asked = v2 === null ? hashes : [...new Set([...hashes, ...v2.candidates.flat()])];
  const existing = new Set(
    asked.length > 0 && options.existingHashes ? options.existingHashes(asked) : [],
  );
  const duplicates =
    v2 === null ? hashes.map((hash) => existing.has(hash)) : claimDuplicates(v2, ranks, existing);

  const rows: PlannedRow[] = txns.map((txn, i) => {
    const resolution = resolutions[i] ?? null;
    const hash = hashes[i] ?? "";
    return Object.freeze({
      parsed: txn,
      match: resolution === null ? null : resolution.match,
      isDuplicate: duplicates[i] ?? false,
      txn: plannedTransaction(txn, {
        txnId: options.txnIdFactory(),
        accountId,
        instrumentId: resolution === null ? null : resolution.instrumentId,
        batchId,
        dedupHash: hash,
        createdAt: addMicroseconds(now, (ranks[i] ?? 0) * 1000),
      }),
    });
  });

  const referenced = new Map<InstrumentId, Instrument>();
  const ids: InstrumentId[] = [
    ...resolutions.flatMap((resolution) => (resolution === null ? [] : [resolution.instrumentId])),
    ...positions.map((planned) => planned.position.instrumentId),
    ...renames.flatMap((planned) => [
      planned.rename.oldInstrumentId,
      planned.rename.newInstrumentId,
    ]),
    ...statusChanges.map((change) => change.instrumentId),
  ];
  for (const instrumentId of ids) {
    const item = resolver.instrument(instrumentId);
    if (item !== null) referenced.set(instrumentId, item);
  }

  return Object.freeze({
    accountId,
    brokerId,
    batchId,
    rows: Object.freeze(rows),
    positions: Object.freeze(positions),
    renames: Object.freeze(renames),
    statusChanges: Object.freeze(statusChanges),
    instruments: referenced,
    newInstruments: resolver.newInstruments,
    newAliases: resolver.newAliases,
    warnings: Object.freeze(warnings),
    blockingErrors: Object.freeze(blocking),
    accountHint: result.accountHint,
  });
}

/**
 * The instrument as a commit leaves it: a planned one with every alias the import learned, a stored
 * one with the planned aliases appended (they are the newest), so the key is the one genesis and a
 * later re-import derive from the stored rows.
 */
function committedInstrument(
  resolver: InstrumentResolver,
  instrumentId: InstrumentId,
): InstrumentKeySubject {
  const current = resolver.instrument(instrumentId);
  if (current === null) throw new InvariantError("a resolved instrument is always remembered");
  if (resolver.isPlanned(instrumentId)) return current;
  const added = resolver.newAliases.get(instrumentId) ?? [];
  return { isin: current.isin, aliases: [...current.aliases, ...added] };
}

interface V2Hashes {
  /** Per row (input order): the hash it is stored under (`instrumentKeyV2`). */
  readonly hashes: readonly string[];
  /** Per row: its hashes under every candidate key (`candidateInstrumentKeys`). */
  readonly candidates: readonly (readonly string[])[];
}

/**
 * gid.md 4.6 hashes of a file's rows (input order), occurrences counted in chronological order, and
 * the candidate hashes of each row. A candidate key's occurrence counts the earlier rows that have
 * that key among theirs with the same occurrence key (the count a file stored under that key gave).
 */
function dedupHashesV2(
  txns: readonly ParsedTxn[],
  resolutions: readonly (ResolvedInstrument | null)[],
  ranks: readonly number[],
  resolver: InstrumentResolver,
  brokerId: string,
  identity: DedupIdentityV2,
): V2Hashes {
  const keys = new Map<InstrumentId, string>();
  const keyOf = (instrumentId: InstrumentId): string => {
    let key = keys.get(instrumentId);
    if (key === undefined) {
      key = instrumentKeyV2(committedInstrument(resolver, instrumentId), brokerId, () =>
        identity.instrumentGid(instrumentId),
      );
      keys.set(instrumentId, key);
    }
    return key;
  };
  const scope = { accountId: identity.accountGid, brokerId, version: HASH_VERSION_V2 };
  const order = txns.map((_, i) => i).sort((a, b) => (ranks[a] ?? 0) - (ranks[b] ?? 0));
  const inputs = order.map((i) => {
    const instrumentId = resolutions[i]?.instrumentId ?? null;
    return dedupInputFromParsed(
      txns[i] as ParsedTxn,
      instrumentId === null ? null : keyOf(instrumentId),
    );
  });
  const chronological = dedupHashes(inputs, scope);
  const hashes = new Array<string>(txns.length).fill("");
  const candidates = new Array<readonly string[]>(txns.length).fill([]);
  const seen = new Map<string, number>();
  order.forEach((i, position) => {
    hashes[i] = chronological[position] ?? "";
    const instrumentId = resolutions[i]?.instrumentId ?? null;
    if (instrumentId === null) return;
    const txn = txns[i] as ParsedTxn;
    candidates[i] = candidateKeysOf(txn, instrumentId, resolver, brokerId, identity).map((key) => {
      const input = dedupInputFromParsed(txn, key);
      const occurrenceText = occurrenceKey(input);
      const occurrence = seen.get(occurrenceText) ?? 0;
      seen.set(occurrenceText, occurrence + 1);
      return dedupHash(input, scope, occurrence);
    });
  });
  return { hashes: Object.freeze(hashes), candidates: Object.freeze(candidates) };
}

function candidateKeysOf(
  txn: ParsedTxn,
  instrumentId: InstrumentId,
  resolver: InstrumentResolver,
  brokerId: string,
  identity: DedupIdentityV2,
): readonly string[] {
  const current = resolver.instrument(instrumentId);
  const hint = hintIdentifiers(hintFromTxn(txn));
  return candidateInstrumentKeys({
    subject: { ...committedInstrument(resolver, instrumentId), symbol: current?.symbol ?? null },
    brokerId,
    gid: identity.instrumentGid(instrumentId),
    formerGids: resolver.isPlanned(instrumentId) ? [] : (identity.formerGids?.(instrumentId) ?? []),
    rowSymbol: hint.brokerSymbol,
    rowIsin: hint.isin,
    free: (namespace, value) => {
      const owner = resolver.ownerOf(namespace, value);
      return owner === null || owner === instrumentId;
    },
  });
}

/**
 * Which rows are duplicates: first every row whose own hash is stored, then (chronological order)
 * every other row with a stored candidate hash no row has absorbed yet.
 */
function claimDuplicates(
  v2: V2Hashes,
  ranks: readonly number[],
  existing: ReadonlySet<string>,
): readonly boolean[] {
  const claimed = new Set<string>();
  const duplicates = v2.hashes.map((hash) => {
    if (!existing.has(hash)) return false;
    claimed.add(hash);
    return true;
  });
  const order = v2.hashes.map((_, i) => i).sort((a, b) => (ranks[a] ?? 0) - (ranks[b] ?? 0));
  for (const i of order) {
    if (duplicates[i]) continue;
    const match = (v2.candidates[i] ?? []).find((hash) => existing.has(hash) && !claimed.has(hash));
    if (match === undefined) continue;
    claimed.add(match);
    duplicates[i] = true;
  }
  return Object.freeze(duplicates);
}

function planRename(
  action: ParsedRename,
  resolver: InstrumentResolver,
  warnings: ImportWarning[],
): PlannedRename | null {
  const old = resolver.find({
    symbol: action.oldSymbol,
    isin: action.oldIsin,
    exchangeHint: action.exchangeHint,
  });
  if (old === null) {
    warnings.push(
      importWarning({
        message: `Rename of unknown instrument ${action.oldSymbol} ignored`,
        row: action.rowIndex,
        kind: ImportWarningKind.UNKNOWN_INSTRUMENT,
      }),
    );
    return null;
  }
  const oldInstrument = resolver.instrument(old.instrumentId);
  if (oldInstrument === null) throw new InvariantError("a found instrument is always remembered");
  const next = resolver.resolve(
    instrumentHint({
      currency: oldInstrument.currency,
      symbol: action.newSymbol,
      isin: action.newIsin,
      name: action.newName || oldInstrument.name,
      exchangeHint: action.newExchangeHint || action.exchangeHint,
      evidence: CurrencyEvidence.WEAK,
    }),
  );
  if (next.instrumentId === old.instrumentId) {
    warnings.push(
      importWarning({
        message: `Rename ${action.oldSymbol} -> ${action.newSymbol} names the same instrument; ignored`,
        row: action.rowIndex,
        kind: ImportWarningKind.INSTRUMENT_NOTE,
      }),
    );
    return null;
  }
  return Object.freeze({
    parsed: action,
    rename: instrumentRename({
      date: action.date,
      oldInstrumentId: old.instrumentId,
      newInstrumentId: next.instrumentId,
      note: action.note,
    }),
  });
}

function plannedTransaction(
  txn: ParsedTxn,
  fields: {
    readonly txnId: TxnId;
    readonly accountId: AccountId;
    readonly instrumentId: InstrumentId | null;
    readonly batchId: ImportBatchId | null;
    readonly dedupHash: string;
    readonly createdAt: DateTime;
  },
): Transaction {
  return transaction({
    id: fields.txnId,
    accountId: fields.accountId,
    type: txn.type,
    tradeDate: txn.tradeDate,
    currency: txn.currency,
    grossAmount: txn.grossAmount.copyAbs(),
    cashAmount: txn.cashAmount,
    cashCurrency: txn.cashCurrency,
    instrumentId: fields.instrumentId,
    settleDate: txn.settleDate,
    quantity: txn.quantity === null ? null : txn.quantity.copyAbs(),
    price: txn.price,
    fee: txn.fee.copyAbs(),
    tax: txn.tax.copyAbs(),
    fxRate: txn.fxRate,
    splitRatio: txn.splitRatio,
    note: txn.note,
    source: TxnSource.IMPORT,
    importBatchId: fields.batchId,
    externalRef: txn.externalRef,
    dedupHash: fields.dedupHash,
    createdAt: fields.createdAt,
  });
}
