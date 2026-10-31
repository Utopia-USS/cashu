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

const CHUNK = 500;

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}

export class EventLog {
  readonly #db: SqlDriver;
  readonly #insert: SqlStatement;
  readonly #byEid: SqlStatement;
  readonly #setState: SqlStatement;
  readonly #insertRef: SqlStatement;
  readonly #referrers: SqlStatement;

  constructor(db: SqlDriver) {
    this.#db = db;
    this.#insert = db.prepare(
      `INSERT OR IGNORE INTO event_log (eid, hlc, at, type, v, gid, device, cause, origin, extra, state, reason, raw_data, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.#byEid = db.prepare("SELECT * FROM event_log WHERE eid = ?");
    this.#setState = db.prepare("UPDATE event_log SET state = ? WHERE eid = ?");
    this.#insertRef = db.prepare("INSERT OR IGNORE INTO event_refs (subject, eid) VALUES (?, ?)");
    this.#referrers = db.prepare(
      `SELECT e.gid FROM event_refs r JOIN event_log e ON e.eid = r.eid
       WHERE r.subject = ? AND e.state = 'applied'`,
    );
  }

  /** Insert unless the eid is already held; false when it was (the caller compares bodies). */
  insert(r: NewLogRow): boolean {
    return (
      this.#insert.run(
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
      ).changes === 1
    );
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
      const part = eids.slice(i, i + CHUNK);
      out.push(
        ...this.#db
          .prepare(
            `SELECT ${FOLD_COLUMNS}, state FROM event_log
             WHERE cause IN (${placeholders(part.length)}) AND state != 'parked'`,
          )
          .all<FoldRow & { state: EventState }>(...part)
          .map((r) => ({ ...toFoldEvent(r), state: r.state })),
      );
    }
    return out;
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
      const part = gids.slice(i, i + CHUNK);
      out.push(
        ...this.#db
          .prepare(
            `SELECT ${FOLD_COLUMNS}, state FROM event_log
             WHERE state != 'parked' AND type IN (${placeholders(types.length)}) AND gid IN (${placeholders(part.length)})`,
          )
          .all<FoldRow & { state: EventState }>(...types, ...part)
          .map((r) => ({ ...toFoldEvent(r), state: r.state })),
      );
    }
    return out;
  }

  /** Every applied event of `types` in fold order. */
  appliedOfTypes(types: readonly string[]): FoldEvent[] {
    if (types.length === 0) return [];
    return this.#db
      .prepare(
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
      const part = subjects.slice(i, i + CHUNK) as SqlValue[];
      const ph = placeholders(part.length);
      out.push(
        ...this.#db
          .prepare(
            `SELECT ${FOLD_COLUMNS} FROM event_log
             WHERE state = 'applied' AND type IN (${typeList})
               AND (gid IN (${ph}) OR eid IN (SELECT eid FROM event_refs WHERE subject IN (${ph})))`,
          )
          .all<FoldRow>(...types, ...part, ...part)
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
    return this.#db
      .prepare(
        "SELECT eid, gid, type, cause, state FROM event_log WHERE state != 'parked' ORDER BY hlc, eid",
      )
      .all();
  }

  /** Non-parked events of `types` in fold order (re-index of refs). */
  heldOfTypes(types: readonly string[]): FoldEvent[] {
    if (types.length === 0) return [];
    return this.#db
      .prepare(
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
