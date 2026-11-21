// Planned deposits (events.md 8.8; S25 spec 4.13): `plannedDeposit.created` CREATE; `cancelled` /
// `booked` are terminal FWW (the engine's suppression stage keeps only the lowest terminal per plan);
// GUARD O10: a booking whose transaction already books another plan earlier in the order is a no-op.
// One partition for the whole table (the GUARD reads other plans, D-S8).
//
// `booked_txn_id` = the view id of the transaction gid as named; readers resolve a non-anchor member
// through `inv_transaction_members` (D-S2). `updated_at` = domain time of the latest applied event.
import { ACCOUNTS } from "../core/accounts.js";
import type { Materializer } from "../engine/types.js";
import type { TableDef } from "../sql/ddl.js";
import { accountId, str } from "./fold-values.js";

const table: TableDef = {
  name: "inv_planned_deposits",
  columns: [
    { name: "account_id", type: "INTEGER", ref: "accounts" },
    { name: "amount", type: "TEXT", notNull: true },
    { name: "currency", type: "TEXT", notNull: true },
    { name: "planned_date", type: "TEXT", notNull: true },
    { name: "note", type: "TEXT" },
    { name: "status", type: "TEXT", notNull: true, default: "'planned'" },
    { name: "booked_txn_id", type: "INTEGER", ref: "inv_transactions" },
    { name: "booked_at", type: "TEXT" },
    { name: "created_at", type: "TEXT", notNull: true },
    { name: "updated_at", type: "TEXT", notNull: true },
  ],
  indexes: [{ columns: ["account_id"] }, { columns: ["booked_txn_id"] }],
};

/** The booking GUARD needs the transaction gid as named (a view id cannot tell two names apart). */
const bookings: TableDef = {
  name: "fold_planned_bookings",
  primaryKey: ["txn"],
  internal: true,
  columns: [
    { name: "txn", type: "TEXT", notNull: true },
    { name: "plan", type: "TEXT", notNull: true },
  ],
};

const PLANNED = "planned";

export const plannedMaterializer: Materializer = {
  id: "investments.planned",
  version: 1,
  tables: [table, bookings],
  handles: ["plannedDeposit.created", "plannedDeposit.cancelled", "plannedDeposit.booked"],
  identity: [ACCOUNTS],
  partitions: () => [PLANNED],
  clear(_partitions, ctx) {
    ctx.sql.write(table.name, "DELETE FROM inv_planned_deposits");
    ctx.sql.write(bookings.name, "DELETE FROM fold_planned_bookings");
  },
  apply(e, ctx) {
    const d = e.data;
    const g = e.gid;
    ctx.members.add(PLANNED, g);
    if (e.type === "plannedDeposit.created") {
      const at = ctx.time(e, "created_at");
      ctx.sql.write(
        table.name,
        `INSERT OR IGNORE INTO inv_planned_deposits (id, gid, account_id, amount, currency, planned_date, note,
           status, booked_txn_id, booked_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'planned', NULL, NULL, ?, ?)`,
        ctx.id(g),
        g,
        accountId(ctx, d.account),
        String(d.amount),
        String(d.currency),
        String(d.plannedDate),
        str(d.note),
        at,
        ctx.time(e, "updated_at"),
      );
      return;
    }
    const plan = ctx.sql.get<{ status: string }>(
      "SELECT status FROM inv_planned_deposits WHERE gid = ?",
      g,
    );
    if (plan === undefined || plan.status !== "planned") return; // parked, or already terminal
    if (e.type === "plannedDeposit.cancelled") {
      ctx.sql.write(
        table.name,
        "UPDATE inv_planned_deposits SET status = 'cancelled', updated_at = ? WHERE gid = ?",
        ctx.time(e, "updated_at"),
        g,
      );
      return;
    }
    const txn = String(d.txn);
    if (ctx.sql.get("SELECT 1 FROM fold_planned_bookings WHERE txn = ?", txn)) return; // O10
    ctx.sql.write(
      bookings.name,
      "INSERT INTO fold_planned_bookings (txn, plan) VALUES (?, ?)",
      txn,
      g,
    );
    ctx.sql.write(
      table.name,
      `UPDATE inv_planned_deposits SET status = 'booked', booked_txn_id = ?, booked_at = ?, updated_at = ?
       WHERE gid = ?`,
      ctx.id(txn),
      ctx.time(e, "booked_at"),
      ctx.time(e, "updated_at"),
      g,
    );
  },
};
