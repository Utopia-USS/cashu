// TRANSITIONAL(S49): the lab / dev host of the outbox bridge (S31a spec 5.3).
//
// The daemon's read-only view of Python's live database (`node:sqlite`, `readOnly`): every read is one
// short transaction, never held across loop steps (Python's WAL checkpoints must not starve). The
// daemon never writes Python's schema; writes go through the `cashu` CLI (`cli.ts`).
import { join } from "node:path";
import { openNodeSqlite } from "@cashu/node-host";
import type { SqlDriver } from "@cashu/store";
import * as bridge from "@cashu/store/bridge";
import * as genesis from "@cashu/store/genesis";
import { dataDirFiles } from "./files.js";

const PAGE = 1000;

const COLUMNS =
  'id, ts, txn, profile_id AS profileId, table_name AS "table", op, local_id AS localId, gid, fields, prev, "key" AS "key", post, origin';

const json = (v: unknown) => (typeof v === "string" ? (JSON.parse(v) as unknown) : v);

/** One outbox row as stored -> the bridge model (zod at the boundary; inbound rows are a violation). */
function toRow(raw: Record<string, unknown>): bridge.OutboxRow {
  return bridge.outboxRowSchema.parse({
    ...raw,
    id: Number(raw.id),
    profileId: raw.profileId === null ? null : Number(raw.profileId),
    localId: String(raw.localId),
    fields: json(raw.fields),
    prev: json(raw.prev),
    key: json(raw.key),
    post: json(raw.post),
  });
}

export interface LinkedVault {
  readonly profileId: number;
  readonly vaultId: string;
}

export class PythonReader {
  readonly #db: SqlDriver;
  readonly files: genesis.GenesisFiles;

  constructor(dataDir: string) {
    this.#db = openNodeSqlite(join(dataDir, "cashu.db"), { readOnly: true });
    this.files = dataDirFiles(dataDir);
  }

  /**
   * Unacked rows in id order, whole transactions only (spec 4.1): a page cut inside a transaction
   * reads on until it ends; one snapshot, so the last transaction read is complete.
   */
  pending(limit = PAGE): readonly bridge.OutboxRow[] {
    return this.#db.transaction(() => {
      const rows = this.#db
        .prepare(`SELECT ${COLUMNS} FROM sync_outbox WHERE acked_at IS NULL ORDER BY id LIMIT ?`)
        .all<Record<string, unknown>>(limit)
        .map(toRow);
      const last = rows.at(-1);
      if (rows.length === limit && last !== undefined) {
        const rest = this.#db
          .prepare(
            `SELECT ${COLUMNS} FROM sync_outbox WHERE acked_at IS NULL AND txn = ? AND id > ? ORDER BY id`,
          )
          .all<Record<string, unknown>>(last.txn, last.id)
          .map(toRow);
        rows.push(...rest);
      }
      return rows;
    });
  }

  /** Count of unacked rows (status, harness checks). */
  pendingCount(): number {
    return Number(
      this.#db
        .prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE acked_at IS NULL")
        .get<{ n: number }>()?.n ?? 0,
    );
  }

  /** Linked vaults by profile id (`sync_vaults`). */
  vaults(): readonly LinkedVault[] {
    return this.#db
      .prepare(
        "SELECT profile_id AS profileId, vault_id AS vaultId FROM sync_vaults ORDER BY profile_id",
      )
      .all<{ profileId: number; vaultId: string }>()
      .map((r) => ({ profileId: Number(r.profileId), vaultId: r.vaultId }));
  }

  /** Profiles (id, slug) in id order. The slug stays in memory: never printed or logged. */
  profiles(): readonly { readonly id: number; readonly slug: string }[] {
    return this.#db
      .prepare("SELECT id, slug FROM profiles ORDER BY id")
      .all<{ id: number; slug: string }>()
      .map((r) => ({ id: Number(r.id), slug: r.slug }));
  }

  /** Python `sync_ids` of one profile as a genesis `GidResolver` (read once per plan). */
  syncIds(profileId: number): bridge.VaultInput["syncIds"] {
    const map = new Map<string, string>();
    for (const r of this.#db
      .prepare("SELECT table_name, local_id, gid FROM sync_ids WHERE profile_id = ?")
      .all<{ table_name: string; local_id: string; gid: string }>(profileId)) {
      map.set(`${r.table_name}\u001f${r.local_id}`, r.gid);
    }
    return { gid: (table, localId) => map.get(`${table}\u001f${localId}`) };
  }

  /** Python `sync_clock` of one field of one row of a profile (the event that last wrote it). */
  fieldClock(profileId: number): bridge.VaultInput["fieldClock"] {
    return (table, localId, field) =>
      this.#db
        .prepare(
          "SELECT hlc, eid FROM sync_clock WHERE profile_id = ? AND table_name = ? AND local_id = ? AND field = ?",
        )
        .get<{ hlc: string; eid: string }>(profileId, table, localId, field);
  }

  /** The live rows of every profile (phase-1 inputs), one snapshot. */
  liveRows(): ReadonlyMap<number, bridge.CurrentRows> {
    return bridge.readLiveRows(this.#db, this.files);
  }

  /**
   * The genesis of every profile (spec 8.3), strict, read in one read transaction of the live
   * database: the first start requires a quiescent Python app.
   */
  genesis(keys: ReadonlyMap<string, genesis.VaultKeys>, now: number): genesis.GenesisResult {
    return this.#db.transaction(() =>
      genesis.genesis({ driver: this.#db, files: this.files }, keys, { strict: true, now }),
    );
  }

  /** A change marker: `PRAGMA data_version` and the last outbox id (the poll wake-up). */
  changeMarker(): string {
    const v = this.#db.prepare("PRAGMA data_version").get<{ data_version: number }>();
    const m = this.#db.prepare("SELECT MAX(id) AS m FROM sync_outbox").get<{ m: number | null }>();
    return `${v?.data_version ?? 0}:${m?.m ?? 0}`;
  }

  close(): void {
    this.#db.close();
  }
}
