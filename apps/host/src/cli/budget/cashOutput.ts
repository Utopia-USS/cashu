import { type Decimal, formatFloat } from "@cashu/domain";
import type { CashCliSnapshot } from "@cashu/store/budget/queries";
import { printConsole } from "../core/console.js";
import type { CommandIo } from "../tree.js";
import { richTable } from "./richTable.js";

/** Python cliutil.fmt for legacy terminal output, per currency. */
export function cashMoney(amount: Decimal, currency: string): string {
  const text = amount.quantize(-2).format(",.2f").replaceAll(",", " ").replace(".", ",");
  return `${text} ${currency}`;
}

export function cashNoPool(io: CommandIo): void {
  const text =
    "No cash pool. Mark a withdrawal as 'Wyp\u0142ata got\u00f3wki' or add an expense: cashu cash-add \u2026";
  printConsole(io, text, { spans: [{ start: 0, end: 13, style: { color: 33 } }] });
}

export function cashAddLine(io: CommandIo, amount: number, title: string, category: string): void {
  const text = `Cash expense \u2212${formatFloat(amount, ".2f")}: ${title} (${category})`;
  printConsole(io, text, { spans: [{ start: 0, end: 12, style: { color: 32 } }] });
}

export function cashReadOutput(io: CommandIo, state: CashCliSnapshot): boolean {
  const rows = state.rows.map((r) => [
    r.bookingDate,
    r.reference || r.description || "\u2014",
    r.category || "\u2014",
    cashMoney(r.amount, r.currency),
  ]);
  const table = richTable(
    io,
    [{ header: "date" }, { header: "title" }, { header: "category" }, { header: "amount" }],
    rows,
    "Cash movements",
  );
  if (table === null) return false;
  const line = `Cash: ${cashMoney(state.balance, state.currency)}`;
  printConsole(io, line, { spans: [{ start: 0, end: 5, style: { bold: true } }] });
  io.stdout(table);
  return true;
}
