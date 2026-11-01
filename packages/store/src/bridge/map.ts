// TRANSITIONAL(S49): the sync bridge exists only while the Python app writes (S31a spec 2.1).
//
// Dispatch of one merged outbox row to its table's bridge (S31a spec 4.3, 4.4): the row's own gid is
// fixed first (Python's, the vault's `sync_ids` for an existing row, phase 1 for a shipper-computed
// insert, or, for a DET row Python could not compute, the gid of its own event's DET parts), then
// `post` / `pre` are decoded with the genesis table specs and the table's handler builds the events.
// Every Python column a row changed is associated with the event that carries it (the ack clocks,
// spec 4.7).
import { detPartsOf } from "../events/v1/det-parts.js";
import type { EventDraft } from "../genesis/map/context.js";
import { decodeValues } from "./decode.js";
import { agentBridges } from "./map/agent.js";
import { assetsLoansBridges } from "./map/assetsLoans.js";
import { budgetBridges } from "./map/budget.js";
import { coreBridges } from "./map/core.js";
import { investmentsBridges } from "./map/investments.js";
import { journalBridges } from "./map/journal.js";
import { researchBridges } from "./map/research.js";
import { signalsBridges } from "./map/signals.js";
import { BridgeBlock, type RowChange, type TableBridge } from "./map/types.js";
import type { LogicalRow } from "./merge.js";
import type { VaultMapping } from "./resolve.js";

/** Every table's bridge, by Python table name. */
export const BRIDGES: ReadonlyMap<string, TableBridge> = new Map(
  [
    ...coreBridges,
    ...budgetBridges,
    ...assetsLoansBridges,
    ...investmentsBridges,
    ...journalBridges,
    ...signalsBridges,
    ...researchBridges,
    ...agentBridges,
  ].map((b) => [b.table, b]),
);

/** The events of one row and, per event, the Python columns whose change it carries. */
export interface MappedRow {
  readonly events: readonly EventDraft[];
  readonly carries: readonly (readonly string[])[];
}

const NOTHING: MappedRow = { events: [], carries: [] };
/** A stand-in for a DET gid the row's own event fixes (a keyed UUIDv8 no salt produces). */
const PENDING_DET = "00000000-0000-8000-8000-000000000000";

function bridgeOf(table: string): TableBridge {
  const b = BRIDGES.get(table);
  if (b === undefined) throw new BridgeBlock(`no-bridge:${table}`);
  return b;
}

/** Python columns of the change -> the index of the event carrying each (spec 4.7). */
function carriesOf(
  bridge: TableBridge,
  row: LogicalRow,
  events: readonly EventDraft[],
): (readonly string[])[] {
  const out: string[][] = events.map(() => []);
  if (row.op !== "insert" && row.op !== "update") return out;
  for (const column of Object.keys(row.fields)) {
    const rule = bridge.columns[column];
    if (rule === undefined || !("carriedBy" in rule)) continue;
    let index = -1;
    events.forEach((e, i) => {
      if (rule.carriedBy.includes(e.type)) index = i;
    });
    if (index < 0 && row.op === "insert" && events.length > 0) index = 0;
    if (index >= 0) out[index]?.push(column);
  }
  return out;
}

function decoded(row: LogicalRow, values: Readonly<Record<string, unknown>>, profileId: number) {
  const scoped = row.profileId === null ? values : { profile_id: profileId, ...values };
  return decodeValues<never>(row.table, scoped);
}

/** The own gid of an insert, or `PENDING_DET` for a DET row whose event fixes it. */
function insertGid(bridge: TableBridge, row: LogicalRow, vm: VaultMapping): string | undefined {
  if (row.gid !== null) {
    vm.put(row.table, row.localId, row.gid, false);
    return row.gid;
  }
  switch (bridge.gid) {
    case "shipper": {
      const values = row.post ?? row.fields;
      const account = values.account_id;
      const accountId = account === null || account === undefined ? undefined : String(account);
      const gid = vm.shipperGid(row.table, row.localId, accountId);
      vm.put(row.table, row.localId, gid, true);
      return gid;
    }
    case "global": {
      const gid = vm.resolver.gid(row.table, row.localId);
      if (gid === undefined) throw new BridgeBlock(`unresolved:${row.table}`);
      vm.put(row.table, row.localId, gid, true);
      return gid;
    }
    case "det":
      vm.put(row.table, row.localId, PENDING_DET, false);
      return PENDING_DET;
    case "none":
      return undefined;
    default:
      throw new BridgeBlock(`unresolved:${row.table}`);
  }
}

