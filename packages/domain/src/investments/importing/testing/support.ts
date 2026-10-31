/// <reference types="node" />
/**
 * Helpers shared by the importing tests. All data is synthetic (no real accounts, people or trades).
 * Port of `tests/investments/importing/imp_support.py` (the parts the contract scope needs).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeStrict } from "../../../codecs.js";
import type { IsoDate } from "../../../dates.js";
import { Decimal } from "../../../decimal.js";
import { Currencies, type Currency, type TxnType, toCurrency } from "../../domain/index.js";
import { type ImportFile, type ParsedTxn, parsedTxn, type TimeOfDay } from "../contract.js";

export const REPO_ROOT = fileURLToPath(new URL("../../../../../../", import.meta.url));

/** The fenced code blocks of `docs/import-format.md` in one language. */
export function specBlocks(language: string): string[] {
  const text = readFileSync(join(REPO_ROOT, "docs", "import-format.md"), "utf8");
  return [...text.matchAll(new RegExp(`\`\`\`${language}\\n(.*?)\`\`\``, "gs"))].map(
    (match) => match[1] as string,
  );
}

export const specText = (): string =>
  readFileSync(join(REPO_ROOT, "docs", "import-format.md"), "utf8");

export const d = (text: string): Decimal => Decimal.parse(text);
export const day = (text: string): IsoDate => text;
export const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Python `a == b` for decimals (by value; `5.50 == 5.5`). */
export const sameDecimal = (actual: Decimal | null | undefined, expected: string): boolean =>
  actual?.eq(d(expected)) === true;

/** An in-memory UTF-8 file. */
export const csvFile = (content: string, name = "export.csv"): ImportFile => ({
  name,
  content: enc(content),
});

export function parsedTxnOf(
  type: TxnType,
  options: {
    row?: number;
    tradeDate?: string;
    symbol?: string | null;
    currency?: Currency;
    quantity?: string | null;
    price?: string | null;
    gross?: string;
    cash?: string;
    tradeTime?: TimeOfDay | null;
    externalRef?: string | null;
  } = {},
): ParsedTxn {
  const currency = options.currency ?? Currencies.USD;
  const quantity = options.quantity === undefined ? "1" : options.quantity;
  return parsedTxn({
    rowIndex: options.row ?? 0,
    tradeDate: options.tradeDate ?? "2026-01-05",
    type,
    symbol: options.symbol === undefined ? "X" : options.symbol,
    currency,
    quantity: quantity === null ? null : d(quantity),
    price: options.price == null ? null : d(options.price),
    grossAmount: d(options.gross ?? "1"),
    cashAmount: d(options.cash ?? "-1"),
    cashCurrency: currency,
    tradeTime: options.tradeTime ?? null,
    externalRef: options.externalRef ?? null,
  });
}

const PL_EXPORT_LINES: readonly string[] = [
  "Data;Typ;Symbol;ISIN;Nazwa;Giełda;Ilość;Cena;Waluta;Prowizja;Kwota;Opis",
  "05.01.2026;Wpłata;;;;;;;PLN;;10 000,00;Wpłata własna",
  "07.01.2026;Kupno;ZGJ;PLZGJ0000010;Zażółć Gęślą Jaźń SA;GPW;10;62,50;PLN;3,13;-628,13;",
  "07.01.2026;Kupno;ZGJ;PLZGJ0000010;Zażółć Gęślą Jaźń SA;GPW;10;62,50;PLN;3,13;-628,13;",
  "12.01.2026;Kupno;ETFW;IE00TEST0001;Świat Akcji UCITS ETF;GPW;3;1 234,50;PLN;5,00;-3 708,50;",
  "20.01.2026;Sprzedaż;ZGJ;PLZGJ0000010;Zażółć Gęślą Jaźń SA;GPW;5;70,00;PLN;1,75;348,25;Częściowa sprzedaż",
  "25.01.2026;Dywidenda;ZGJ;PLZGJ0000010;Zażółć Gęślą Jaźń SA;GPW;;;PLN;;12,15;DYWIDENDA ŹRÓDŁO ŁÓDŹ ĄĆĘŃÓŚŻ",
  "31.01.2026;Opłata;;;;;;;PLN;;-9,99;Opłata za prowadzenie rachunku",
  "31.01.2026;Blokada środków;;;;;;;PLN;;-100,00;",
];

/** The synthetic export as UTF-8 with a byte order mark and CRLF line endings. */
export function plExportUtf8Bom(): Uint8Array {
  return Uint8Array.from([0xef, 0xbb, 0xbf, ...enc(`${PL_EXPORT_LINES.join("\r\n")}\r\n`)]);
}

/** Windows-1250 bytes of a text (the inverse of the decoder's table; text must be encodable). */
export function encodeCp1250(text: string): Uint8Array {
  const byChar = new Map<string, number>();
  for (let byte = 0; byte < 256; byte++) {
    const decoded = decodeStrict(Uint8Array.of(byte), "cp1250");
    if (decoded.ok) byChar.set(decoded.text, byte);
  }
  return Uint8Array.from(
    Array.from(text, (char) => {
      const byte = byChar.get(char);
      if (byte === undefined)
        throw new Error(`not encodable in windows-1250: U+${char.codePointAt(0)?.toString(16)}`);
      return byte;
    }),
  );
}

/** The same rows as Windows-1250 with LF line endings. */
export const plExportCp1250 = (): Uint8Array => encodeCp1250(`${PL_EXPORT_LINES.join("\n")}\n`);

/** A currency code from a vector (already upper-case ISO). */
export const currencyOf = (code: string): Currency => toCurrency(code);
