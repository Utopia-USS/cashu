// TRANSITIONAL(S49): the sync bridge exists only while the Python app writes (S31a spec 2.1).
//
// Bridges of the investments tables (S31a spec 4.4; events.md 8.5, 8.6). Inserts are the genesis
// snapshot of `post` (`mapInvAccountSettings`, `mapInvImport`, `mapInvTxn`, `mapPosition`,
// `mapRename`, `mapValuation`, `mapOverride`, `mapInstruments`); updates take every payload field
// from the genesis snapshot of `post`:
// - account settings and manual valuations: the whole value again (LWW-F on the row key);
// - imports, transactions, position snapshots, renames: CREATE / APPEND, no update event: blocked;
// - shared instruments: `instrument.updated` with the changed fields; an alias insert (or a guessed
//   alias confirmed) is `instrument.aliasAdded`; the owner merge (explicit `merge`) is
//   `instrument.merged`. An instrument insert never reaches a bridge: the planner ships new
//   instruments as a closure snapshot when a vault starts to reference them;
// - profile overrides: override columns -> `instrumentOverride.set` (changed fields), plan ->
//   `.planSet`, segment -> `.segmentSet` (a clear carries no setter in Python: see `segmentClear`).

import type { VaultIds } from "../../genesis/ids.js";
import type { InvProfileInstrumentRow } from "../../genesis/invStateRows.js";
import { type EventDraft, event, type MapContext } from "../../genesis/map/context.js";
import {
  mapInstruments,
  mapInvAccountSettings,
  mapInvImport,
  mapInvTxn,
  mapOverride,
  mapPosition,
  mapRename,
  mapValuation,
} from "../../genesis/map/investments.js";
import type {
  InvAccountSettingsRow,
  InvImportBatchRow,
  InvInstrumentAliasRow,
  InvInstrumentRenameRow,
  InvInstrumentRow,
  InvManualValuationRow,
  InvPositionSnapshotRow,
  InvTransactionRow,
} from "../../genesis/rows.js";
import {
  BridgeBlock,
  carried,
  derived,
  eventsOf,
  fieldsOf,
  pick,
  type RowChange,
  type TableBridge,
} from "./types.js";

type Identity = VaultIds["instruments"] extends ReadonlyMap<number, infer I> ? I : never;

function need<R>(row: R | undefined): R {
  if (row === undefined) throw new BridgeBlock("decode");
  return row;
}

/** A reference genesis requires (`requiredGid`): a miss blocks instead of breaking an invariant. */
function requireRefs(ctx: MapContext, refs: readonly (readonly [string, number])[]): void {
  for (const [table, id] of refs) {
    if (ctx.ids.resolver.gid(table, String(id)) === undefined) {
      throw new BridgeBlock(`unresolved:${table}`);
    }
  }
}

/** A change of any of `columns` no catalog event carries: block, never ship it half. */
function refuseChanged(change: RowChange<unknown>, table: string, columns: readonly string[]) {
  for (const c of columns) {
    if (change.changed.has(c)) throw new BridgeBlock(`immutable:${table}:${c}`);
  }
}

/** Every changed column blocks: the table's only event is its create (CREATE / APPEND). */
function refuseAll(table: string) {
  return (c: RowChange<unknown>): readonly EventDraft[] => {
    refuseChanged(c, table, [...c.changed]);
    return [];
  };
}

// ----------------------------------------------------------------------------------------------- //
// Accounts, imports, transactions, positions, renames, valuations (8.5)

const settingsSnapshot = (c: RowChange<InvAccountSettingsRow>, ctx: MapContext) => {
  const r = need(c.post);
  requireRefs(ctx, [["accounts", r.accountId]]);
  return eventsOf(
    "inv_account_settings",
    ctx.attempt(() => mapInvAccountSettings(r, ctx)),
  );
};

const accountSettings: TableBridge<InvAccountSettingsRow> = {
  table: "inv_account_settings",
  gid: "det",
  columns: carried(
    ["invAccount.settingsSet"],
    "account_id",
    "wrapper",
    "importer",
    "mapping_yaml",
    "created_at",
  ),
  insert: settingsSnapshot,
  update: settingsSnapshot,
};

