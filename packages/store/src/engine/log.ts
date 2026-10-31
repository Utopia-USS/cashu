// Access to the store's copy of the log (`event_log`).
import { canonicalJson } from "../canonical.js";
import type { SqlDriver, SqlStatement, SqlValue } from "../sql/driver.js";
import type { Payload } from "../upcast.js";
import type { FoldEvent } from "./types.js";

export type EventState = "applied" | "suppressed" | "parked";

export interface LogRow {
  seq: number;
  eid: string;
  hlc: string;
  at: string;
  type: string;
  v: number;
  gid: string;
  device: string;
  cause: string | null;
  origin: string | null;
  extra: string | null;
  state: EventState;
  reason: string | null;
  raw_data: string | null;
  data: string | null;
}

export type NewLogRow = Omit<LogRow, "seq">;

const FOLD_COLUMNS = "eid, hlc, at, type, v, gid, device, cause, origin, data";

type FoldRow = Pick<
  LogRow,
  "eid" | "hlc" | "at" | "type" | "v" | "gid" | "device" | "cause" | "origin" | "data"
>;

function toFoldEvent(r: FoldRow): FoldEvent {
  return {
    eid: r.eid,
    hlc: r.hlc,
    at: r.at,
    type: r.type,
    v: r.v,
    gid: r.gid,
    device: r.device,
    data: JSON.parse(r.data ?? "{}") as Payload,
    ...(r.cause === null ? {} : { cause: r.cause }),
    ...(r.origin === null ? {} : { origin: r.origin }),
  };
}

const CHUNK = 512;
/** Rows per multi-row INSERT (14 columns: far below SQLite's 32,766 bound parameters). */
const BATCH = 128;
const LOG_COLUMNS =
  "eid, hlc, at, type, v, gid, device, cause, origin, extra, state, reason, raw_data, data";
const LOG_ROW = "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

function logValues(r: NewLogRow): SqlValue[] {
  return [
    r.eid,
    r.hlc,
    r.at,
    r.type,
    r.v,
    r.gid,
    r.device,
    r.cause,
    r.origin,
    r.extra,
    r.state,
    r.reason,
    r.raw_data,
    r.data,
  ];
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}

/**
 * A chunk of values for an `IN (...)` list, padded with NULLs to the next power of two (`x IN (a,
 * NULL)` matches exactly `a`), so each chunked query has at most 10 shapes and its statement is
 * prepared once instead of on every call.
 */
function padded(part: readonly SqlValue[]): { list: string; values: SqlValue[] } {
  let n = 1;
  while (n < part.length) n *= 2;
  const values = [...part];
  while (values.length < n) values.push(null);
  return { list: placeholders(n), values };
}

export class EventLog {
  readonly #db: SqlDriver;
  readonly #insert: SqlStatement;
  readonly #byEid: SqlStatement;
  readonly #setState: SqlStatement;
  readonly #insertRef: SqlStatement;
  readonly #referrers: SqlStatement;
  readonly #keyed: SqlStatement;
  /** Statements of the variable-shape reads: a type list (fixed per materializer) x a padded size. */
  readonly #shapes = new Map<string, SqlStatement>();

