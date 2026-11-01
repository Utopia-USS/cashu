// The import preview (Python `service/imports.py` `preview` and the read side of the reconciliation):
// importer choice, parsing, `planImport` over this vault's instruments and dedup hashes (v2, gid.md
// 4.6), the service notes (same file imported before, the file's source vs the account's broker,
// several importers) and the reconciliation of the file's position lines against the history after the
// import. Read-only over the vault's `Read`, so the commit command re-runs it inside its own batch
// against the view it writes to (Python re-previews the staged file at commit, then re-resolves).
import { D, type DateTime, parseDateTime, sha256Hex, toCurrency, toStorage } from "@cashu/domain";
import { builtinRegistry } from "@cashu/domain/core";
import {
  asAccountId,
  asInstrumentId,
  asProfileId,
  asTxnId,
  buildSnapshot,
  type Instrument,
  type InstrumentId,
  type InstrumentRename,
  type Transaction,
} from "@cashu/domain/investments";
import {
  type BrokerImporter,
  type BrokerPosition,
  brokerPosition,
  CanonicalImporter,
  type CsvMapping,
  canonicalImporterId,
  csvMappingFromYaml,
  dedupHash,
  dedupInputFromTransaction,
  defaultRegistry,
  effectiveBrokerId,
  GENERIC_CSV_BROKER_ID,
  GenericCsvImporter,
  HASH_VERSION_V2,
  type ImportFile,
  type ImportParseResult,
  type ImportPlan,
  type ImportWarning,
  ImportWarningKind,
  type InstrumentLookup,
  importWarning,
  instrumentKeyV2,
  MAX_FILE_BYTES,
  occurrenceKey,
  planImport,
  type ReconciliationReport,
  reconcile,
  transactionsToInsert,
} from "@cashu/domain/investments/importing";
import { INSTRUMENTS } from "../instruments.js";
import {
  instrumentByAlias,
  instrumentByIsin,
  instrumentsBySymbol,
  loadInstrument,
} from "./instruments.js";
import { instrumentRoot, type Read } from "./shared.js";
import {
  accountSettings,
  type BrokerageAccount,
  brokerageAccount,
  existingHashes,
  latestPositionSnapshot,
  renames,
  transactions,
} from "./transactions.js";

export const AUTO = "auto";
/** What a request may name besides `connector:<id>` (Python `IMPORTER_CHOICES`). */
export const IMPORTER_CHOICES = [AUTO, "cashu", GENERIC_CSV_BROKER_ID] as const;
/**
 * `connector:<id>`: an approved file connector (F10). Nothing here runs it: the connectors host runs the
 * connector's `convert` first and passes the converted `cashu-import` document as the file, read like
 * the canonical format (also what is staged and archived).
 */
export const CONNECTOR_PREFIX = "connector:";

export interface ImportRequest {
  readonly file: ImportFile;
  /** The brokerage account's gid. */
  readonly account: string;
  /** `auto` (default) | `cashu` | `generic_csv` | `connector:<id>`. */
  readonly importer?: string;
  readonly mappingYaml?: string | null;
  /** Display name of a `connector:<id>` importer. */
  readonly connectorName?: string | null;
  /** What the user chose when it differs (auto -> a detected connector). */
  readonly requested?: string | null;
  /**
   * A fetch connector's binding names the account (the owner's choice): no "source vs the account's
   * broker" note (a connector's `source` is its author's label).
   */
  readonly boundAccount?: boolean;
}

/** One earlier batch of the same file (`previous_batches`). */
export interface PreviousBatch {
  readonly gid: string;
  readonly createdAt: string;
}

export interface ImportPreview {
  readonly account: BrokerageAccount;
  readonly request: ImportRequest;
  readonly sha256: string;
  readonly importerId: string | null;
  readonly importerName: string | null;
  readonly detected: readonly string[];
  readonly parse: ImportParseResult | null;
  readonly plan: ImportPlan | null;
  /** Service-level notes (same file, broker mismatch, several importers). */
  readonly notes: readonly ImportWarning[];
  /** Service-level blocking problems (no importer, unreadable mapping, importer crash). */
  readonly blocking: readonly ImportWarning[];
  readonly previousBatches: readonly PreviousBatch[];
  readonly reconciliation: ReconciliationReport | null;
  /** Notes, then the plan's warnings. */
  readonly warnings: readonly ImportWarning[];
  /** Blocking problems, then the plan's blocking errors. */
  readonly errors: readonly ImportWarning[];
  readonly canCommit: boolean;
}

