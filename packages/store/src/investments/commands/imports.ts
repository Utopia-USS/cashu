// The import commit and the reconciliation corrections (Python `service/imports.py` `commit`,
// `apply_reconciliation`). The commit re-runs the preview inside the command against the view it
// writes to (Python re-previews the staged file, then re-resolves planned instruments by their
// confirmed aliases), then emits everything as ONE batch: the import batch, new instruments and
// aliases, the non-duplicate rows (v2 hashes, gid.md 4.6) re-stamped from the commit time in their
// chronological order, broker position snapshots, renames, delisting status (frozen -> a manual
// valuation of 0), the chosen reconciliation corrections, the remembered importer and the planned
// deposits the file's deposits book. The file itself is archived before (services/imports.ts): the
// batch carries only its encrypted content-addressed blob reference (D9). Imports run on the fetch
// leader (lead decision D, S64): a device that does not hold the lease refuses.
import { addMicroseconds, D, type DateTime, type Decimal, parseDateTime } from "@cashu/domain";
import {
  asAccountId,
  asImportBatchId,
  asInstrumentId,
  asTxnId,
  defaultValuationMode,
  type Instrument,
  type InstrumentId,
  type InstrumentRename,
  InstrumentStatus,
  type Transaction,
  TxnType,
} from "@cashu/domain/investments";
import {
  type BrokerPosition,
  HASH_VERSION_V2,
  type ImportWarning,
  importFileExtension,
  reconcile,
  reconciliationHash,
  reconciliationInstrumentKey,
} from "@cashu/domain/investments/importing";
import { z } from "zod";
import { type CommandContext, defineCommand, ok, refuse } from "../../command.js";
import { accountByMemberGid } from "../../core/queries.js";
import { blobRef, gid } from "../../events/v1/primitives.js";
import {
  accountSnapshot,
  type ImportRequest,
  previewImport,
  storedPositions,
} from "../queries/import-preview.js";
import { loadInstrument } from "../queries/instruments.js";
import { instrumentRoot } from "../queries/shared.js";
import { brokerageAccount, existingHashes } from "../queries/transactions.js";
import { rememberImporter } from "./accounts.js";
import { addAliases, instrumentSpec, storeInstrument } from "./instruments.js";
import { bookMatchingPlans } from "./planned.js";

/** What a commit wrote (Python `CommitResult`; ids are gids). */
export interface CommitResult {
  readonly batch: string;
  readonly inserted: number;
  readonly duplicates: number;
  readonly newInstruments: readonly string[];
  readonly positions: number;
  readonly renames: number;
  readonly statusChanges: number;
  readonly corrections: number;
  /** The archived file's blob key `<sha256>.<ext>`. */
  readonly archive: string;
  /** Planned instrument id -> stored instrument gid. */
  readonly instrumentMap: Readonly<Record<string, string>>;
  /** Planned deposits this file's deposits booked. */
  readonly plannedBooked: readonly string[];
}

const fileInput = z.object({
  name: z.string().min(1),
  content: z.instanceof(Uint8Array),
});