  constructor(db: SqlDriver) {
    this.#db = db;
    this.#insert = db.prepare(`INSERT OR IGNORE INTO event_log (${LOG_COLUMNS}) VALUES ${LOG_ROW}`);
    this.#byEid = db.prepare("SELECT * FROM event_log WHERE eid = ?");
    this.#setState = db.prepare("UPDATE event_log SET state = ? WHERE eid = ?");
    this.#insertRef = db.prepare("INSERT OR IGNORE INTO event_refs (subject, eid) VALUES (?, ?)");
    this.#referrers = db.prepare(
      `SELECT e.gid FROM event_refs r JOIN event_log e ON e.eid = r.eid
       WHERE r.subject = ? AND e.state = 'applied'`,
    );
    this.#keyed = db.prepare(
      `SELECT ${FOLD_COLUMNS} FROM event_log WHERE gid = ? AND type = ? AND state = 'applied'
       ORDER BY hlc, eid LIMIT 1`,
    );
  }

  /** The eids of `eids` already held (one query per padded chunk). */
  held(eids: readonly string[]): Set<string> {
    const out = new Set<string>();
    for (let i = 0; i < eids.length; i += CHUNK) {
      const { list, values } = padded(eids.slice(i, i + CHUNK));
      for (const r of this.#cached(`SELECT eid FROM event_log WHERE eid IN (${list})`).all<{
        eid: string;
      }>(...values)) {
        out.add(r.eid);
      }
    }
    return out;
  }

  /**
   * Insert rows whose eids are not held (checked with `held`): multi-row statements of BATCH rows,
   * the remainder row by row, so one batch costs a few statement runs instead of one per event.
   */
  insertMany(rows: readonly NewLogRow[]): void {
    let i = 0;
    if (rows.length >= BATCH) {
      const many = this.#cached(
        `INSERT INTO event_log (${LOG_COLUMNS}) VALUES ${Array.from({ length: BATCH }, () => LOG_ROW).join(", ")}`,
      );
      for (; i + BATCH <= rows.length; i += BATCH) {
        many.run(...rows.slice(i, i + BATCH).flatMap(logValues));
      }
    }
    for (; i < rows.length; i++) this.#insert.run(...logValues(rows[i] as NewLogRow));
  }

  /** Record `[subject, eid]` refs (idempotent), in multi-row statements like `insertMany`. */
  addRefs(refs: readonly (readonly [string, string])[]): void {
    let i = 0;
    if (refs.length >= BATCH) {
      const many = this.#cached(
        `INSERT OR IGNORE INTO event_refs (subject, eid) VALUES ${Array.from({ length: BATCH }, () => "(?, ?)").join(", ")}`,
      );
      for (; i + BATCH <= refs.length; i += BATCH) many.run(...refs.slice(i, i + BATCH).flat());
    }
    for (; i < refs.length; i++) {
      const [subject, eid] = refs[i] as readonly [string, string];
      this.#insertRef.run(subject, eid);
    }
  }

  /** Insert unless the eid is already held; false when it was (the caller compares bodies). */
  insert(r: NewLogRow): boolean {
    return this.#insert.run(...logValues(r)).changes === 1;
  }

  get(eid: string): LogRow | undefined {
    return this.#byEid.get<LogRow>(eid);
  }

  setState(eid: string, state: EventState): void {
    this.#setState.run(state, eid);
  }

  addRef(subject: string, eid: string): void {
    this.#insertRef.run(subject, eid);
  }

  /** Non-parked events caused by any of `eids`. */
  causedBy(eids: readonly string[]): (FoldEvent & { state: EventState })[] {
    const out: (FoldEvent & { state: EventState })[] = [];
    for (let i = 0; i < eids.length; i += CHUNK) {
      const { list, values } = padded(eids.slice(i, i + CHUNK));
      out.push(
        ...this.#cached(
          `SELECT ${FOLD_COLUMNS}, state FROM event_log
             WHERE cause IN (${list}) AND state != 'parked'`,
        )
          .all<FoldRow & { state: EventState }>(...values)
          .map((r) => ({ ...toFoldEvent(r), state: r.state })),
      );
    }
    return out;
  }

  /** The first applied event of `type` with `gid`, in fold order (served by the gid index). */
  keyedEvent(gid: string, type: string): FoldEvent | undefined {
    const r = this.#keyed.get<FoldRow>(gid, type);
    return r === undefined ? undefined : toFoldEvent(r);
  }

  /** Gids of applied events whose refs include `subject`. */
  referrers(subject: string): string[] {
    return this.#referrers.all<{ gid: string }>(subject).map((r) => r.gid);
  }

  /** Non-parked events of `types` with `gid` in `gids`, with their state. */
  terminalsOf(
    types: readonly string[],
    gids: readonly string[],
  ): (FoldEvent & { state: EventState })[] {
    const out: (FoldEvent & { state: EventState })[] = [];
    for (let i = 0; i < gids.length; i += CHUNK) {
      const { list, values } = padded(gids.slice(i, i + CHUNK));
      out.push(
        ...this.#cached(
          `SELECT ${FOLD_COLUMNS}, state FROM event_log
             WHERE state != 'parked' AND type IN (${placeholders(types.length)}) AND gid IN (${list})`,
        )
          .all<FoldRow & { state: EventState }>(...types, ...values)
          .map((r) => ({ ...toFoldEvent(r), state: r.state })),
      );
    }
    return out;
  }

  #cached(sql: string): SqlStatement {
    let s = this.#shapes.get(sql);
    if (s === undefined) {
      s = this.#db.prepare(sql);
      this.#shapes.set(sql, s);
    }
    return s;
  }

  /** Every applied event of `types` in fold order. */
  appliedOfTypes(types: readonly string[]): FoldEvent[] {
    if (types.length === 0) return [];
    return this.#cached(
      `SELECT ${FOLD_COLUMNS} FROM event_log
         WHERE state = 'applied' AND type IN (${placeholders(types.length)}) ORDER BY hlc, eid`,
    )
      .all<FoldRow>(...types)
      .map(toFoldEvent);
  }

  /** Applied events of `types` addressed to one of `subjects` (gid or event_refs). Unordered. */
  appliedForSubjects(types: readonly string[], subjects: readonly string[]): FoldEvent[] {
    const out: FoldEvent[] = [];
    const typeList = placeholders(types.length);
    for (let i = 0; i < subjects.length; i += CHUNK) {
      const { list, values } = padded(subjects.slice(i, i + CHUNK));
      out.push(
        ...this.#cached(
          `SELECT ${FOLD_COLUMNS} FROM event_log
             WHERE state = 'applied' AND type IN (${typeList})
               AND (gid IN (${list}) OR eid IN (SELECT eid FROM event_refs WHERE subject IN (${list})))`,
        )
          .all<FoldRow>(...types, ...values, ...values)
          .map(toFoldEvent),
      );
    }
    return out;
  }

  /** Every non-parked event in fold order, without payloads (full suppression pass). */
  allHeldStates(): {
    eid: string;
    gid: string;
    type: string;
    cause: string | null;
    state: EventState;
  }[] {
    return this.#cached(
      "SELECT eid, gid, type, cause, state FROM event_log WHERE state != 'parked' ORDER BY hlc, eid",
    ).all();
  }

  /** Non-parked events of `types` in fold order (re-index of refs). */
  heldOfTypes(types: readonly string[]): FoldEvent[] {
    if (types.length === 0) return [];
    return this.#cached(
      `SELECT ${FOLD_COLUMNS} FROM event_log
         WHERE state != 'parked' AND type IN (${placeholders(types.length)}) ORDER BY hlc, eid`,
    )
      .all<FoldRow>(...types)
      .map(toFoldEvent);
  }
}

/** The original envelope of a stored event, as canonical JSON. */
export function storedBody(row: LogRow, vault: string): string {
  const data = JSON.parse(row.raw_data ?? row.data ?? "{}") as unknown;
  const extra = row.extra ? (JSON.parse(row.extra) as Record<string, unknown>) : {};
  return canonicalJson({
    ...extra,
    eid: row.eid,
    vault,
    device: row.device,
    hlc: row.hlc,
    at: row.at,
    type: row.type,
    v: row.v,
    gid: row.gid,
    data,
    ...(row.cause === null ? {} : { cause: row.cause }),
    ...(row.origin === null ? {} : { origin: row.origin }),
  });
}
