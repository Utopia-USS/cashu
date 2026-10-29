// mBank CSV export ("Lista operacji" / "Elektroniczne zestawienie operacji"): a port of cashU's
// former built-in parser (modules/budget/ingestion/csv_import/mbank.py on the generic base.py).
//
// Format: Windows-1250, ';'-delimited, a preamble that declares the account number
// (`#Numer rachunku`) and the currency (`#Waluta`: PLN, EUR, NOK, HUF eKonto walutowe), then:
//
//   #Data księgowania;#Data operacji;#Opis operacji;#Tytuł;#Nadawca/Odbiorca;#Numer konta;#Kwota;#Saldo po operacji
//
// The Polish header substrings below are matched against real files: never translate them.

import {
  BadFile,
  csvRows,
  type DocTransaction,
  findAccountNumber,
  parsePlAmount,
  parsePlDate,
  pySplitlines,
  pyStrip,
  pyStripChars,
  readText,
  type Statement,
} from "./pycompat.ts";

const ENCODINGS = ["cp1250", "utf-8-sig", "iso-8859-2", "utf-8"];
/** The encodings the bank auto-detection reads every file with (scoring only). */
const DETECT_ENCODINGS = ["utf-8-sig", "cp1250", "iso-8859-2", "utf-8"];
const DELIMITERS = [";", ","];
const DEFAULT_CURRENCY = "PLN";
const SIGNATURE = ["mbank s.a", "#data operacji", "elektroniczne zestawienie operacji"];

// Header-substring candidates per field (case-insensitive), in the order the fields are matched.
const COLMAP: [string, string[]][] = [
  ["booking_date", ["data księgowania", "data operacji", "data transakcji"]],
  ["value_date", ["data operacji", "data waluty"]],
  ["amount", ["kwota operacji", "kwota"]],
  ["counterparty", ["nadawca/odbiorca", "kontrahent", "nadawca", "odbiorca"]],
  ["description", ["opis operacji", "opis"]],
  ["title", ["tytuł", "tytul", "szczegóły", "szczegoly"]],
  // mBank labels the counterparty account "#Numer konta".
  ["counterparty_iban", ["numer konta", "numer rachunku kontrahenta", "rachunek kontrahenta"]],
  ["currency", ["waluta"]],
  ["balance", ["saldo po operacji", "saldo"]],
  ["debit", []],
  ["credit", []],
];

type Mapping = Map<string, number>;

function sniffDelimiter(lines: string[]): string {
  let best = DELIMITERS[0];
  let bestCount = -1;
  for (const d of DELIMITERS) {
    let count = 0;
    for (const line of lines.slice(0, 50)) count = Math.max(count, line.split(d).length - 1);
    if (count > bestCount) [best, bestCount] = [d, count];
  }
  return best;
}

function matchHeader(row: string[]): Mapping | null {
  const lowered = row.map((c) => pyStrip(c).toLowerCase());
  const mapping: Mapping = new Map();
  for (const [field, candidates] of COLMAP) {
    const idx = lowered.findIndex((cell) => cell && candidates.some((cand) => cell.includes(cand)));
    if (idx !== -1) mapping.set(field, idx);
  }
  const hasAmount = mapping.has("amount") || mapping.has("debit") || mapping.has("credit");
  return mapping.has("booking_date") && hasAmount ? mapping : null;
}

function extractMeta(text: string): [string | null, string] {
  const lines = pySplitlines(text);
  let account: string | null = null;
  let currency = DEFAULT_CURRENCY;
  lines.forEach((line, i) => {
    const s = pyStrip(line);
    if (s.startsWith("#Numer rachunku") && i + 1 < lines.length) {
      account = findAccountNumber(lines[i + 1]) ?? account;
    } else if (s.startsWith("#Waluta") && i + 1 < lines.length) {
      const cur = pyStrip(pyStripChars(pyStrip(lines[i + 1]), ";"));
      if (cur) currency = cur;
    }
  });
  return [account, currency];
}

function cell(row: string[], mapping: Mapping, field: string): string | null {
  const idx = mapping.get(field);
  if (idx === undefined || idx >= row.length) return null;
  return pyStrip(row[idx]) || null;
}

function amountOf(row: string[], mapping: Mapping): string | null {
  if (mapping.has("amount")) return parsePlAmount(cell(row, mapping, "amount"));
  const debit = parsePlAmount(cell(row, mapping, "debit"));
  const credit = parsePlAmount(cell(row, mapping, "credit"));
  const nonZero = (v: string | null) => v !== null && /[1-9]/.test(v);
  if (nonZero(credit)) return credit!.replace(/^-/, "");
  if (nonZero(debit)) return "-" + debit!.replace(/^-/, "");
  return null;
}

export function parse(bytes: Uint8Array): Statement {
  const text = readText(bytes, ENCODINGS);
  const delimiter = sniffDelimiter(pySplitlines(text));
  const reader = csvRows(text, delimiter);
  let headerIdx = -1;
  let mapping: Mapping | null = null;
  for (let i = 0; i < reader.length; i++) {
    mapping = matchHeader(reader[i]);
    if (mapping) {
      headerIdx = i;
      break;
    }
  }
  if (mapping === null) throw new BadFile("the transaction header row was not found");

  const [accountNumber, currency] = extractMeta(text);
  const transactions: DocTransaction[] = [];
  for (const row of reader.slice(headerIdx + 1)) {
    const booking = parsePlDate(cell(row, mapping, "booking_date"));
    const amount = amountOf(row, mapping);
    if (booking === null || amount === null) continue; // preamble / footer / blank rows
    const balance = mapping.has("balance") ? parsePlAmount(cell(row, mapping, "balance")) : null;
    transactions.push({
      booking_date: booking,
      value_date: parsePlDate(cell(row, mapping, "value_date")),
      amount,
      currency: cell(row, mapping, "currency") ?? currency,
      counterparty_name: cell(row, mapping, "counterparty"),
      counterparty_iban: cell(row, mapping, "counterparty_iban"),
      description: cell(row, mapping, "description") ?? cell(row, mapping, "title"),
      reference: cell(row, mapping, "title"),
      balance_after: balance,
    });
  }
  return {
    institution: "mbank",
    source: "mbank_csv",
    accountNumber,
    currency,
    transactions,
    balances: [],
  };
}

/** How strongly the file looks like an mBank export: the signature hits of the former built-in
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