export const commitImport = defineCommand({
  id: "investments.commitImport",
  input: z.object({
    account: gid,
    file: fileInput,
    importer: z.string().default("auto"),
    mappingYaml: z.string().nullable().default(null),
    connectorName: z.string().nullable().default(null),
    requested: z.string().nullable().default(null),
    boundAccount: z.boolean().default(false),
    /** Instrument ids (planned or stored gids) whose reconciliation correction to apply. */
    corrections: z.array(z.string()).default([]),
    /** The file archived as an encrypted content-addressed blob (D9), before this command runs. */
    archive: blobRef,
  }),
  run(ctx, input) {
    if (!ctx.lease.isHolder()) return refuse("not_leader");
    const root = accountByMemberGid(ctx.read, input.account)?.gid ?? input.account;
    const request: ImportRequest = {
      file: input.file,
      account: root,
      importer: input.importer,
      mappingYaml: input.mappingYaml,
      connectorName: input.connectorName,
      requested: input.requested,
      boundAccount: input.boundAccount,
    };
    // A planned instrument without any alias is keyed by its gid (the `gid:` step): mint it now, so
    // the rows hash under the gid the instrument is stored with.
    const ulids = new Map<string, string>();
    const plannedGid = (id: InstrumentId) => {
      let g = ulids.get(id);
      if (g === undefined) {
        g = ctx.newGid();
        ulids.set(id, g);
      }
      return g;
    };
    const now = ctx.now();
    const previewed = previewImport(ctx.read, request, now, { plannedGid });
    if (!previewed.ok) return refuse(previewed.reason);
    const preview = previewed.preview;
    const plan = preview.plan;
    if (plan === null || !preview.canCommit) return refuse("cannot_commit");
    if (input.archive.sha256 !== preview.sha256) return refuse("archive_mismatch");
    if (input.archive.ext !== archiveExtension(input.file.name)) return refuse("archive_mismatch");
    const account = root;
    const at = parseDateTime(now);
    const batch = ctx.newGid();

    // 1. Instruments: planned ones (a concurrent import may have stored them meanwhile:
    //    `storeInstrument` returns the holder of the creation alias), then the aliases learned for
    //    stored ones. Instrument events reference no batch, so they go first.
    const mapping = new Map<string, string>();
    const newIds: string[] = [];
    for (const planned of plan.newInstruments) {
      const stored = storeInstrument(ctx, specOf(planned), ulids.get(planned.id));
      mapping.set(planned.id, stored.gid);
      if (stored.created) newIds.push(stored.gid);
      else addAliases(ctx, stored.gid, planned.isin, aliasesOf(planned));
    }
    for (const [id, aliases] of plan.newAliases) {
      const current = loadInstrument(ctx.read, resolve(id, mapping), { shared: true });
      if (current !== undefined) addAliases(ctx, current.id, current.isin, aliasesOf({ aliases }));
    }

    // 2. Transactions: the plan's v2 hashes (computed over the instruments as this commit leaves
    //    them); the non-duplicate rows in chronological order, re-stamped `now + index ms`.
    const rows = [...plan.rows].sort((a, b) => cmpTime(a.txn.createdAt, b.txn.createdAt));
    const inserted: Transaction[] = [];
    let duplicates = 0;
    const seen = new Set<string>();
    rows.forEach((row, index) => {
      const hash = row.txn.dedupHash;
      if (row.isDuplicate || seen.has(hash)) {
        duplicates += 1;
        return;
      }
      seen.add(hash);
      const instrument = row.txn.instrumentId;
      inserted.push({
        ...row.txn,
        id: asTxnId(ctx.det("inv_transactions", [account, hash])),
        instrumentId: instrument === null ? null : asInstrumentId(resolve(instrument, mapping)),
        importBatchId: asImportBatchId(batch),
        createdAt: addMicroseconds(at, index * 1000),
      });
    });

    // 3. Broker position snapshots (DET per account, instrument and date): an overlapping re-import
    //    of the same figures writes nothing (S31a F2); changed figures are written again.
    //    PARITY(S22b): the fold keeps the first applied snapshot of a row key (CREATE, events.md 8.5)
    //    while Python updates the row; the writer already emits the change (follow-up: LWW-F).
    // Two lines of one file for the same instrument and date: the last one wins (Python's upsert).
    const lastLines = new Map<string, BrokerPosition & { readonly instrument: string }>();
    for (const p of plan.positions) {
      const instrument = resolve(p.position.instrumentId, mapping);
      const key = `${instrument}|${p.position.asOf}`;
      lastLines.delete(key);
      lastLines.set(key, { ...p.position, instrument });
    }
    const positions = [...lastLines.values()].filter((p) => !sameSnapshot(ctx, account, p));

    // 4. Renames, once per (date, old, new).
    const renames: { g: string; rename: InstrumentRename }[] = [];
    for (const planned of plan.renames) {
      const r = planned.rename;
      const rename = {
        ...r,
        oldInstrumentId: asInstrumentId(resolve(r.oldInstrumentId, mapping)),
        newInstrumentId: asInstrumentId(resolve(r.newInstrumentId, mapping)),
      };
      const g = ctx.det("inv_instrument_renames", [
        r.date,
        rename.oldInstrumentId,
        rename.newInstrumentId,
      ]);
      if (renameExists(ctx, g) || renames.some((e) => e.g === g)) continue;
      renames.push({ g, rename });
    }

    // 5. Reconciliation corrections chosen in the preview, against the history after this file.
    let corrections: Transaction[] = [];
    if (input.corrections.length > 0 && plan.positions.length > 0) {
      const wanted = new Set(
        input.corrections.map((c) => mapping.get(c) ?? instrumentRoot(ctx.read, c)),
      );
      const brokerPositions = plan.positions.map((p) => ({
        ...p.position,
        instrumentId: asInstrumentId(resolve(p.position.instrumentId, mapping)),
      }));
      corrections = proposedCorrections(ctx, account, brokerPositions, wanted, at, batch, {
        txns: inserted,
        renames: renames.map((e) => e.rename),
      });
    }

    ctx.emit("invImport.recorded", batch, {
      account,
      importer: preview.importerId || plan.brokerId,
      broker: plan.brokerId,
      fileName: input.file.name,
      fileSha256: preview.sha256,
      archive: { sha256: input.archive.sha256, ext: input.archive.ext },
      txnCount: inserted.length,
      duplicateCount: duplicates,
      positionCount: plan.positions.length,
      renameCount: renames.length,
      statusChangeCount: plan.statusChanges.length,
      instrumentCount: newIds.length,
      correctionCount: corrections.length,
      warnings: preview.warnings.map(warningJson),
    });
    for (const t of inserted) emitTxn(ctx, account, t);
    for (const p of positions) {
      ctx.emit(
        "position.snapshotImported",
        ctx.det("inv_position_snapshots", [account, p.instrument, p.asOf]),
        {
          account,
          instrument: p.instrument,
          asOf: p.asOf,
          quantity: p.quantity.format("f"),
          currency: p.currency,
          avgPrice: p.avgPrice === null ? null : p.avgPrice.format("f"),
          marketValue: p.marketValue === null ? null : p.marketValue.format("f"),
          batch,
        },
      );
    }
    for (const { g, rename } of renames) {
      ctx.emit("instrumentRename.recorded", g, {
        date: rename.date,
        old: rename.oldInstrumentId,
        new: rename.newInstrumentId,
        note: rename.note,
        batch,
      });
    }
    // Delistings: the status for this vault; a frozen one is valued at 0 from its date.
    for (const change of plan.statusChanges) {
      const instrument = resolve(change.instrumentId, mapping);
      setStatus(ctx, instrument, change.status);
      if (change.status !== InstrumentStatus.FROZEN) continue;
      const currency =
        loadInstrument(ctx.read, instrument, { shared: true })?.currency ??
        plan.instruments.get(change.instrumentId)?.currency;
      if (currency === undefined) continue;
      ctx.emit(
        "valuation.set",
        ctx.det("inv_manual_valuations", [instrument, change.parsed.date]),
        {
          instrument,
          asOf: change.parsed.date,
          unitValue: "0",
          currency,
          note: change.parsed.note || "frozen (import)",
        },
      );
    }
    for (const t of corrections) emitTxn(ctx, account, t);

    // 6. Remember the importer for this account: only a file with transactions (the broker's
    //    statement export); a positions-only / corporate-action-only file must not replace it (F7 OB4).
    if (plan.rows.length > 0 && preview.importerId !== null) {
      rememberImporter(ctx, account, preview.importerId, input.mappingYaml ?? undefined);
    }

    // 7. Planned deposits this file's deposits book (F6; never cash until then).
    const booked =
      inserted.length > 0
        ? bookMatchingPlans(
            ctx,
            inserted
              .filter((t) => t.type === TxnType.DEPOSIT)
              .map((t) => ({
                gid: t.id,
                account,
                tradeDate: t.tradeDate,
                cashAmount: t.cashAmount.format("f"),
                cashCurrency: t.cashCurrency,
              })),
          )
        : [];

    return ok<CommitResult>({
      batch,
      inserted: inserted.length,
      duplicates,
      newInstruments: newIds,
      positions: plan.positions.length,
      renames: renames.length,
      statusChanges: plan.statusChanges.length,
      corrections: corrections.length,
      archive: `${input.archive.sha256}.${input.archive.ext}`,
      instrumentMap: Object.fromEntries(mapping),
      plannedBooked: booked,
    });
  },
});

