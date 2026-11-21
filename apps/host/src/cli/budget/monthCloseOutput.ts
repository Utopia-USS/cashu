import { Decimal } from "@cashu/domain";
import type { MonthCloseView } from "@cashu/domain/budget";
import { printConsole } from "../core/console.js";
import type { CommandIo } from "../tree.js";
import { cashMoney } from "./cashOutput.js";
import { richTable } from "./richTable.js";

/** Python monthclose.as_dict converts Decimal amounts to float before this CLI formats them. */
function monthCloseMoney(amount: Decimal, currency: string): string {
  const value = Number(amount.toString());
  return cashMoney(Decimal.parse(Object.is(value, -0) ? "-0" : value.toString()), currency);
}

/** Render the CLI's Rich table and optional lines only when the supported subset is exact. */
export function monthCloseOutput(io: CommandIo, value: MonthCloseView): boolean {
  const amounts = [
    ...value.currencies.flatMap((c) => [
      c.income,
      c.spending,
      c.surplus,
      c.cushionTopUp,
      c.suggestedTransfer,
      ...c.spendingByCategory.map((r) => r.amount),
    ]),
    ...(value.cushion
      ? [
          value.cushion.balance,
          value.cushion.topUp,
          ...(value.cushion.target ? [value.cushion.target] : []),
        ]
      : []),
    ...(value.investing?.planned ? [value.investing.planned.amount] : []),
    ...(value.investing?.comparison
      ? [value.investing.comparison.suggestedTransfer, value.investing.comparison.difference]
      : []),
  ];
  if (amounts.some((amount) => !Number.isFinite(Number(amount.toString())))) return false;
  const rows = value.currencies.map((c) => [
    c.currency,
    monthCloseMoney(c.income, c.currency),
    monthCloseMoney(c.spending, c.currency),
    monthCloseMoney(c.surplus, c.currency),
    monthCloseMoney(c.cushionTopUp, c.currency),
    monthCloseMoney(c.suggestedTransfer, c.currency),
  ]);
  const table =
    rows.length === 0
      ? ""
      : richTable(
          io,
          [
            { header: "currency" },
            { header: "income", justify: "right" },
            { header: "spending", justify: "right" },
            { header: "surplus", justify: "right" },
            { header: "cushion", justify: "right" },
            { header: "suggested transfer", justify: "right" },
          ],
          rows,
        );
  if (table === null) return false;
  // Refuse controls before printing any line; printable labels are rendered literally.
  if (
    value.currencies.some((c) =>
      c.spendingByCategory
        .slice(0, 5)
        .some((r) =>
          Array.from(r.label).some(
            (ch) => (ch.codePointAt(0) ?? 0) < 32 || ch.codePointAt(0) === 127,
          ),
        ),
    )
  )
    return false;
  const head = `Month close ${value.month}${value.complete ? "" : " (month in progress)"}`;
  printConsole(io, head, {
    spans: [{ start: 0, end: `Month close ${value.month}`.length, style: { bold: true } }],
  });
  if (rows.length === 0)
    printConsole(io, "No income or spending in this month.", {
      spans: [{ start: 0, end: 36, style: { color: 33 } }],
    });
  if (table) io.stdout(table);
  for (const c of value.currencies) {
    const top = c.spendingByCategory
      .slice(0, 5)
      .map((r) => `${r.label} ${monthCloseMoney(r.amount, c.currency)}`)
      .join(", ");
    if (top) printConsole(io, `  ${c.currency} top spending: ${top}`);
  }
  if (value.cushion) {
    const c = value.cushion;
    const target =
      c.target === null ? "no spending history" : monthCloseMoney(c.target, c.currency);
    printConsole(
      io,
      `Cushion: ${monthCloseMoney(c.balance, c.currency)} of ${target}, top-up ${monthCloseMoney(c.topUp, c.currency)}`,
    );
  }
  if (value.investing) {
    const inv = value.investing;
    if (inv.planned === null) {
      printConsole(
        io,
        `Investments: no contributions plan in the strategy (${inv.strategyState ?? "None"}).`,
      );
    } else if (inv.comparison) {
      const planned = inv.planned;
      const cmp = inv.comparison;
      printConsole(
        io,
        `Planned contribution: ${monthCloseMoney(planned.amount, planned.currency)}; suggested transfer ${monthCloseMoney(cmp.suggestedTransfer, planned.currency)} (${cmp.status === "covered" ? "covers the plan" : "short of the plan"}, ${monthCloseMoney(cmp.difference, planned.currency)})`,
      );
    }
  }
  return true;
}
