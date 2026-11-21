import { addDays, budget, D, type Decimal } from "@cashu/domain";
import { type NetWorthLine, netWorth, netWorthComponentSeries } from "@cashu/domain/core";
import { mcpAccounts } from "@cashu/store/core";
import { vaultNetWorthBook } from "@cashu/store/overview";
import * as L from "../privacy/labels.js";
import type { ToolContext } from "../registry.js";
import type { NativeToolStore } from "../runtime/types.js";

const sum = (values: Iterable<Decimal>): Decimal => {
  let total = D("0");
  for (const value of values) total = total.add(value);
  return total;
};
export function networthBreakdown(ctx: ToolContext<NativeToolStore>): L.LabelledTree {
  const book = vaultNetWorthBook(ctx.store.read, {
    today: ctx.today,
    prices: ctx.store.prices,
    ...(ctx.store.marketData === undefined ? {} : { marketData: ctx.store.marketData }),
  });
  const accounts = new Map(mcpAccounts(ctx.store.read).map((a) => [a.gid, a]));
  const groups = new Map<string, NetWorthLine[]>();
  for (const line of netWorth(book).lines) {
    const rows = groups.get(line.account.currency) ?? [];
    rows.push(line);
    groups.set(line.account.currency, rows);
  }
  return {
    currencies: [...groups.keys()].sort().map((currency) => {
      const rows = groups.get(currency) ?? [];
      const assets = sum(rows.flatMap((r) => (r.contribution?.gt(D("0")) ? [r.contribution] : [])));
      const liabilities = sum(
        rows.flatMap((r) => (r.contribution?.lt(D("0")) ? [r.contribution.neg()] : [])),
      );
      const buckets = new Map<string, Decimal>();
      for (const row of rows)
        if (row.contribution !== null) {
          const key = book.types.get(row.account.type).bucket;
          buckets.set(key, (buckets.get(key) ?? D("0")).add(row.contribution));
        }
      const series = netWorthComponentSeries(book, currency, "monthly");
      let change: Decimal | null = null;
      const last = series.at(-1);
      if (last) {
        const target = addDays(last[0], -365);
        const past = series.filter(([date]) => date <= target).at(-1);
        if (past) {
          const then = sum(past[1].values());
          if (!then.isZero()) change = sum(last[1].values()).sub(then).div(then.abs());
        }
      }
      return {
        currency: L.category(currency),
        base_note: L.fixedText("bucket and account shares are of gross assets in this currency"),
        buckets: [...buckets]
          .sort((a, b) => b[1].abs().compare(a[1].abs()))
          .map(([key, value]) => ({
            bucket: L.category(key),
            label: L.text(book.types.bucket(key).label),
            liability: L.flag(value.lt(D("0"))),
            share_of_assets: L.share(value.abs(), assets),
            value: L.amount(value),
          })),
        asset_liability_ratio: L.share(liabilities, assets),
        net_share_of_assets: L.share(assets.sub(liabilities), assets),
        change_12m_pct: L.pct(change),
        assets: L.amount(assets),
        liabilities: L.amount(liabilities),
        net: L.amount(assets.sub(liabilities)),
        accounts: rows.map((row) => {
          // a cash pool's part in another currency: its pool's label, named "<pool> (<currency>)"
          const account = budget.netWorthLineMeta(row.account.id, (gid) => accounts.get(gid));
          return {
            account: L.account(account ? (ctx.accountLabels.get(account.id) ?? null) : null),
            name: L.identifier(account?.name ?? null),
            type: L.category(row.account.type),
            bucket: L.category(book.types.get(row.account.type).bucket),
            share_of_assets:
              row.contribution === null ? L.pct(null) : L.share(row.contribution.abs(), assets),
            as_of: L.date(row.asOf),
            balance: L.amount(row.contribution),
          };
        }),
      };
    }),
    note: L.fixedText("currencies are never summed or converted"),
  };
}