/** Replaces the pending DET gid by the gid of the row's own event's DET parts. */
function settleDet(row: LogicalRow, events: readonly EventDraft[], vm: VaultMapping): EventDraft[] {
  const own = events.find((e) => e.gid === PENDING_DET);
  if (own === undefined) return [...events];
  const parts = detPartsOf(own.type, own.data);
  if (parts === undefined) throw new BridgeBlock(`unresolved:${row.table}`);
  const gid = vm.det(parts.table, parts.parts);
  vm.put(row.table, row.localId, gid, true);
  return events.map((e) => (e.gid === PENDING_DET ? { ...e, gid } : e));
}

/** Python columns that reference an instrument (what a merge repoints). */
const INSTRUMENT_REFS: readonly string[] = [
  "instrument_id",
  "old_instrument_id",
  "new_instrument_id",
];
/** Tables whose rows Python deletes when a merge makes two rows collide (the fold collapses them). */
const MERGE_COLLAPSED: readonly string[] = [
  "watchlist_items",
  "inv_profile_instruments",
  "inv_instrument_renames",
  "inv_instrument_aliases",
];

/**
 * The redirect of an instrument merge earlier in the same transaction (lead decision, S31c item 1):
 * `instrument.merged` makes the fold re-key every reference of the source onto the target and
 * collapse rows that then collide, so the rows Python's raw-SQL merge rewrote carry nothing more for
 * those changes: a repoint (source -> target, also inside a signal's dedup key) is dropped from the
 * row, and a colliding row's delete is a no-event row. Every other column change ships normally.
 */
function throughMerge(row: LogicalRow, txn: readonly LogicalRow[]): LogicalRow | undefined {
  const at = txn.indexOf(row);
  const merges = txn.filter(
    (r, i) => r.op === "merge" && r.table === "inv_instruments" && (at < 0 || i < at),
  );
  if (merges.length === 0) return row;
  for (const m of merges) {
    const source = String(m.key?.source ?? "");
    const target = String(m.key?.target ?? "");
    if (row.op === "delete") {
      const refs = INSTRUMENT_REFS.map((c) => String(row.fields[c] ?? ""));
      if (MERGE_COLLAPSED.includes(row.table) && refs.some((v) => v === source || v === target)) {
        return undefined;
      }
      continue;
    }
    if (row.op !== "update") continue;
    const prev = row.prev ?? {};
    const token = new RegExp(`(^|\\|)i:${source}(\\||$)`, "g");
    const kept = Object.entries(row.fields).filter(([col, value]) => {
      if (INSTRUMENT_REFS.includes(col)) {
        return !(String(prev[col] ?? "") === source && String(value ?? "") === target);
      }
      if (col === "dedup_key" && typeof prev.dedup_key === "string") {
        return prev.dedup_key.replace(token, `$1i:${target}$2`) !== value;
      }
      return true;
    });
    if (kept.length !== Object.keys(row.fields).length) {
      const cols = new Set(kept.map(([c]) => c));
      const fields = Object.fromEntries(kept);
      const nextPrev = Object.fromEntries(Object.entries(prev).filter(([c]) => cols.has(c)));
      return { ...row, fields, prev: nextPrev };
    }
  }
  return row;
}

/**
 * The events of one merged row in one vault. A row of a shared table (instruments, aliases) is
 * mapped only in a vault that holds its instrument; the caller decides that (`plan.ts`).
 */