export type PreviewResult =
  | { readonly ok: true; readonly preview: ImportPreview }
  | { readonly ok: false; readonly reason: "no_account" | "file_too_large" };

/** `is_connector_choice`. */
export function isConnectorChoice(choice: string | null | undefined): choice is string {
  return !!choice && choice.startsWith(CONNECTOR_PREFIX) && choice.length > CONNECTOR_PREFIX.length;
}

/**
 * `ConnectorDocumentImporter`: a connector's converted document (`cashu-import` JSON) read with the
 * canonical importer; the batch and the account remember `connector:<id>` as the importer.
 */
class ConnectorDocumentImporter implements BrokerImporter {
  private readonly canonical = new CanonicalImporter();
  readonly brokerId = this.canonical.brokerId;
  readonly version = this.canonical.version;

  readonly importerId: string;
  readonly displayName: string;

  constructor(importerId: string, displayName: string) {
    this.importerId = importerId;
    this.displayName = displayName;
  }

  private static asJson(file: ImportFile): ImportFile {
    return { name: `${file.name}.json`, content: file.content };
  }

  canParse(file: ImportFile): boolean {
    return this.canonical.canParse(ConnectorDocumentImporter.asJson(file));
  }

  parse(file: ImportFile): ImportParseResult {
    return this.canonical.parse(ConnectorDocumentImporter.asJson(file));
  }
}

const note = (message: string, kind: string = ImportWarningKind.OTHER, blocking = false) =>
  importWarning({ message, kind, blocking });

interface Choice {
  importer: BrokerImporter | null;
  detected: string[];
  notes: ImportWarning[];
  blocking: ImportWarning[];
}

/** `_choose_importer`. */
function chooseImporter(request: ImportRequest, storedMapping: string | null): Choice {
  const out: Choice = { importer: null, detected: [], notes: [], blocking: [] };
  let mappingText = request.mappingYaml ?? null;
  const choice = canonicalImporterId(request.importer ?? null) || AUTO;
  if (isConnectorChoice(choice)) {
    if (request.requested === AUTO) out.detected = [choice];
    out.importer = new ConnectorDocumentImporter(
      choice,
      request.connectorName || choice.slice(CONNECTOR_PREFIX.length),
    );
    return out;
  }
  if (!(IMPORTER_CHOICES as readonly string[]).includes(choice)) {
    out.blocking.push(
      note(
        `Unknown importer ${pyQuote(choice)}; use one of ${IMPORTER_CHOICES.join(", ")}`,
        ImportWarningKind.FILE_FORMAT,
        true,
      ),
    );
    return out;
  }
  if (choice === AUTO && mappingText === null && storedMapping) mappingText = storedMapping;
  let mapping: CsvMapping | null = null;
  if (mappingText !== null) {
    const parsed = csvMappingFromYaml(mappingText);
    if (!parsed.ok) {
      for (const issue of parsed.issues) {
        const where = issue.line ? ` (line ${issue.line})` : "";
        out.blocking.push(
          note(
            `mapping ${issue.path}: ${issue.message}${where}`,
            ImportWarningKind.FILE_FORMAT,
            true,
          ),
        );
      }
      return out;
    }
    mapping = parsed.mapping;
  }
  if (choice === "cashu") {
    out.importer = new CanonicalImporter();
    return out;
  }
  if (choice === GENERIC_CSV_BROKER_ID) {
    if (mapping === null) {
      out.blocking.push(
        note(
          "The generic CSV importer needs a mapping (YAML)",
          ImportWarningKind.FILE_FORMAT,
          true,
        ),
      );
      return out;
    }
    out.importer = new GenericCsvImporter(mapping);
    return out;
  }
  const found = defaultRegistry(...(mapping === null ? [] : [mapping])).detect(request.file);
  out.detected = found.map((i) => i.brokerId);
  if (found.length === 0) {
    out.blocking.push(
      note(
        "No importer recognises this file: use the cashU import format (docs/import-format.md) or a generic CSV mapping",
        ImportWarningKind.FILE_FORMAT,
        true,
      ),
    );
    return out;
  }
  if (found.length > 1) {
    out.notes.push(
      note(
        `Several importers recognise this file (${out.detected.join(", ")}); using ${found[0]?.brokerId}`,
        ImportWarningKind.FILE_FORMAT,
      ),
    );
  }
  out.importer = found[0] ?? null;
  return out;
}

