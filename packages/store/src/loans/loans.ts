// Loan terms (events.md 8.4, S24 2): one row per resolved loan account (gid = the anchor, the
// `loan.termsSet` that made the row visible). Terms are one LWW group (`loan.termsSet` carries them
// all), the payment matching fields another (`loan.paymentMatchingSet`); either may come first, the
// row is visible once terms exist (m7). `created_at` = the first applied termsSet, `updated_at` =
// the latest (balances recorded before it are superseded by the terms).
import { accountKeyed } from "../core/account-rows.js";
import type { FoldContext, Materializer } from "../engine/types.js";
import type { TableDef } from "../sql/ddl.js";

export const LOANS = "loans";

const table: TableDef = {
  name: LOANS,
  columns: [
    { name: "account_id", type: "INTEGER", notNull: true, ref: "accounts" },
    { name: "principal", type: "TEXT", notNull: true },
    { name: "annual_rate", type: "TEXT", notNull: true },
    { name: "term_months", type: "INTEGER", notNull: true },
    { name: "start_date", type: "TEXT", notNull: true },
    { name: "origination_date", type: "TEXT" },
    { name: "created_at", type: "TEXT", notNull: true },
    { name: "updated_at", type: "TEXT", notNull: true },
    { name: "payment_iban", type: "TEXT" },
    { name: "payment_text", type: "TEXT" },
  ],
  indexes: [{ columns: ["account_id"], unique: true }],
};

const fold: TableDef = {
  name: "fold_loans",
  primaryKey: ["account"],
  internal: true,
  columns: [
    { name: "account", type: "TEXT", notNull: true },
    { name: "anchor", type: "TEXT" },
    { name: "principal", type: "TEXT" },
    { name: "annual_rate", type: "TEXT" },
    { name: "term_months", type: "INTEGER" },
    { name: "start_date", type: "TEXT" },
    { name: "origination_date", type: "TEXT" },
    { name: "created_at", type: "TEXT" },
    { name: "updated_at", type: "TEXT" },
    { name: "payment_iban", type: "TEXT" },
    { name: "payment_text", type: "TEXT" },
  ],
};

interface State {
  account: string;
  anchor: string | null;
  principal: string | null;
  annual_rate: string | null;
  term_months: number | null;
  start_date: string | null;
  origination_date: string | null;
  created_at: string | null;
  updated_at: string | null;
  payment_iban: string | null;
  payment_text: string | null;
}

const COLUMNS = [
  "account",
  "anchor",
  "principal",
  "annual_rate",
  "term_months",
  "start_date",
  "origination_date",
  "created_at",
  "updated_at",
  "payment_iban",
  "payment_text",
] as const;

function load(ctx: FoldContext, account: string): State {
  return (
    ctx.sql.get<State>("SELECT * FROM fold_loans WHERE account = ?", account) ?? {
      account,
      anchor: null,
      principal: null,
      annual_rate: null,
      term_months: null,
      start_date: null,
      origination_date: null,
      created_at: null,
      updated_at: null,
      payment_iban: null,
      payment_text: null,
    }
  );
}

export const loansMaterializer: Materializer = {
  id: "loans.loans",
  version: 1,
  tables: [table, fold],
  handles: ["loan.termsSet", "loan.paymentMatchingSet"],
  ...accountKeyed("loans"),
  clear(accounts, ctx) {
    for (const a of accounts) {
      ctx.sql.write(table.name, "DELETE FROM loans WHERE account_id = ?", ctx.id(a));
      ctx.sql.write(fold.name, "DELETE FROM fold_loans WHERE account = ?", a);
    }
  },
  apply(e, ctx) {
    const s = load(ctx, ctx.resolve("accounts", String(e.data.account)));
    const d = e.data;
    if (e.type === "loan.termsSet") {
      const at = ctx.time(e, "updated_at");
      if (s.anchor === null) {
        s.anchor = e.gid;
        s.created_at = ctx.time(e, "created_at");
      }
      s.principal = String(d.principal);
      s.annual_rate = String(d.annualRate);
      s.term_months = Number(d.termMonths);
      s.start_date = String(d.startDate);
      s.origination_date = (d.originationDate as string | null) ?? null;
      s.updated_at = at;
    } else {
      s.payment_iban = (d.paymentIban as string | null) ?? null;
      s.payment_text = (d.paymentText as string | null) ?? null;
    }
    ctx.sql.write(
      fold.name,
      `INSERT OR REPLACE INTO fold_loans (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(() => "?").join(", ")})`,
      ...COLUMNS.map((c) => s[c]),
    );
    if (s.anchor === null) return; // no terms yet: no row (m7)
    ctx.sql.write(
      table.name,
      `INSERT INTO loans (id, gid, account_id, principal, annual_rate, term_months, start_date,
         origination_date, created_at, updated_at, payment_iban, payment_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (gid) DO UPDATE SET principal = excluded.principal,
         annual_rate = excluded.annual_rate, term_months = excluded.term_months,
         start_date = excluded.start_date, origination_date = excluded.origination_date,
         updated_at = excluded.updated_at, payment_iban = excluded.payment_iban,
         payment_text = excluded.payment_text`,
      ctx.id(s.anchor),
      s.anchor,
      ctx.id(s.account),
      s.principal,
      s.annual_rate,
      s.term_months,
      s.start_date,
      s.origination_date,
      s.created_at,
      s.updated_at,
      s.payment_iban,
      s.payment_text,
    );
  },
};
