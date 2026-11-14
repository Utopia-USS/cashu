// Balance snapshots (events.md 8.1 / 8.2, S24 2, D-24.5): one row per row key (resolve(account),
// date, source); the row gid is the anchor (the first applied member, gid.md 4.8). `amount` and
// `created_at` (domain time of the winning record, Python `upsert_balance` bumps it) are LWW over the
// merged stream; `currency` is the first applied record's (Python keeps the first currency).
import type { FoldContext, FoldEvent, Materializer } from "../engine/types.js";
import type { TableDef } from "../sql/ddl.js";
import { ACCOUNTS } from "./accounts.js";

const table: TableDef = {
  name: "balances",
  columns: [
    { name: "account_id", type: "INTEGER", notNull: true, ref: "accounts" },
    { name: "date", type: "TEXT", notNull: true },
    { name: "amount", type: "TEXT", notNull: true },
    { name: "currency", type: "TEXT", notNull: true },
    { name: "source", type: "TEXT", notNull: true },
    { name: "created_at", type: "TEXT", notNull: true },
  ],
  indexes: [{ columns: ["account_id", "date", "source"], unique: true }, { columns: ["date"] }],
};

const SEP = "\u001f";

function rowKey(e: FoldEvent, ctx: FoldContext): string {
  const d = e.data;
  return [ctx.resolve(ACCOUNTS, String(d.account)), String(d.date), String(d.source)].join(SEP);
}

function splitKey(key: string): [string, string, string] {
  const [root = "", date = "", source = ""] = key.split(SEP);
  return [root, date, source];
}

export const balancesMaterializer: Materializer = {
  id: "core.balances",
  version: 1,
  tables: [table],
  handles: ["balance.recorded"],
  identity: [ACCOUNTS],
  partitions: (e, ctx) => [rowKey(e, ctx)],
  // The members of a row: the record of its key under every account of the resolved component (a
  // valid record's gid is DET over its own key, events.md 7.10).
  subjects(key, ctx) {
    const [root, date, source] = splitKey(key);
    return ctx
      .identityMembers(ACCOUNTS, root)
      .map((account) => ctx.det("balances", [account, date, source]));
  },
  clear(keys, ctx) {
    for (const key of keys) {
      const [root, date, source] = splitKey(key);
      ctx.sql.write(
        table.name,
        "DELETE FROM balances WHERE account_id = ? AND date = ? AND source = ?",
        ctx.id(root),
        date,
        source,
      );
    }
  },
  apply(e, ctx) {
    const d = e.data;
    const accountId = ctx.id(ctx.resolve(ACCOUNTS, String(d.account)));
    const createdAt = ctx.time(e, "created_at");
    const prev = ctx.sql.get<{ id: number }>(
      "SELECT id FROM balances WHERE account_id = ? AND date = ? AND source = ?",
      accountId,
      String(d.date),
      String(d.source),
    );
    if (prev !== undefined) {
      ctx.sql.write(
        table.name,
        "UPDATE balances SET amount = ?, created_at = ? WHERE id = ?",
        String(d.amount),
        createdAt,
        prev.id,
      );
      return;
    }
    ctx.sql.write(
      table.name,
      `INSERT INTO balances (id, gid, account_id, date, amount, currency, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ctx.id(e.gid),
      e.gid,
      accountId,
      String(d.date),
      String(d.amount),
      String(d.currency),
      String(d.source),
      createdAt,
    );
  },
};
