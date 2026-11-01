// TRANSITIONAL(S49): the lab / dev host of the outbox bridge (S31a spec 6.1).
//
// The daemon's state of one vault, `<stateRoot>/v<ordinal>/bridge.db` (node:sqlite, WAL,
// synchronous FULL: an intent must be durable before its append): at most one open intent (a plan's
// batch for this vault, stored before the write so a crash re-writes the SAME batch, never a new
// mapping), the pipe cursor, the last shipped cushion and the genesis progress. Plaintext domain
// data: the state dir is private (0700), the same trust as the view database.

import type { bridge, SqlDriver } from "@cashu/store";

/** One vault's part of a plan, stored before the append (spec 6.1, 6.2). */
export interface Intent {
  /** The plan this batch belongs to (every vault of the plan stores it). */
  readonly planId: string;
  /** How many vaults the plan writes: the ack waits until each holds its batch durably. */
  readonly vaults: number;
  readonly through: number;
  readonly batch: bridge.VaultBatch;
}

export interface PipeCursor {
  readonly seq: number;
  readonly eid: string;
}

export interface GenesisProgress {
  readonly status: "writing" | "done";
  readonly chunksWritten: number;
  readonly wall: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS intent (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pipe_cursor (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL, eid TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cushion_shipped (id INTEGER PRIMARY KEY CHECK (id = 1), value_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS genesis (id INTEGER PRIMARY KEY CHECK (id = 1), status TEXT NOT NULL, chunks_written INTEGER NOT NULL, wall INTEGER NOT NULL);
`;
const FORMAT = "1";

export class VaultState {
  readonly #db: SqlDriver;

  constructor(db: SqlDriver) {
    this.#db = db;
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = FULL");
    db.exec(SCHEMA);
    const format = db
      .prepare("SELECT value FROM meta WHERE key = 'format'")
      .get<{ value: string }>();
    if (format === undefined) {
      db.prepare("INSERT INTO meta (key, value) VALUES ('format', ?)").run(FORMAT);
    } else if (format.value !== FORMAT) {
      throw new Error("unsupported daemon state format");
    }
  }

  intent(): Intent | undefined {
    const row = this.#db.prepare("SELECT body FROM intent WHERE id = 1").get<{ body: string }>();
    return row === undefined ? undefined : (JSON.parse(row.body) as Intent);
  }

  putIntent(intent: Intent): void {
    if (this.intent() !== undefined) throw new Error("an intent is already open for this vault");
    this.#db.prepare("INSERT INTO intent (id, body) VALUES (1, ?)").run(JSON.stringify(intent));
  }

  clearIntent(): void {
    this.#db.prepare("DELETE FROM intent WHERE id = 1").run();
  }

  pipeCursor(): PipeCursor {
    const row = this.#db
      .prepare("SELECT seq, eid FROM pipe_cursor WHERE id = 1")
      .get<{ seq: number; eid: string }>();
    return row === undefined ? { seq: 0, eid: "" } : { seq: Number(row.seq), eid: row.eid };
  }

  setPipeCursor(c: PipeCursor): void {
    this.#db
      .prepare(
        "INSERT INTO pipe_cursor (id, seq, eid) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET seq = excluded.seq, eid = excluded.eid",
      )
      .run(c.seq, c.eid);
  }

  cushionShipped(): string | undefined {
    return this.#db
      .prepare("SELECT value_json FROM cushion_shipped WHERE id = 1")
      .get<{ value_json: string }>()?.value_json;
  }

  setCushionShipped(valueJson: string): void {
    this.#db
      .prepare(
        "INSERT INTO cushion_shipped (id, value_json) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET value_json = excluded.value_json",
      )
      .run(valueJson);
  }

  genesis(): GenesisProgress | undefined {
    const row = this.#db
      .prepare("SELECT status, chunks_written, wall FROM genesis WHERE id = 1")
      .get<{ status: "writing" | "done"; chunks_written: number; wall: number }>();
    return row === undefined
      ? undefined
      : { status: row.status, chunksWritten: Number(row.chunks_written), wall: Number(row.wall) };
  }

  setGenesis(p: GenesisProgress): void {
    this.#db
      .prepare(
        "INSERT INTO genesis (id, status, chunks_written, wall) VALUES (1, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET status = excluded.status, chunks_written = excluded.chunks_written, wall = excluded.wall",
      )
      .run(p.status, p.chunksWritten, p.wall);
  }

  close(): void {
    this.#db.close();
  }
}
