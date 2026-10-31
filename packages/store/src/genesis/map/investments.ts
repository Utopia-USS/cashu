// Genesis row mappers, investments (S26 spec 4.4-4.6; events.md 8.5, 8.6; gid.md 4.6, 7, 7.2, 7.3):
// the vault's instruments (reference closure) with their aliases, account settings, imports with the
// archive blob, transactions (dedupHashV2 from phase 1), position snapshots, renames, manual
// valuations and the per-profile instrument overrides.
import { archiveRef } from "../files.js";
import type { InvProfileInstrumentRow } from "../invStateRows.js";
import type {
  InvAccountSettingsRow,
  InvImportBatchRow,
  InvInstrumentRenameRow,
  InvManualValuationRow,
  InvPositionSnapshotRow,
  InvTransactionRow,
} from "../rows.js";
import {
  event,
  gidOf,
  type MapContext,
  type RowEvents,
  requiredGid,
  rowEvents,
  stampsOf,
} from "./context.js";

const SEGMENT_SETTERS: readonly string[] = ["owner", "agent"];

/**
 * Per instrument of the closure (ascending id): `instrument.created` (creation alias of phase 1),
 * then one `instrument.aliasAdded` per alias, ascending id (spec 4.6, 5.1 group 5).
 */
export function mapInstruments(ctx: MapContext): RowEvents[] {
  const out: RowEvents[] = [];
  for (const [id, identity] of ctx.ids.instruments) {
    const r = identity.row;
    const created = ctx.attempt(() => {
      const data = {
        name: r.name,
        currency: r.currency,
        assetClass: r.assetClass,
        symbol: r.symbol,
        isin: r.isin,
        mic: r.mic,
        region: r.region,
        sector: r.sector,
        tags: ctx.rw.json("inv_instruments", "tags", r.tags),
        needsClassification: r.needsClassification,
        valuationMode: r.valuationMode,
        status: r.status,
        creationAlias: identity.creationAlias,
      };
      return rowEvents("inv_instruments", id, [
        event("instrument.created", identity.gid, data, stampsOf(r, ["createdAt", "updatedAt"])),
      ]);
    });
    if (created !== undefined) out.push(created);
    for (const a of identity.aliases) {
      const gid = gidOf(ctx, "inv_instrument_aliases", a.id);
      if (gid === undefined) continue;
      const data = {
        instrument: identity.gid,
        namespace: a.namespace,
        value: a.value,
        guessed: a.guessed,
      };
      out.push(
        rowEvents("inv_instrument_aliases", a.id, [
          event("instrument.aliasAdded", gid, data, stampsOf(a, ["createdAt"])),
        ]),
      );
    }
  }
  return out;
}

/** `invAccount.settingsSet` with all three fields (a snapshot). */
export function mapInvAccountSettings(
  r: InvAccountSettingsRow,
  ctx: MapContext,
): RowEvents | undefined {
  const gid = gidOf(ctx, "inv_account_settings", r.accountId);
  if (gid === undefined) return undefined;
  const data = {
    account: requiredGid(ctx, "accounts", r.accountId),
    wrapper: r.wrapper,
    importer: r.importer,
    mappingYaml: r.mappingYaml,
  };
  return rowEvents("inv_account_settings", r.accountId, [
    event("invAccount.settingsSet", gid, data, stampsOf(r, ["createdAt", "updatedAt"])),
  ]);
}

/** `invImport.recorded`; `archive` only for an archive whose bytes match (spec 4.4). */
export function mapInvImport(r: InvImportBatchRow, ctx: MapContext): RowEvents | undefined {
  const gid = gidOf(ctx, "inv_import_batches", r.id);
  if (gid === undefined) return undefined;
  const archive = archiveRef(ctx.files, r, (reason) => ctx.count("inv_import_batches", reason));
  const data = {
    account: requiredGid(ctx, "accounts", r.accountId),
    importer: r.importer,
    broker: r.broker,
    fileName: r.fileName,
    fileSha256: r.fileSha256,
    ...(archive === undefined ? {} : { archive }),
    txnCount: r.txnCount,
    duplicateCount: r.duplicateCount,
    positionCount: r.positionCount,
    renameCount: r.renameCount,
    statusChangeCount: r.statusChangeCount,
    instrumentCount: r.instrumentCount,
    correctionCount: r.correctionCount,
    warnings: ctx.rw.json("inv_import_batches", "warnings", r.warnings),
  };
  return rowEvents("inv_import_batches", r.id, [
    event("invImport.recorded", gid, data, stampsOf(r, ["createdAt"])),
  ]);
}