const importBatches: TableBridge<InvImportBatchRow> = {
  table: "inv_import_batches",
  gid: "ulid",
  columns: carried(
    ["invImport.recorded"],
    ...["id", "profile_id", "account_id", "importer", "broker", "file_name", "file_sha256"],
    ...["archive_path", "txn_count", "duplicate_count", "position_count", "rename_count"],
    ...["status_change_count", "instrument_count", "correction_count", "warnings", "created_at"],
  ),
  insert: (c, ctx) => {
    const r = need(c.post);
    requireRefs(ctx, [["accounts", r.accountId]]);
    return eventsOf(
      "inv_import_batches",
      ctx.attempt(() => mapInvImport(r, ctx)),
    );
  },
  update: refuseAll("inv_import_batches"),
};

const transactions: TableBridge<InvTransactionRow> = {
  table: "inv_transactions",
  gid: "shipper",
  columns: carried(
    ["invTxn.imported"],
    ...["id", "account_id", "type", "trade_date", "settle_date", "instrument_id", "quantity"],
    ...["price", "currency", "gross_amount", "fee", "tax", "cash_amount", "cash_currency"],
    ...["fx_rate", "split_ratio", "note", "source", "import_batch_id", "external_ref"],
    ...["dedup_hash", "created_at"],
  ),
  insert: (c, ctx) => {
    const r = need(c.post);
    requireRefs(ctx, [["accounts", r.accountId]]);
    const events = eventsOf(
      "inv_transactions",
      ctx.attempt(() => mapInvTxn(r, ctx)),
    );
    if (r.source !== "manual") return events;
    // Phase 1 hashes a manual row with its genesis gid; a live manual row has the gid Python minted
    // (or the bridge minted), and `parseEvent` requires `manual:` + the event gid (gid.md 4.6).
    return events.map((e) => ({ ...e, data: { ...e.data, dedupHash: `manual:${c.gid}` } }));
  },
  update: refuseAll("inv_transactions"),
};

/** Columns an overlapping re-import rewrites without changing the snapshot (provenance only). */
const PROVENANCE: readonly string[] = ["import_batch_id", "created_at"];

const positions: TableBridge<InvPositionSnapshotRow> = {
  table: "inv_position_snapshots",
  gid: "det",
  columns: carried(
    ["position.snapshotImported"],
    ...["id", "account_id", "instrument_id", "as_of", "quantity", "currency", "avg_price"],
    ...["market_value", "import_batch_id", "created_at"],
  ),
  insert: (c, ctx) => {
    const r = need(c.post);
    requireRefs(ctx, [
      ["accounts", r.accountId],
      ["inv_instruments", r.instrumentId],
    ]);
    return eventsOf(
      "inv_position_snapshots",
      ctx.attempt(() => mapPosition(r, ctx)),
    );
  },
  // A re-import upserts the same (account, instrument, as_of): its snapshot event is the row's DET
  // gid again, which `position.snapshotImported` (CREATE) dedupes, first import wins (lead decision,
  // S31c item 1). So a provenance-only rewrite (import_batch_id / created_at of an overlapping
  // re-import) is a no-event row, explicitly; a changed VALUE cannot be carried by a CREATE and
  // blocks visibly (follow-up: an LWW re-snapshot event) instead of diverging silently.
  update: (c) => {
    const changed = [...c.changed];
    if (changed.every((col) => PROVENANCE.includes(col))) return [];
    throw new BridgeBlock("resnapshot:inv_position_snapshots");
  },
};

const renames: TableBridge<InvInstrumentRenameRow> = {
  table: "inv_instrument_renames",
  gid: "det",
  columns: carried(
    ["instrumentRename.recorded"],
    ...["id", "profile_id", "date", "old_instrument_id", "new_instrument_id", "note"],
    ...["import_batch_id", "created_at"],
  ),
  insert: (c, ctx) => {
    const r = need(c.post);
    requireRefs(ctx, [
      ["inv_instruments", r.oldInstrumentId],
      ["inv_instruments", r.newInstrumentId],
    ]);
    return eventsOf(
      "inv_instrument_renames",
      ctx.attempt(() => mapRename(r, ctx)),
    );
  },
  update: refuseAll("inv_instrument_renames"),
};

function valuationSnapshot(c: RowChange<InvManualValuationRow>, ctx: MapContext) {
  const r = need(c.post);
  requireRefs(ctx, [["inv_instruments", r.instrumentId]]);
  return eventsOf(
    "inv_manual_valuations",
    ctx.attempt(() => mapValuation(r, ctx)),
  );
}

const valuations: TableBridge<InvManualValuationRow> = {
  table: "inv_manual_valuations",
  gid: "det",
  columns: carried(
    ["valuation.set"],
    ...["id", "profile_id", "instrument_id", "as_of", "unit_value", "currency", "note"],
    "created_at",
  ),
  insert: valuationSnapshot,
  update: (c, ctx) => {
    refuseChanged(c, "inv_manual_valuations", ["instrument_id", "as_of"]);
    return valuationSnapshot(c, ctx);
  },
};

