// Typed queries of the debug screen (data-flow.md "Reading"), run by the store client in-process on
// the phone. Demo diagnostics only: product queries live in packages/store/<module>/queries.ts.
import { defineQuery } from "@cashu/store/query";

const TABLE = /^[a-z_][a-z0-9_]*$/;

/** Row counts of the given view tables (names come from the store's own table list). */
export const tableCounts = defineQuery({
  id: "mobile.debug.tableCounts",
  run(read, args: { readonly tables: readonly string[] }) {
    return args.tables
      .filter((t) => TABLE.test(t))
      .map((table) => ({
        table,
        rows: read<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)[0]?.n ?? 0,
      }));
  },
});

/** Month-end balances of the first demo account, oldest first. */
export const firstAccountBalances = defineQuery({
  id: "mobile.debug.firstAccountBalances",
  run(read) {
    return read<{ date: string; amount: string; currency: string }>(
      "SELECT date, amount, currency FROM balances WHERE account_id = (SELECT MIN(id) FROM accounts) ORDER BY date",
    );
  },
});

/** Outflows per PLN account as positive numbers (one currency only: shares, never a cross-currency sum). */
export const plnOutflowsByAccount = defineQuery({
  id: "mobile.debug.plnOutflowsByAccount",
  run(read) {
    const byName = new Map<string, number>();
    for (const r of read<{ name: string; amount: string }>(
      "SELECT a.name AS name, t.amount AS amount FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE t.currency = 'PLN' AND t.amount LIKE '-%' ORDER BY a.id",
    )) {
      byName.set(r.name, (byName.get(r.name) ?? 0) - Number(r.amount));
    }
    return [...byName].map(([name, outflow]) => ({ name, outflow: Math.round(outflow) }));
  },
});