/** Python `repr(str)` for the simple texts an importer choice holds. */
function pyQuote(text: string): string {
  return text.includes("'") && !text.includes('"')
    ? `"${text}"`
    : `'${text.replaceAll("'", "\\'")}'`;
}

/** The `InstrumentLookup` of a plan over this vault's view (Python `DbInstrumentLookup`). */
export class ViewInstrumentLookup implements InstrumentLookup {
  private readonly read: Read;

  constructor(read: Read) {
    this.read = read;
  }

  byIsin(isin: string): Instrument | null {
    return instrumentByIsin(this.read, isin) ?? null;
  }

  byAlias(namespace: string, value: string): Instrument | null {
    return instrumentByAlias(this.read, namespace, value) ?? null;
  }

  bySymbol(symbol: string, mic: string): readonly Instrument[] {
    return instrumentsBySymbol(this.read, symbol, mic);
  }
}

/**
 * The gids merged into instrument `root` (owner merges and alias claims folded into it, the store's
 * identity record): rows stored under `gid:<former>` are this instrument's (S17d follow-up).
 */
export function formerInstrumentGids(read: Read, gid: string): string[] {
  const root = instrumentRoot(read, gid);
  return read<{ gid: string }>(
    "SELECT gid FROM identity_roots WHERE kind = ? AND root = ? AND gid <> ? ORDER BY gid",
    INSTRUMENTS,
    root,
    root,
  ).map((r) => r.gid);
}

/**
 * The hashes the account's manual entries would have as import rows of `brokerId` (Python stores a
 * manual row under the content hash an import of it would get, with the smallest free occurrence, so a
 * later import of the same trade is a duplicate; the TS store keys manual rows `manual:<gid>`, m1, so
 * the preview adds these virtual hashes to the stored ones). Occurrences: per content key, the smallest
 * index neither a stored row nor an earlier manual row holds, manual rows in the order they were stored.
 */
export function manualEntryHashes(read: Read, account: string, brokerId: string): Set<string> {
  const manual = transactions(read, [account]).filter((t) => t.source === "manual");
  const out = new Set<string>();
  if (manual.length === 0) return out;
  manual.sort((a, b) => storedOrder(a).localeCompare(storedOrder(b)));
  const keys = new Map<string, string>();
  const keyOf = (instrument: string): string => {
    let key = keys.get(instrument);
    if (key === undefined) {
      const stored = loadInstrument(read, instrument, { shared: true });
      key =
        stored === undefined
          ? `gid:${instrument}`
          : instrumentKeyV2(stored, brokerId, () => stored.id);
      keys.set(instrument, key);
    }
    return key;
  };
  const scope = { accountId: account, brokerId, version: HASH_VERSION_V2 };
  const next = new Map<string, number>();
  for (const txn of manual) {
    const input = dedupInputFromTransaction({
      ...txn,
      instrumentId: txn.instrumentId === null ? null : asInstrumentId(keyOf(txn.instrumentId)),
    });
    const group = occurrenceKey(input);
    for (let k = next.get(group) ?? 0; ; k += 32) {
      const batch = Array.from({ length: 32 }, (_, i) => dedupHash(input, scope, k + i));
      const taken = existingHashes(read, account, batch);
      const free = batch.findIndex((h) => !taken.has(h) && !out.has(h));
      if (free < 0) continue;
      out.add(batch[free] as string);
      next.set(group, k + free + 1);
      break;
    }
  }
  return out;
}

/** Manual rows in the order they were stored (`created_at` is the entry time). */
const storedOrder = (t: Transaction) => toStorage(t.createdAt);

export interface PreviewOptions {
  /**
   * The gid a planned instrument (an id `planImport` made up) will be stored under, read by the `gid:`
   * key step of an instrument without any alias (default: the planned id; the commit passes the ULID
   * it will store the instrument with).
   */
  readonly plannedGid?: (planned: InstrumentId) => string;
}