export const applyReconciliation = defineCommand({
  id: "investments.applyReconciliation",
  input: z.object({ account: gid, instruments: z.array(gid) }),
  /**
   * Python `apply_reconciliation`: insert the proposed corrections of the chosen instruments (vs the
   * newest stored broker snapshot); applying the same proposal twice inserts it once.
   */
  run(ctx, input) {
    const root = accountByMemberGid(ctx.read, input.account)?.gid ?? input.account;
    if (brokerageAccount(ctx.read, root) === undefined) return refuse("no_account");
    const positions = storedPositions(ctx.read, root);
    if (positions.length === 0) return ok({ applied: 0 });
    const wanted = new Set(input.instruments.map((g) => instrumentRoot(ctx.read, g)));
    const found = proposedCorrections(
      ctx,
      root,
      positions,
      wanted,
      parseDateTime(ctx.now()),
      null,
      {},
    );
    for (const t of found) emitTxn(ctx, root, t);
    return ok({ applied: found.length });
  },
});

/** The archive's extension (Python `files.extension`): the file's, else `bin`. */
export function archiveExtension(fileName: string): string {
  const ext = importFileExtension({ name: fileName, content: new Uint8Array() });
  return /^[a-z0-9]{1,10}$/.test(ext) ? ext : "bin";
}