// ----------------------------------------------------------------------------------------------- //
// Shared instruments and aliases (8.6)

/** A map context whose instrument closure is exactly `identity` (the genesis mapper's input). */
function withInstrument(ctx: MapContext, id: number, identity: Identity): MapContext {
  const ids = ctx.ids;
  const instruments: ReadonlyMap<number, Identity> = new Map([[id, identity]]);
  return {
    ...ctx,
    ids: {
      det: ids.det,
      resolver: ids.resolver,
      get accounts() {
        return ids.accounts;
      },
      instruments,
      get budgetTxns() {
        return ids.budgetTxns;
      },
      get invDedupHashes() {
        return ids.invDedupHashes;
      },
      get cashLegClaims() {
        return ids.cashLegClaims;
      },
    },
  };
}

/** Python column -> `instrument.updated` patch field. */
const INSTRUMENT_FIELDS: readonly (readonly [string, string])[] = [
  ["name", "name"],
  ["currency", "currency"],
  ["asset_class", "assetClass"],
  ["symbol", "symbol"],
  ["isin", "isin"],
  ["mic", "mic"],
  ["region", "region"],
  ["sector", "sector"],
  ["tags", "tags"],
  ["needs_classification", "needsClassification"],
  ["valuation_mode", "valuationMode"],
  ["status", "status"],
];

function instrumentUpdate(c: RowChange<InvInstrumentRow>, ctx: MapContext): readonly EventDraft[] {
  refuseChanged(c, "inv_instruments", ["id", "created_at"]);
  const post = need(c.post);
  const identity = { row: post, gid: c.gid, isin: post.isin, aliases: [], creationAlias: null };
  const snap = mapInstruments(withInstrument(ctx, post.id, identity));
  const created = pick("inv_instruments", snap[0]?.events ?? [], "instrument.created");
  const keys = INSTRUMENT_FIELDS.filter(([col]) => c.changed.has(col)).map(([, key]) => key);
  if (keys.length === 0) return [];
  return [derived(created, "instrument.updated", fieldsOf(created.data, keys))];
}

function instrumentMerge(c: RowChange<InvInstrumentRow>, ctx: MapContext): readonly EventDraft[] {
  const key = c.row.key ?? {};
  // Python records each profile's gids of both instruments in the merge row's key (it drops the
  // source mapping at emit); a vault without them resolves the live map.
  const perProfile = (
    key.gids as Record<string, { source?: unknown; target?: unknown }> | undefined
  )?.[String(c.vaultProfileId)];
  const resolve = (fromKey: unknown, local: unknown) =>
    typeof fromKey === "string"
      ? fromKey
      : local === undefined || local === null
        ? undefined
        : ctx.ids.resolver.gid("inv_instruments", String(local));
  const source = resolve(perProfile?.source, key.source);
  const target = resolve(perProfile?.target, key.target);
  if (source === undefined || target === undefined) {
    throw new BridgeBlock("unresolved:inv_instruments");
  }
  return [event("instrument.merged", source, { source, target, reason: "owner" })];
}

const instruments: TableBridge<InvInstrumentRow> = {
  table: "inv_instruments",
  gid: "global",
  columns: {
    ...carried(["instrument.created"], "id", "created_at"),
    ...carried(
      ["instrument.created", "instrument.updated"],
      ...INSTRUMENT_FIELDS.map(([col]) => col),
    ),
  },
  // No insert: the planner ships a new instrument as the closure snapshot of the vault that first
  // references it; an instrument insert reaching the dispatcher is a planner bug and blocks.
  update: instrumentUpdate,
  explicit: { merge: instrumentMerge },
  explicitEvents: { merge: ["instrument.merged"] },
};

/** `instrument.aliasAdded` of `alias` (as stored now), by the genesis instrument mapper. */
function aliasAdded(c: RowChange<InvInstrumentAliasRow>, ctx: MapContext): readonly EventDraft[] {
  const alias = need(c.post);
  const instrumentGid = ctx.ids.resolver.gid("inv_instruments", String(alias.instrumentId));
  const live = ctx.ids.instruments.get(alias.instrumentId);
  if (instrumentGid === undefined || live === undefined) {
    throw new BridgeBlock("unresolved:inv_instruments");
  }
  const identity = { ...live, gid: instrumentGid, aliases: [alias] };
  const rows = mapInstruments(withInstrument(ctx, alias.instrumentId, identity));
  const own = rows.find((r) => r.table === "inv_instrument_aliases");
  return [pick("inv_instrument_aliases", own?.events ?? [], "instrument.aliasAdded")];
}

