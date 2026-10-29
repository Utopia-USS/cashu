// Parsing of the made-up Bank Testowy CSV statement (imported by connector.ts with a relative import:
// a module of the connector's own directory, the only kind besides node: built-ins the app allows).
// Error messages name the row and the column, never a value from the file.

export const HEADER = ["Data", "Opis", "Kontrahent", "Kwota", "Waluta", "Identyfikator"];
const SOURCE = "bank_testowy";

export class BadFile extends Error {}

export interface BudgetTransaction {
  booking_date: string;
  amount: string;
  currency: string;
  counterparty_name: string | null;
  description: string | null;
  transaction_id: string | null;
}

function cells(line: string): string[] {
  return line.split(";").map((cell) => cell.trim());
}

/** Lines of the file without a BOM, a trailing newline or blank lines. */
function lines(text: string): string[] {
  return text.replace(/^﻿/, "").split(/\r?\n/).filter((line) => line.trim() !== "");
}

/** 0..1: how sure we are that this text is a Bank Testowy statement. */
export function confidence(text: string): number {
  const first = lines(text.slice(0, 4096))[0];
  return first !== undefined && cells(first).join(";") === HEADER.join(";") ? 0.95 : 0;
}

function isoDate(raw: string, row: number, column: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new BadFile(`row ${row}: column ${column}: not a YYYY-MM-DD date`);
  }
  return raw;
}

/** "-1 234,5" -> "-1234.50": an exact decimal string, never through a float. */
function amount(raw: string, row: number, column: string): string {
  const text = raw.replace(/[\s ]/g, "").replace(",", ".");
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new BadFile(`row ${row}: column ${column}: not a number`);
  const [, sign, whole, fraction = ""] = match;
  return `${sign}${whole}.${fraction.padEnd(2, "0")}`;
}

export function convert(text: string, currency: string) {
  const [header, ...rows] = lines(text);
  if (header === undefined || cells(header).join(";") !== HEADER.join(";")) {
    throw new BadFile("the header row was not found");
  }
  const transactions: BudgetTransaction[] = rows.map((line, index) => {
    const row = index + 1;
    const values = cells(line);
    if (values.length !== HEADER.length) {
      throw new BadFile(`row ${row}: expected ${HEADER.length} columns`);
    }
    const cell = Object.fromEntries(HEADER.map((name, i) => [name, values[i]]));
    return {
      booking_date: isoDate(cell["Data"], row, "Data"),
      amount: amount(cell["Kwota"], row, "Kwota"),
      currency: (cell["Waluta"] || currency).toUpperCase(),
      counterparty_name: cell["Kontrahent"] || null,
      description: cell["Opis"] || null,
      transaction_id: cell["Identyfikator"] || null,
    };
  });
  transactions.sort((a, b) => a.booking_date.localeCompare(b.booking_date)); // stable
  return {
    format: "cashu-budget-import",
    format_version: 1,
    source: SOURCE,
    account: { currency },
    transactions,
  };
}
