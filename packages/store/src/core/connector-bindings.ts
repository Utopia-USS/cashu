// Connector bindings (events.md 8.10, M1, M5): row key (resolve(account), connectorId); `set`
// creates or re-creates, `removed` is SOFT, the cursor is an LWW register (caused by the approval or
// auto-commit batch, so a suppressed approval rolls it back). Python deletes a removed binding, so
// the public row exists only while live; the registers survive in `fold_connector_bindings`.
// Leader-local fetch state (`last_run_at`, `last_status`, `last_ok_at`, `backoff_until`) never
// syncs (events.md 10) and is not part of this view.

import type { FoldContext, Materializer } from "../engine/types.js";
import { restoreFloats } from "../events/v1/primitives.js";
import type { TableDef } from "../sql/ddl.js";
import { sqlBool, sqlJson } from "../sql/values.js";
import { ACCOUNTS } from "./accounts.js";

const table: TableDef = {
  name: "connector_bindings",
  columns: [
    { name: "account_id", type: "INTEGER", notNull: true, ref: "accounts" },
    { name: "connector_id", type: "TEXT", notNull: true },
    { name: "params_json", type: "TEXT", notNull: true, json: true },
    { name: "auto_commit", type: "INTEGER", notNull: true },
    { name: "cursor", type: "TEXT" },
    { name: "created_at", type: "TEXT", notNull: true },
    { name: "updated_at", type: "TEXT", notNull: true },
  ],
  indexes: [{ columns: ["account_id", "connector_id"], unique: true }],
};

const fold: TableDef = {
  name: "fold_connector_bindings",
  primaryKey: ["partition"],
  internal: true,
  columns: [
    { name: "partition", type: "TEXT", notNull: true },
    { name: "anchor", type: "TEXT", notNull: true },
    { name: "account", type: "TEXT", notNull: true },
    { name: "connector_id", type: "TEXT", notNull: true },
    { name: "live", type: "INTEGER", notNull: true },
    { name: "params_json", type: "TEXT", notNull: true },
    { name: "auto_commit", type: "INTEGER", notNull: true },
    { name: "cursor", type: "TEXT" },
    { name: "created_at", type: "TEXT", notNull: true },
    { name: "updated_at", type: "TEXT", notNull: true },
  ],
};

interface State {
  partition: string;
  anchor: string;
  account: string;
  connector_id: string;
  live: number;
  params_json: string;
  auto_commit: number;
  cursor: string | null;
  created_at: string;
  updated_at: string;
}

function project(ctx: FoldContext, s: State): void {
  ctx.sql.write(
    fold.name,
    `INSERT OR REPLACE INTO fold_connector_bindings (partition, anchor, account, connector_id, live,
       params_json, auto_commit, cursor, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    s.partition,
    s.anchor,
    s.account,
    s.connector_id,
    s.live,
    s.params_json,
    s.auto_commit,
    s.cursor,
    s.created_at,
    s.updated_at,
  );
  if (s.live === 0) {
    ctx.sql.write(table.name, "DELETE FROM connector_bindings WHERE gid = ?", s.anchor);
    return;
  }
  ctx.sql.write(
    table.name,
    `INSERT OR REPLACE INTO connector_bindings (id, gid, account_id, connector_id, params_json, auto_commit,
       cursor, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ctx.id(s.anchor),
    s.anchor,
    ctx.id(s.account),
    s.connector_id,
    s.params_json,
    s.auto_commit,
    s.cursor,
    s.created_at,
    s.updated_at,
  );
}

export const connectorBindingsMaterializer: Materializer = {
  id: "core.connector_bindings",
  version: 1,
  tables: [table, fold],
  handles: ["connectorBinding.set", "connectorBinding.removed", "connectorBinding.cursorAdvanced"],
  identity: [ACCOUNTS],
  partitions(e, ctx) {
    if (e.type === "connectorBinding.set") {
      return [`${ctx.resolve(ACCOUNTS, String(e.data.account))}|${String(e.data.connectorId)}`];
    }
    return ctx.members.partitionsOf(e.gid);
  },
  clear(partitions, ctx) {
    for (const p of partitions) {
      const s = ctx.sql.get<{ anchor: string }>(
        "SELECT anchor FROM fold_connector_bindings WHERE partition = ?",
        p,
      );
      if (s) ctx.sql.write(table.name, "DELETE FROM connector_bindings WHERE gid = ?", s.anchor);
      ctx.sql.write(fold.name, "DELETE FROM fold_connector_bindings WHERE partition = ?", p);
    }
  },
  apply(e, ctx) {
    const d = e.data;
    const at = ctx.time(e, "updated_at");
    if (e.type === "connectorBinding.set") {
      const account = ctx.resolve(ACCOUNTS, String(d.account));
      const partition = `${account}|${String(d.connectorId)}`;
      ctx.members.add(partition, e.gid);
      const prev = ctx.sql.get<State>(
        "SELECT * FROM fold_connector_bindings WHERE partition = ?",
        partition,
      );
      project(ctx, {
        partition,
        anchor: prev?.anchor ?? e.gid,
        account,
        connector_id: String(d.connectorId),
        live: 1,
        params_json: sqlJson(restoreFloats(d.params ?? {}, d.paramsFloats)), // events.md 4.3
        auto_commit: sqlBool(d.autoCommit === true),
        cursor: prev?.cursor ?? null,
        created_at: prev?.created_at ?? ctx.time(e, "created_at"),
        updated_at: at,
      });
      return;
    }
    for (const partition of ctx.members.partitionsOf(e.gid)) {
      const prev = ctx.sql.get<State>(
        "SELECT * FROM fold_connector_bindings WHERE partition = ?",
        partition,
      );
      if (!prev) continue;
      if (e.type === "connectorBinding.removed") project(ctx, { ...prev, live: 0, updated_at: at });
      else project(ctx, { ...prev, cursor: (d.cursor as string | null) ?? null, updated_at: at });
    }
  },
};