const aliases: TableBridge<InvInstrumentAliasRow> = {
  table: "inv_instrument_aliases",
  gid: "global",
  columns: carried(
    ["instrument.aliasAdded"],
    ...["id", "instrument_id", "namespace", "value", "guessed", "created_at"],
  ),
  insert: aliasAdded,
  update: (c, ctx) => {
    const identity = ["id", "instrument_id", "namespace", "value", "created_at"];
    refuseChanged(c, "inv_instrument_aliases", identity);
    // A guessed alias confirmed (Python `add_aliases`): a claim with `guessed: false` (8.6). The
    // AND over claims never un-confirms, so a confirmed alias turning guessed has no event.
    if (need(c.post).guessed) throw new BridgeBlock("immutable:inv_instrument_aliases:guessed");
    return aliasAdded(c, ctx);
  },
};

// ----------------------------------------------------------------------------------------------- //
// Per-profile instrument overrides

/** Python column -> `instrumentOverride.set` patch field. */
const OVERRIDE_FIELDS: readonly (readonly [string, string])[] = [
  ["name", "name"],
  ["asset_class", "assetClass"],
  ["tags", "tags"],
  ["region", "region"],
  ["sector", "sector"],
  ["valuation_mode", "valuationMode"],
  ["status", "status"],
  ["needs_classification", "needsClassification"],
];

function overrideSnapshot(r: InvProfileInstrumentRow, ctx: MapContext) {
  requireRefs(ctx, [["inv_instruments", r.instrumentId]]);
  return eventsOf(
    "inv_profile_instruments",
    ctx.attempt(() => mapOverride(r, ctx)),
  );
}

/**
 * The setter of a segment clear: Python stores none. An owner segment can only be cleared by the
 * owner (Python refuses the agent); an agent segment keeps `agent`, so a concurrent owner segment on
 * another device wins the GUARD instead of being cleared.
 */
const segmentClear = (pre: InvProfileInstrumentRow) =>
  pre.segmentBy === "agent" ? "agent" : "owner";

function overrideUpdate(
  c: RowChange<InvProfileInstrumentRow>,
  ctx: MapContext,
): readonly EventDraft[] {
  refuseChanged(c, "inv_profile_instruments", ["id", "profile_id", "instrument_id", "created_at"]);
  const post = need(c.post);
  const snap = overrideSnapshot(post, ctx);
  const set = pick("inv_profile_instruments", snap, "instrumentOverride.set");
  const instrument = set.data.instrument;
  const out: EventDraft[] = [];
  const keys = OVERRIDE_FIELDS.filter(([col]) => c.changed.has(col)).map(([, key]) => key);
  if (keys.length > 0) {
    out.push(derived(set, "instrumentOverride.set", { instrument, ...fieldsOf(set.data, keys) }));
  }
  if (c.changed.has("plan") || c.changed.has("plan_reason")) {
    const plan = snap.find((e) => e.type === "instrumentOverride.planSet");
    out.push(
      plan ?? derived(set, "instrumentOverride.planSet", { instrument, plan: null, reason: null }),
    );
  }
  if (c.changed.has("segment") || c.changed.has("segment_by")) {
    if (post.segment === null) {
      const by = segmentClear(need(c.pre));
      out.push(derived(set, "instrumentOverride.segmentSet", { instrument, segment: null, by }));
    } else {
      out.push(pick("inv_profile_instruments", snap, "instrumentOverride.segmentSet"));
    }
  }
  return out;
}

const overrides: TableBridge<InvProfileInstrumentRow> = {
  table: "inv_profile_instruments",
  gid: "det",
  columns: {
    ...carried(["instrumentOverride.set"], "id", "profile_id", "instrument_id", "created_at"),
    ...carried(["instrumentOverride.set"], ...OVERRIDE_FIELDS.map(([col]) => col)),
    ...carried(["instrumentOverride.set", "instrumentOverride.planSet"], "plan", "plan_reason"),
    ...carried(
      ["instrumentOverride.set", "instrumentOverride.segmentSet"],
      "segment",
      "segment_by",
    ),
  },
  insert: (c, ctx) => overrideSnapshot(need(c.post), ctx),
  update: overrideUpdate,
};

export const investmentsBridges: readonly TableBridge[] = [
  accountSettings,
  importBatches,
  transactions,
  positions,
  renames,
  valuations,
  instruments,
  aliases,
  overrides,
];
