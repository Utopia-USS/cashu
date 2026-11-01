// TRANSITIONAL(S49): the sync bridge exists only while the Python app writes (S31a spec 2.1).
//
// The shape of a table's bridge (S31a spec 4.4): how a merged outbox row of one Python table becomes
// catalog events. Rule: the bridge never builds a payload field a genesis mapper already builds. An
// insert IS the row's genesis (the genesis snapshot mapper on the decoded `post`); an update chooses
// event types from the changed columns and takes each payload field from the genesis snapshot of
// `post` (and `pre` where the event needs the old value), so genesis stays the one owner of the
// Python-row -> event semantics and its output is unchanged. `columns` classifies every synced
// Python column (the coverage guard, `coverage.ts`): the event types that carry it, or why it is not
// shipped.
import type { EventType } from "../../events/v1/catalog.js";
import type { EventDraft, MapContext, RowEvents } from "../../genesis/map/context.js";
import type { LogicalRow } from "../merge.js";

/** A Python column's classification: the events that carry a change of it, or a reason. */
export type ColumnRule =
  | { readonly carriedBy: readonly EventType[] }
  | { readonly notShipped: string };

/** One merged row of a table with its decoded values. */
export interface RowChange<R> {
  readonly row: LogicalRow;
  /** The row's own gid (resolved before mapping). */
  readonly gid: string;
  /** `post` decoded (insert / update). */
  readonly post: R | undefined;
  /** The row before the change: `post` overlaid with `prev` (update), the last state (delete). */
  readonly pre: R | undefined;
  /** Python columns of the merged `fields`. */
  readonly changed: ReadonlySet<string>;
}

export type Handler<R> = (change: RowChange<R>, ctx: MapContext) => readonly EventDraft[];

/** The bridge of one Python table. */
/** Who fills a table's gid (Python `sync_outbox.SPECS[...].gid`; `global` = shared instruments). */
export type GidKind = "ulid" | "det" | "shipper" | "vault" | "none" | "global";

export interface TableBridge<R = never> {
  readonly table: string;
  readonly gid: GidKind;
  readonly columns: Readonly<Record<string, ColumnRule>>;
  readonly insert?: Handler<R>;
  readonly update?: Handler<R>;
  readonly delete?: Handler<R>;
  readonly explicit?: Partial<Record<"merge" | "undo" | "leg_delete", Handler<R>>>;
  /** Event types the table's events may carry for an explicit op (coverage of ops). */
  readonly explicitEvents?: Partial<Record<"merge" | "undo" | "leg_delete", readonly EventType[]>>;
}

/** A row that cannot ship: the loop stops on it (D4); `reason` names the table, never a value. */
export class BridgeBlock extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`bridge blocked: ${reason}`);
    this.name = "BridgeBlock";
    this.reason = reason;
  }
}

/** Events of a genesis mapper's row, or a block when the mapper left the row out (a gid missing). */
export function eventsOf(table: string, mapped: RowEvents | undefined): readonly EventDraft[] {
  if (mapped === undefined) throw new BridgeBlock(`unresolved:${table}`);
  return mapped.events;
}

/** The single event of `type` a genesis snapshot holds, or a block (the snapshot lacks it). */
export function pick(table: string, events: readonly EventDraft[], type: EventType): EventDraft {
  const found = events.find((e) => e.type === type);
  if (found === undefined) throw new BridgeBlock(`snapshot-lacks:${table}:${type}`);
  return found;
}

/** An event built from a snapshot event: same gid and stamps, `data` replaced (stamps kept). */
export function derived(
  from: EventDraft,
  type: EventType,
  data: Readonly<Record<string, unknown>>,
): EventDraft {
  const stamps = from.data.stamps;
  return { type, gid: from.gid, data: stamps === undefined ? data : { ...data, stamps } };
}

/** The subset of a snapshot payload under `keys` (payload field names). */
export function fieldsOf(
  data: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in data) out[k] = data[k];
  return out;
}

/** True when any of `columns` changed. */
export const anyChanged = (change: RowChange<unknown>, ...columns: string[]): boolean =>
  columns.some((c) => change.changed.has(c));

/** Classifies `columns` as carried by `types`. */
export function carried(
  types: readonly EventType[],
  ...columns: string[]
): Record<string, ColumnRule> {
  return Object.fromEntries(columns.map((c) => [c, { carriedBy: types }]));
}

/** Classifies `columns` as not shipped, with the reason. */
export function notShipped(reason: string, ...columns: string[]): Record<string, ColumnRule> {
  return Object.fromEntries(columns.map((c) => [c, { notShipped: reason }]));
}