/** `invTxn.imported`: dedupHashV2 of phase 1, or `manual:<gid>` for a manual row (S26-F1). */
export function mapInvTxn(r: InvTransactionRow, ctx: MapContext): RowEvents | undefined {
  const gid = gidOf(ctx, "inv_transactions", r.id);
  const dedupHash = ctx.ids.invDedupHashes.get(r.id);
  if (gid === undefined || dedupHash === undefined) return undefined;
  const t = "inv_transactions";
  const data = {
    account: requiredGid(ctx, "accounts", r.accountId),
    batch: ctx.rw.ref(t, "import_batch_id", "inv_import_batches", r.importBatchId),
    type: r.type,
    tradeDate: r.tradeDate,
    settleDate: r.settleDate,
    instrument: ctx.rw.ref(t, "instrument_id", "inv_instruments", r.instrumentId),
    quantity: r.quantity,
    price: r.price,
    currency: r.currency,
    grossAmount: r.grossAmount,
    fee: r.fee,
    tax: r.tax,
    cashAmount: r.cashAmount,
    cashCurrency: r.cashCurrency,
    fxRate: r.fxRate,
    splitRatio: r.splitRatio,
    note: r.note,
    source: r.source,
    externalRef: r.externalRef,
    dedupHash,
    createdAt: r.createdAt,
  };
  return rowEvents(t, r.id, [event("invTxn.imported", gid, data, stampsOf(r, ["createdAt"]))]);
}

export function mapPosition(r: InvPositionSnapshotRow, ctx: MapContext): RowEvents | undefined {
  const t = "inv_position_snapshots";
  const gid = gidOf(ctx, t, r.id);
  if (gid === undefined) return undefined;
  const data = {
    account: requiredGid(ctx, "accounts", r.accountId),
    instrument: requiredGid(ctx, "inv_instruments", r.instrumentId),
    asOf: r.asOf,
    quantity: r.quantity,
    currency: r.currency,
    avgPrice: r.avgPrice,
    marketValue: r.marketValue,
    batch: ctx.rw.ref(t, "import_batch_id", "inv_import_batches", r.importBatchId),
  };
  return rowEvents(t, r.id, [
    event("position.snapshotImported", gid, data, stampsOf(r, ["createdAt"])),
  ]);
}

export function mapRename(r: InvInstrumentRenameRow, ctx: MapContext): RowEvents | undefined {
  const t = "inv_instrument_renames";
  const gid = gidOf(ctx, t, r.id);
  if (gid === undefined) return undefined;
  const data = {
    date: r.date,
    old: requiredGid(ctx, "inv_instruments", r.oldInstrumentId),
    new: requiredGid(ctx, "inv_instruments", r.newInstrumentId),
    note: r.note,
    batch: ctx.rw.ref(t, "import_batch_id", "inv_import_batches", r.importBatchId),
  };
  return rowEvents(t, r.id, [
    event("instrumentRename.recorded", gid, data, stampsOf(r, ["createdAt"])),
  ]);
}

export function mapValuation(r: InvManualValuationRow, ctx: MapContext): RowEvents | undefined {
  const gid = gidOf(ctx, "inv_manual_valuations", r.id);
  if (gid === undefined) return undefined;
  const data = {
    instrument: requiredGid(ctx, "inv_instruments", r.instrumentId),
    asOf: r.asOf,
    unitValue: r.unitValue,
    currency: r.currency,
    note: r.note,
  };
  return rowEvents("inv_manual_valuations", r.id, [
    event("valuation.set", gid, data, stampsOf(r, ["createdAt"])),
  ]);
}

/**
 * `instrumentOverride.set` with every override field (null = the shared default), then `.planSet`
 * when a plan or its reason is stored and `.segmentSet` when a segment is (a segment without an
 * owner / agent setter is `bad_enum`, that event only).
 */
export function mapOverride(r: InvProfileInstrumentRow, ctx: MapContext): RowEvents | undefined {
  const t = "inv_profile_instruments";
  const gid = gidOf(ctx, t, r.id);
  if (gid === undefined) return undefined;
  const instrument = requiredGid(ctx, "inv_instruments", r.instrumentId);
  const stamps = stampsOf(r, ["createdAt", "updatedAt", "planAt"]);
  const fields = {
    instrument,
    name: r.name,
    assetClass: r.assetClass,
    tags: ctx.rw.json(t, "tags", r.tags),
    region: r.region,
    sector: r.sector,
    valuationMode: r.valuationMode,
    status: r.status,
    needsClassification: r.needsClassification,
  };
  const events = [event("instrumentOverride.set", gid, fields, stamps)];
  if (r.plan !== null || r.planReason !== null) {
    const plan = { instrument, plan: r.plan, reason: r.planReason };
    events.push(event("instrumentOverride.planSet", gid, plan, stamps));
  }
  if (r.segment !== null) {
    if (r.segmentBy !== null && SEGMENT_SETTERS.includes(r.segmentBy)) {
      const segment = { instrument, segment: r.segment, by: r.segmentBy };
      events.push(event("instrumentOverride.segmentSet", gid, segment, stamps));
    } else {
      ctx.count(t, "bad_enum");
    }
  }
  return rowEvents(t, r.id, events);
}