/** `preview`: what committing `request` would do (read-only). `now` is the event clock's timestamp. */
export function previewImport(
  read: Read,
  request: ImportRequest,
  now: string,
  options: PreviewOptions = {},
): PreviewResult {
  const account = brokerageAccount(read, request.account);
  if (account === undefined) return { ok: false, reason: "no_account" };
  if (request.file.content.length > MAX_FILE_BYTES) return { ok: false, reason: "file_too_large" };
  const sha256 = sha256Hex(request.file.content);
  const settings = accountSettings(read, account.gid);
  const choice = chooseImporter(request, settings.mappingYaml);
  const base = {
    account,
    request,
    sha256,
    detected: choice.detected,
    notes: choice.notes,
    blocking: choice.blocking,
    previousBatches: [] as PreviousBatch[],
    reconciliation: null as ReconciliationReport | null,
  };
  const importer = choice.importer;
  if (importer === null) {
    return done({ ...base, importerId: null, importerName: null, parse: null, plan: null });
  }
  const importerId =
    importer instanceof ConnectorDocumentImporter ? importer.importerId : importer.brokerId;
  let parsed: ImportParseResult;
  try {
    parsed = importer.parse(request.file);
  } catch (e) {
    // A broken importer must not crash the preview (Python: `type(e).__name__: e`).
    const name = e instanceof Error ? e.name : "Error";
    const text = e instanceof Error ? e.message : String(e);
    return done({
      ...base,
      importerId,
      importerName: importer.displayName,
      parse: null,
      plan: null,
      blocking: [
        ...base.blocking,
        note(`The importer failed: ${name}: ${text}`, ImportWarningKind.IMPORTER_ERROR, true),
      ],
    });
  }
  const brokerId = effectiveBrokerId(importer, parsed);
  const at = parseDateTime(now);
  const virtual = manualEntryHashes(read, account.gid, brokerId);
  // Planned instrument ids are deterministic per file, so the plan repeated at commit names the same
  // planned instruments as the preview.
  const prefix = `new-${sha256.slice(0, 12)}-`;
  const isPlannedId = (id: InstrumentId) => String(id).startsWith(prefix);
  let planned = 0;
  let txns = 0;
  const plan = planImport(parsed, {
    accountId: asAccountId(account.gid),
    brokerId,
    lookup: new ViewInstrumentLookup(read),
    existingHashes: (hashes) => {
      const found = existingHashes(read, account.gid, hashes);
      for (const h of hashes) if (virtual.has(h)) found.add(h);
      return found;
    },
    now: at,
    txnIdFactory: () => asTxnId(`txn-${++txns}`),
    instrumentIdFactory: () => asInstrumentId(`${prefix}${++planned}`),
    dedupV2: {
      accountGid: account.gid,
      instrumentGid: (id) => (isPlannedId(id) ? (options.plannedGid?.(id) ?? id) : id),
      formerGids: (id) => formerInstrumentGids(read, id),
    },
  });

  const previousBatches = batchesOfFile(read, sha256);
  const notes = [...base.notes];
  const first = previousBatches[0];
  if (first !== undefined) {
    notes.push(
      note(
        `This file was already imported on ${first.createdAt.slice(0, 10)} (batch ${first.gid}); its rows show as duplicates`,
      ),
    );
  }
  const institution = builtinRegistry().institutions.find(account.bank);
  if (
    !request.boundAccount &&
    institution !== undefined &&
    (institution.kind === "broker" || institution.kind === "exchange") &&
    parsed.source &&
    parsed.source !== account.bank
  ) {
    notes.push(
      note(
        `The file says source '${parsed.source}' but the account belongs to ${institution.name} ('${account.bank}'); check the account`,
      ),
    );
  }
  const reconciliation =
    plan.positions.length > 0 ? reconcilePlanned(read, account.gid, plan, at) : null;
  return done({
    ...base,
    importerId,
    importerName: importer.displayName,
    parse: parsed,
    plan,
    notes,
    previousBatches,
    reconciliation,
  });
}

function done(p: Omit<ImportPreview, "warnings" | "errors" | "canCommit">): {
  ok: true;
  preview: ImportPreview;
} {
  const warnings = [...p.notes, ...(p.plan?.warnings ?? [])];
  const errors = [...p.blocking, ...(p.plan?.blockingErrors ?? [])];
  return {
    ok: true,
    preview: { ...p, warnings, errors, canCommit: p.plan !== null && errors.length === 0 },
  };
}

/** Earlier batches of the same file in this vault, oldest first (`previous_batches`). */
export function batchesOfFile(read: Read, sha256: string): PreviousBatch[] {
  return read<{ gid: string; created_at: string }>(
    "SELECT gid, created_at FROM inv_import_batches WHERE file_sha256 = ? ORDER BY created_at, id",
    sha256,
  ).map((r) => ({ gid: r.gid, createdAt: r.created_at }));
}

/** The vault's broker position snapshot of `account` as of `asOf` (the account's history). */
export function accountSnapshot(
  read: Read,
  account: string,
  asOf: string,
  extra: {
    readonly txns?: readonly Transaction[];
    readonly renames?: readonly InstrumentRename[];
  } = {},
) {
  return buildSnapshot(
    asProfileId("vault"),
    [...transactions(read, [account]), ...(extra.txns ?? [])],
    asOf,
    {
      accountIds: new Set([asAccountId(account)]),
      renames: [...renames(read), ...(extra.renames ?? [])],
    },
  );
}

