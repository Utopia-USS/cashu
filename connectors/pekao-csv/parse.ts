// Bank Pekao S.A. CSV export: a port of cashU's former built-in parser
// (modules/budget/ingestion/csv_import/pekao.py).
//
// Format: UTF-8, ';'-delimited, WITH a header row. Account numbers are apostrophe-guarded
// ('38124...). Amounts are signed Polish format. No running-balance column. Columns:
//
//   Data księgowania;Data waluty;Nadawca / Odbiorca;Adres nadawcy / odbiorcy;
//   Rachunek źródłowy;Rachunek docelowy;Tytułem;Kwota operacji;Waluta;
//   Numer referencyjny;Typ operacji;Kategoria
//
// Each row carries a source and a destination account. The statement's own account is the one
// common to (nearly) every row; the counterparty is the other side (source for inflows,
// destination for outflows). The Polish header substrings are matched against real files: never
// translate them.

import {
  BadFile,
  csvRows,
  type DocTransaction,
  parsePlAmount,
  parsePlDate,
  pyStrip,
  pyStripChars,
  readText,
  type Statement,
} from "./pycompat.ts";

const ENCODINGS = ["utf-8-sig", "utf-8", "cp1250", "iso-8859-2"];
/** The encodings the bank auto-detection reads every file with (scoring only). */
const DETECT_ENCODINGS = ["utf-8-sig", "cp1250", "iso-8859-2", "utf-8"];
const DEFAULT_CURRENCY = "PLN";
const SIGNATURE = ["rachunek źródłowy", "rachunek docelowy", "numer referencyjny", "typ operacji"];

const COLS: [string, string[]][] = [
  ["booking", ["data księgowania", "data ksiegowania"]],
  ["value", ["data waluty"]],
  ["counterparty", ["nadawca / odbiorca", "nadawca/odbiorca"]],
  ["source", ["rachunek źródłowy", "rachunek zrodlowy"]],
  ["dest", ["rachunek docelowy"]],
  ["title", ["tytułem", "tytulem"]],
  ["amount", ["kwota operacji", "kwota"]],
  ["currency", ["waluta"]],
  ["type", ["typ operacji"]],
];

/** Strip Pekao's apostrophe guard and spaces from an account-number cell. */
function acct(value: string | null): string | null {
  if (!value) return null;
  const s = pyStripChars(pyStrip(value), "'", true, false).replaceAll(" ", "");
  return s || null;
}

function findHeader(rows: string[][]): [number, Map<string, number>] | null {
  for (let i = 0; i < rows.length; i++) {
    const low = rows[i].map((c) => pyStrip(c).toLowerCase());
    const idx = new Map<string, number>();
    for (const [field, cands] of COLS) {
      const j = low.findIndex((cell) => cell && cands.some((c) => cell.includes(c)));
      if (j !== -1) idx.set(field, j);
    }
    if (["booking", "amount", "source", "dest"].every((f) => idx.has(f))) return [i, idx];
  }
  return null;
}

export function parse(bytes: Uint8Array): Statement {
  const text = readText(bytes, ENCODINGS);
  const rows = csvRows(text, ";").filter((r) => r.some((c) => pyStrip(c)));
  const header = findHeader(rows);
  if (header === null) throw new BadFile("the header row was not found");
  const [hidx, idx] = header;
  const data = rows.slice(hidx + 1);

  // Own account = the one appearing most across the source / destination columns (the first seen
  // wins a tie).
  const counter = new Map<string, number>();
  for (const row of data) {
    for (const f of ["source", "dest"]) {
      const j = idx.get(f)!;
      const a = j < row.length ? acct(row[j]) : null;
      if (a) counter.set(a, (counter.get(a) ?? 0) + 1);
    }
  }
  let own: string | null = null;
  let best = 0;
  for (const [a, n] of counter) {
    if (n > best) [own, best] = [a, n];
  }

  const transactions: DocTransaction[] = [];
  for (const row of data) {
    const cell = (field: string): string | null => {
      const j = idx.get(field);
      return j !== undefined && j < row.length ? pyStrip(row[j]) || null : null;
    };
    const booking = parsePlDate(cell("booking"));
    const amount = parsePlAmount(cell("amount"));
    if (booking === null || amount === null) continue;
    const src = acct(cell("source"));
    const dst = acct(cell("dest"));
    const cpIban = own ? (src === own ? dst : src) : (dst ?? src);
    const title = cell("title");
    transactions.push({
      booking_date: booking,
      value_date: parsePlDate(cell("value")),
      amount,
      currency: cell("currency") ?? DEFAULT_CURRENCY,
      counterparty_name: cell("counterparty"),
      counterparty_iban: cpIban,
      description: title,
      reference: title,
      balance_after: null,
    });
  }
  return {
    institution: "pekao",
    source: "pekao_csv",
    accountNumber: own,
    currency: DEFAULT_CURRENCY,
    transactions,
    balances: [],
  };
}

/** How strongly the file looks like a Pekao export: the signature hits of the former built-in
 * auto-detection, and only when the file really converts (a header and at least one row). */
export function detect(bytes: Uint8Array): number {
  const low = readText(bytes, DETECT_ENCODINGS).toLowerCase();
  const score = SIGNATURE.filter((sig) => low.includes(sig)).length;
  if (score === 0) return 0;
  try {
    if (!parse(bytes).transactions.length) return 0;
  } catch {
    return 0;
  }
  return Math.min(0.95, 0.5 + 0.1 * score);
}