/**
 * `_apply_corrections`: the corrections of the `wanted` instruments that are not stored yet, as rows to
 * emit (v2 hash with the `gid:` key, gid.md 4.6; `createdAt = now + index ms`).
 */
function proposedCorrections(
  ctx: CommandContext,
  account: string,
  positions: readonly BrokerPosition[],
  wanted: ReadonlySet<string>,
  now: DateTime,
  batch: string | null,
  extra: Parameters<typeof accountSnapshot>[3],
): Transaction[] {
  const asOf = positions
    .map((p) => p.asOf)
    .sort()
    .at(-1) as string;
  const snapshot = accountSnapshot(ctx.read, account, asOf, extra);
  let n = 0;
  const report = reconcile(asAccountId(account), positions, snapshot, {
    now,
    txnIdFactory: () => asTxnId(`reconciliation-${++n}`),
  });
  const out: Transaction[] = [];
  const hashes = new Set<string>();
  report.corrections.forEach((correction, index) => {
    const txn = correction.txn;
    if (txn.instrumentId === null || txn.quantity === null) return;
    const instrument = instrumentRoot(ctx.read, txn.instrumentId);
    if (!wanted.has(instrument)) return;
    const hash = reconciliationHash(
      account,
      reconciliationInstrumentKey(instrument),
      txn.tradeDate,
      txn.type,
      txn.quantity,
      HASH_VERSION_V2,
    );
    if (hashes.has(hash) || existingHashes(ctx.read, account, [hash]).size > 0) return;
    hashes.add(hash);
    out.push({
      ...txn,
      id: asTxnId(ctx.det("inv_transactions", [account, hash])),
      instrumentId: asInstrumentId(instrument),
      importBatchId: batch === null ? null : asImportBatchId(batch),
      dedupHash: hash,
      createdAt: addMicroseconds(now, index * 1000),
    });
  });
  return out;
}