export function mapRow(
  input: LogicalRow,
  vm: VaultMapping,
  txn: readonly LogicalRow[] = [input],
): MappedRow {
  const redirected = throughMerge(input, txn);
  if (
    redirected === undefined ||
    (redirected.op === "update" && Object.keys(redirected.fields).length === 0)
  ) {
    return NOTHING;
  }
  const row = redirected;
  const profileId = vm.input.profileId;
  if (row.op === "merge" && row.table === "inv_instruments") {
    // A vault that holds one side only (review F2, lead S31c item 1).
    const gids = (
      row.key?.gids as Record<string, { source?: unknown; target?: unknown }> | undefined
    )?.[String(profileId)];
    const source = typeof gids?.source === "string" ? gids.source : undefined;
    const target = typeof gids?.target === "string" ? gids.target : undefined;
    if (source !== undefined && target === undefined) {
      // The vault held only the source: the target joins it (its own identity and snapshot), then
      // the merge folds the source in, as in a vault that held both.
      const src = String(row.key?.source ?? "");
      const moved = new Set(
        txn
          .filter(
            (r) =>
              r.table === "inv_instrument_aliases" &&
              r.op === "update" &&
              String(r.prev?.instrument_id ?? "") === src,
          )
          .map((r) => Number(r.localId)),
      );
      vm.mergeTarget(String(row.key?.target ?? ""), moved);
    } else if (source === undefined && target !== undefined) {
      return NOTHING; // the vault held only the target: nothing changes there
    }
  }
  const bridge = bridgeOf(row.table);
  const changed = new Set(Object.keys(row.fields));
  let events: readonly EventDraft[];
  if (row.op === "insert") {
    if (bridge.insert === undefined) throw new BridgeBlock(`no-insert-mapper:${row.table}`);
    const gid = insertGid(bridge, row, vm) ?? "";
    const post = decoded(row, row.post ?? row.fields, profileId);
    if (!post.ok) throw new BridgeBlock(post.reason);
    const change: RowChange<never> = {
      row,
      gid,
      post: post.row,
      pre: undefined,
      changed,
      txn,
      vaultProfileId: profileId,
    };
    events = settleDet(row, bridge.insert(change, vm.ctx), vm);
  } else {
    const gid = row.gid ?? vm.existing(row.table, row.localId);
    // An explicit op's handler resolves what it addresses (a cash leg has no gid of its own).
    const explicit = row.op !== "update" && row.op !== "delete";
    if (gid === undefined && bridge.gid !== "none" && !explicit) {
      throw new BridgeBlock(`unresolved:${row.table}`);
    }
    // The genesis mapper reads the row's own gid through the resolver.
    if (gid !== undefined) vm.put(row.table, row.localId, gid, false);
    if (row.op === "update") {
      if (bridge.update === undefined) throw new BridgeBlock(`no-update-mapper:${row.table}`);
      const values = row.post ?? row.fields;
      const post = decoded(row, values, profileId);
      const pre = decoded(row, { ...values, ...(row.prev ?? {}) }, profileId);
      if (!post.ok) throw new BridgeBlock(post.reason);
      const change: RowChange<never> = {
        row,
        gid: gid ?? "",
        post: post.row,
        pre: pre.ok ? pre.row : undefined,
        changed,
        txn,
        vaultProfileId: profileId,
      };
      events = bridge.update(change, vm.ctx);
    } else if (row.op === "delete") {
      if (bridge.delete === undefined) throw new BridgeBlock(`no-delete-event:${row.table}`);
      const pre = decoded(row, row.fields, profileId);
      const change: RowChange<never> = {
        row,
        gid: gid ?? "",
        post: undefined,
        pre: pre.ok ? pre.row : undefined,
        changed,
        txn,
        vaultProfileId: profileId,
      };
      events = bridge.delete(change, vm.ctx);
    } else {
      const handler = bridge.explicit?.[row.op];
      if (handler === undefined) throw new BridgeBlock(`no-explicit-mapper:${row.table}:${row.op}`);
      const change: RowChange<never> = {
        row,
        gid: gid ?? "",
        post: undefined,
        pre: undefined,
        changed,
        txn,
        vaultProfileId: profileId,
      };
      events = handler(change, vm.ctx);
    }
  }
  if (events.length === 0) return NOTHING;
  return { events, carries: carriesOf(bridge, row, events) };
}
