import { budget, core } from "@cashu/domain";
import type { market } from "@cashu/domain/investments";
import { budgetBook, budgetEngineContext } from "@cashu/store/budget/queries";
import { vaultNetWorthBook, vaultPaymentPatterns } from "@cashu/store/overview";
import type { Read } from "@cashu/store/query";
import type { HostStores } from "../../stores.js";
import { cashMoney } from "../budget/cashOutput.js";
import { richTable } from "../budget/richTable.js";
import { parse, positiveInt } from "../nativeInput.js";
import type { PortedCommand } from "../tree.js";
import { C } from "./strings.js";

interface Deps {
  readonly stores: Pick<HostStores, "vaults">;
  readonly now: () => number;
  readonly prices: market.PriceCache | null;
  readonly marketData?: (read: Read, vault: string) => market.CachedMarketData | null;
}

export function statsCommand(deps: Deps): PortedCommand {
  return {
    name: "stats",
    async run(args, io, root) {
      const parsed = parse(args, ["--months"]);
      const months =
        parsed && parsed.args.length === 0
          ? parsed.options.has("--months")
            ? positiveInt(parsed.options.get("--months"))
            : 12
          : null;
      if (months === null) {
        io.stderr(`${io.t.tr(C.statsUsage)}\n`);
        return 2;
      }
      const slug = root.profile || io.env.CASHU_PROFILE;
      const matches = [...deps.stores.vaults.values()].filter(
        (v) => v.store.read<{ slug: string }>("SELECT slug FROM profiles")[0]?.slug === slug,
      );
      const vault = matches.length === 1 ? matches[0] : undefined;
      if (!slug || !vault) {
        io.stderr(`${io.t.tr(C.statsProfile)}\n`);
        return 2;
      }
      const read = vault.store.read.bind(vault.store);
      const now = new Date(deps.now());
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const marketData = deps.marketData?.(read, vault.id) ?? undefined;
      const worth = core.netWorth(
        vaultNetWorthBook(read, { today, prices: deps.prices, marketData }),
      );
      const names = new Map(
        read<{ gid: string; bank: string; name: string }>(
          "SELECT gid, bank, name FROM accounts",
        ).map((a) => [a.gid, a]),
      );
      const netRows = worth.lines.map((line) => [
        `${names.get(line.account.id)?.bank ?? ""} · ${names.get(line.account.id)?.name ?? ""}`,
        line.account.type,
        line.account.currency,
        line.asOf ?? "-",
        line.contribution === null ? "-" : cashMoney(line.contribution, line.account.currency),
      ]);
      for (const [currency, total] of [...worth.totals].sort(([a], [b]) => a.localeCompare(b)))
        netRows.push([io.t.tr(C.total)(currency), "", "", "", cashMoney(total, currency)]);
      const book = budgetBook(read);
      const output: { title: string; columns: string[]; rows: string[][] }[] = [
        {
          title: io.t.tr(C.netWorthTitle),
          columns: [...io.t.tr(C.netWorthHeaders)],
          rows: netRows,
        },
      ];
      const currencies = [...new Set(book.transactions.map((t) => t.currency))].sort();
      for (const currency of currencies) {
        const rows = budget.monthlyCashflow(book, currency).slice(-months);
        if (rows.length)
          output.push({
            title: io.t.tr(C.cashflowTitle)(currency),
            columns: [...io.t.tr(C.cashflowHeaders)],
            rows: rows.map((r) => [
              r.label,
              cashMoney(r.income, currency),
              cashMoney(r.expense, currency),
              cashMoney(r.net, currency),
            ]),
          });
      }
      const registry = core.builtinRegistry();
      const recurring = budget.recurringPayments(
        book,
        budgetEngineContext(read, vaultPaymentPatterns(read)),
        budget.subscriptionExclusions(registry),
      );
      if (recurring.length)
        output.push({
          title: io.t.tr(C.recurringTitle),
          columns: [...io.t.tr(C.recurringHeaders)],
          rows: recurring
            .slice(0, 25)
            .map((r) => [
              r.counterparty,
              cashMoney(r.typicalAmount, r.currency),
              String(r.occurrences),
              `${r.medianGapDays}d`,
              r.lastDate,
            ]),
        });
      const ref = budget.referenceDate(book);
      if (ref)
        for (const currency of currencies) {
          const rows = budget.spendingByCategory(
            book,
            currency,
            { year: Number(ref.slice(0, 4)), month: Number(ref.slice(5, 7)) },
            io.t.language,
          );
          if (rows.length)
            output.push({
              title: io.t.tr(C.spendingTitle)(ref.slice(0, 7), currency),
              columns: [...io.t.tr(C.spendingHeaders)],
              rows: rows.slice(0, 15).map((r) => [r.label, cashMoney(r.amount, currency)]),
            });
        }
      // Build every table before writing any output, so a layout refusal is never a partial report.
      const rendered = output.map((part) =>
        richTable(
          io,
          part.columns.map((header) => ({ header })),
          part.rows,
          part.title,
        ),
      );
      if (rendered.some((item) => item === null)) {
        io.stderr(`${io.t.tr(C.accountRender)}\n`);
        return 2;
      }
      for (const item of rendered) io.stdout(item as string);
      return 0;
    },
  };
}