function emitTxn(ctx: CommandContext, account: string, t: Transaction): void {
  const dec = (v: { format(spec: string): string } | null) => (v === null ? null : v.format("f"));
  ctx.emit("invTxn.imported", t.id, {
    account,
    batch: t.importBatchId,
    type: t.type,
    tradeDate: t.tradeDate,
    settleDate: t.settleDate,
    instrument: t.instrumentId,
    quantity: dec(t.quantity),
    price: dec(t.price),
    currency: t.currency,
    grossAmount: t.grossAmount.format("f"),
    fee: t.fee.format("f"),
    tax: t.tax.format("f"),
    cashAmount: t.cashAmount.format("f"),
    cashCurrency: t.cashCurrency,
    fxRate: dec(t.fxRate),
    splitRatio: dec(t.splitRatio),
    note: t.note,
    source: t.source,
    externalRef: t.externalRef,
    dedupHash: t.dedupHash,
    createdAt: eventTime(t.createdAt),
  });
}

/** A domain timestamp as an event timestamp (UTC, microseconds kept). */
function eventTime(value: DateTime): string {
  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  return `${value.date}T${pad(value.hour, 2)}:${pad(value.minute, 2)}:${pad(value.second, 2)}.${pad(value.microsecond, 6)}Z`;
}

function cmpTime(a: DateTime, b: DateTime): number {
  const ka = eventTime(a);
  const kb = eventTime(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/** `_resolve`: a planned instrument's stored gid, else the (stored) gid itself. */
function resolve(id: InstrumentId | string, mapping: ReadonlyMap<string, string>): string {
  return mapping.get(id) ?? String(id);
}

function aliasesOf(planned: Pick<Instrument, "aliases">) {
  return planned.aliases.map((a) => ({
    namespace: a.namespace,
    value: a.value,
    guessed: a.guessed,
  }));
}

/** A planned domain instrument as `storeInstrument` input. */
function specOf(planned: Instrument) {
  return instrumentSpec.parse({
    name: planned.name,
    currency: planned.currency,
    assetClass: planned.assetClass,
    symbol: planned.symbol,
    isin: planned.isin,
    mic: planned.mic,
    region: planned.region,
    sector: planned.sector,
    tags: [...planned.tags],
    needsClassification: planned.needsClassification,
    valuationMode: planned.valuationMode ?? defaultValuationMode(planned.assetClass),
    status: planned.status,
    aliases: aliasesOf(planned),
  });
}

/** Python `set_status` for this vault (the override row); unchanged = nothing. */
function setStatus(ctx: CommandContext, instrument: string, status: string): void {
  const current = loadInstrument(ctx.read, instrument);
  if (current !== undefined && current.status === status) return;
  ctx.emit("instrumentOverride.set", ctx.det("inv_profile_instruments", [instrument]), {
    instrument,
    status,
  });
}

/** Whether the view already holds this snapshot row with the same figures (Python's no-op branch). */
function sameSnapshot(
  ctx: CommandContext,
  account: string,
  p: BrokerPosition & { readonly instrument: string },
): boolean {
  const row = ctx.read<{
    quantity: string;
    currency: string;
    avg_price: string | null;
    market_value: string | null;
  }>(
    `SELECT p.quantity, p.currency, p.avg_price, p.market_value
     FROM inv_position_snapshots p JOIN accounts a ON a.id = p.account_id
     JOIN inv_instruments i ON i.id = p.instrument_id
     WHERE a.gid = ? AND i.gid = ? AND p.as_of = ?`,
    account,
    instrumentRoot(ctx.read, p.instrument),
    p.asOf,
  )[0];
  if (row === undefined) return false;
  const same = (stored: string | null, value: Decimal | null) =>
    stored === null || value === null ? stored === value : D(stored).eq(value);
  return (
    same(row.quantity, p.quantity) &&
    row.currency === p.currency &&
    same(row.avg_price, p.avgPrice) &&
    same(row.market_value, p.marketValue)
  );
}

function renameExists(ctx: CommandContext, g: string): boolean {
  return ctx.read("SELECT 1 FROM inv_instrument_renames WHERE gid = ?", g).length > 0;
}

/** `_warning_dict`. */
function warningJson(w: ImportWarning): Record<string, unknown> {
  return { message: w.message, row: w.row, kind: String(w.kind), blocking: w.blocking };
}
