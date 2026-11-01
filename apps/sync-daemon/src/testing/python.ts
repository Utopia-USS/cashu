// TRANSITIONAL(S49): test helpers of the sync daemon (S31a). A synthetic Python database with the
// sync tables (Alembic 0027-0029 shape) and outbox rows of alert edits, and a fake `cashu` CLI that
// acks into it. Synthetic values only.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PythonCli } from "../python/cli.js";

const DDL = `
CREATE TABLE alembic_version (version_num VARCHAR NOT NULL PRIMARY KEY);
CREATE TABLE profiles (id INTEGER PRIMARY KEY, slug VARCHAR NOT NULL, name VARCHAR NOT NULL);
CREATE TABLE sync_outbox (id INTEGER PRIMARY KEY, ts DATETIME NOT NULL, txn VARCHAR NOT NULL,
  profile_id INTEGER, table_name VARCHAR NOT NULL, op VARCHAR NOT NULL, local_id VARCHAR NOT NULL,
  gid VARCHAR, fields JSON NOT NULL, prev JSON, "key" JSON, origin VARCHAR NOT NULL,
  acked_at DATETIME, post JSON);
CREATE TABLE sync_ids (profile_id INTEGER NOT NULL, table_name VARCHAR NOT NULL,
  local_id VARCHAR NOT NULL, gid VARCHAR NOT NULL, source VARCHAR NOT NULL,
  PRIMARY KEY (profile_id, table_name, local_id));
CREATE TABLE sync_vaults (profile_id INTEGER PRIMARY KEY, vault_id VARCHAR NOT NULL UNIQUE,
  linked_at DATETIME NOT NULL);
INSERT INTO alembic_version VALUES ('0029_sync_outbox_post');
`;

const T0 = "2026-03-01 10:00:00.000000";

/** A synthetic alert row as Python's `post` holds it. */
function alertPost(id: number, o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    instrument_id: null,
    scope: "portfolio",
    kind: "drawdown_from_high",
    params: { pct: 10 },
    polarity: "negative",
    severity: "action",
    title: `syn alert ${id}`,
    note: null,
    source: "user",
    created_by: "app",
    status: "active",
    cooldown_days: null,
    expires_at: null,
    snoozed_until: null,
    last_triggered_at: null,
    last_checked_at: null,
    last_value: null,
    created_at: T0,
    updated_at: T0,
    deleted_at: null,
    ...o,
  };
}

export class SyntheticPython {
  readonly dir: string;
  readonly #db: DatabaseSync;
  #id = 0;

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), "cashu-daemon-py-"));
    this.#db = new DatabaseSync(join(this.dir, "cashu.db"));
    this.#db.exec(DDL);
  }

  profile(id: number, slug: string): void {
    this.#db.prepare("INSERT INTO profiles (id, slug, name) VALUES (?, ?, 'Syn')").run(id, slug);
  }

  link(profileId: number, vaultId: string): void {
    this.#db
      .prepare("INSERT INTO sync_vaults (profile_id, vault_id, linked_at) VALUES (?, ?, ?)")
      .run(profileId, vaultId, T0);
  }

  /**
   * An alert title edit of `alertId`, in its own transaction unless `txn` names a shared one (a bulk
   * change such as an import); returns the outbox id.
   */
  editAlert(
    profileId: number,
    alertId: number,
    gid: string,
    title: string,
    o: Record<string, unknown> = {},
    txn?: string,
  ): number {
    this.#id += 1;
    const fields = { title, ...o };
    this.#db
      .prepare(
        `INSERT INTO sync_outbox (id, ts, txn, profile_id, table_name, op, local_id, gid, fields, prev, "key", origin, post)
         VALUES (?, ?, ?, ?, 'alerts', 'update', ?, ?, ?, ?, NULL, 'local', ?)`,
      )
      .run(
        this.#id,
        "2026-03-02 11:00:00.000000",
        txn ?? `txn-${this.#id}`,
        profileId,
        String(alertId),
        gid,
        JSON.stringify(fields),
        JSON.stringify({
          title: "old",
          ...Object.fromEntries(Object.keys(o).map((k) => [k, null])),
        }),
        JSON.stringify(alertPost(alertId, fields)),
      );
    return this.#id;
  }

  pending(): number {
    return Number(
      (
        this.#db.prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE acked_at IS NULL").get() as {
          n: number;
        }
      ).n,
    );
  }

  /** A fake `cashu` CLI: ack marks rows acked and records the entries. */
  cli(): PythonCli & {
    readonly acks: { through: number; entries: readonly object[] }[];
    readonly applied: string[][];
  } {
    const acks: { through: number; entries: readonly object[] }[] = [];
    const applied: string[][] = [];
    const db = this.#db;
    return {
      acks,
      applied,
      ack(through, entries) {
        acks.push({ through, entries });
        db.prepare("UPDATE sync_outbox SET acked_at = ? WHERE id <= ? AND acked_at IS NULL").run(
          T0,
          through,
        );
      },
      apply(_slug, lines) {
        applied.push([...lines]);
        return { applied: lines.length };
      },
      seed() {
        return { inserted: 0 };
      },
    };
  }

  close(): void {
    this.#db.close();
  }
}