/** `_reconcile_planned`: the file's position lines vs the account's history including the planned rows. */
function reconcilePlanned(
  read: Read,
  account: string,
  plan: ImportPlan,
  now: DateTime,
): ReconciliationReport {
  const positions = plan.positions.map((p) => p.position);
  const asOf = positions
    .map((p) => p.asOf)
    .sort()
    .at(-1) as string;
  const snapshot = accountSnapshot(read, account, asOf, {
    txns: transactionsToInsert(plan),
    renames: plan.renames.map((r) => r.rename),
  });
  let n = 0;
  return reconcile(asAccountId(account), positions, snapshot, {
    now,
    txnIdFactory: () => asTxnId(`reconciliation-${++n}`),
  });
}

/** `stored_positions`: the account's newest stored broker snapshot as reconciler input. */
export function storedPositions(read: Read, account: string): BrokerPosition[] {
  return latestPositionSnapshot(read, account).rows.map((r) =>
    brokerPosition({
      instrumentId: asInstrumentId(r.instrument),
      quantity: D(r.quantity),
      currency: toCurrency(r.currency),
      asOf: r.asOf,
      avgPrice: r.avgPrice === null ? null : D(r.avgPrice),
      marketValue: r.marketValue === null ? null : D(r.marketValue),
    }),
  );
}

/**
 * `reconciliation`: the account's history vs its newest stored broker snapshot (null without a
 * snapshot); undefined for an account that is not one of the vault's brokerage accounts.
 */
export function storedReconciliation(
  read: Read,
  account: string,
  now: string,
): ReconciliationReport | null | undefined {
  if (brokerageAccount(read, account) === undefined) return undefined;
  const positions = storedPositions(read, account);
  if (positions.length === 0) return null;
  const asOf = positions
    .map((p) => p.asOf)
    .sort()
    .at(-1) as string;
  let n = 0;
  return reconcile(asAccountId(account), positions, accountSnapshot(read, account, asOf), {
    now: parseDateTime(now),
    txnIdFactory: () => asTxnId(`reconciliation-${++n}`),
  });
}

/** The vault's import batches, newest first (Python `GET /imports`). */
export interface ImportBatchView {
  readonly gid: string;
  readonly account: string;
  readonly importer: string;
  readonly broker: string;
  readonly fileName: string;
  readonly fileSha256: string;
  /** The archived file's blob key `<sha256>.<ext>` (D9), null when the batch archived nothing. */
  readonly archive: string | null;
  readonly txnCount: number;
  readonly duplicateCount: number;
  readonly positionCount: number;
  readonly renameCount: number;
  readonly statusChangeCount: number;
  readonly instrumentCount: number;
  readonly correctionCount: number;
  readonly warnings: readonly unknown[];
  readonly createdAt: string;
}

export function importBatches(read: Read): ImportBatchView[] {
  return read<{
    gid: string;
    account: string;
    importer: string;
    broker: string;
    file_name: string;
    file_sha256: string;
    archive_path: string | null;
    txn_count: number;
    duplicate_count: number;
    position_count: number;
    rename_count: number;
    status_change_count: number;
    instrument_count: number;
    correction_count: number;
    warnings: string;
    created_at: string;
  }>(
    `SELECT b.gid, a.gid AS account, b.importer, b.broker, b.file_name, b.file_sha256, b.archive_path,
       b.txn_count, b.duplicate_count, b.position_count, b.rename_count, b.status_change_count,
       b.instrument_count, b.correction_count, b.warnings, b.created_at
     FROM inv_import_batches b JOIN accounts a ON a.id = b.account_id
     ORDER BY b.created_at DESC, b.id DESC`,
  ).map((r) => ({
    gid: r.gid,
    account: r.account,
    importer: r.importer,
    broker: r.broker,
    fileName: r.file_name,
    fileSha256: r.file_sha256,
    archive: r.archive_path,
    txnCount: r.txn_count,
    duplicateCount: r.duplicate_count,
    positionCount: r.position_count,
    renameCount: r.rename_count,
    statusChangeCount: r.status_change_count,
    instrumentCount: r.instrument_count,
    correctionCount: r.correction_count,
    warnings: JSON.parse(r.warnings) as unknown[],
    createdAt: r.created_at,
  }));
}
