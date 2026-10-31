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
import {
  AssetClass,
  asInstrumentId,
  Currencies,
  type Currency,
  type Instrument,
  type InstrumentAlias,
  type InstrumentId,
  instrument,
  type TxnType,
  toCurrency,
} from "../../domain/index.js";
import { type ImportFile, type ParsedTxn, parsedTxn, type TimeOfDay } from "../contract.js";
import { CsvField, type CsvMapping, csvMapping, csvMappingFromYaml } from "../csvMapping.js";

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

const PL_MAPPING_YAML = `# Synthetic Polish broker export mapping used by the import tests (no real data).
version: 1
name: "Synthetic PL broker"
broker_id: generic_csv
encoding: utf-8
delimiter: ";"
decimal_separator: ","
thousands_separator: " "
date_formats: ["dd.MM.yyyy"]
default_currency: PLN
amount_sign: signed
columns:
  trade_date: "Data"
  type: "Typ"
  symbol: "Symbol"
  isin: "ISIN"
  name: "Nazwa"
  exchange: "Giełda"
  quantity: "Ilość"
  price: "Cena"
  currency: "Waluta"
  fee: "Prowizja"
  cash_amount: "Kwota"
  note: "Opis"
types:
  "Kupno": buy
  "Sprzedaż": sell
  "Dywidenda": dividend
  "Wpłata": deposit
  "Opłata": fee
  "Blokada środków": ignore
`;

export const plMappingYaml = (encoding = "utf-8"): string =>
  PL_MAPPING_YAML.replace("encoding: utf-8", `encoding: ${encoding}`);

/** The fixture mapping (`pl_mapping`); a parse failure is a broken test fixture. */
export function plMapping(encoding = "utf-8"): CsvMapping {
  const parsed = csvMappingFromYaml(plMappingYaml(encoding));
  if (!parsed.ok) throw new Error(`fixture mapping is invalid: ${JSON.stringify(parsed.issues)}`);
  return parsed.mapping;
}

export const SIMPLE_HEADER = "ref,date,type,symbol,isin,exchange,qty,price,ccy,fee,cash";

/** A comma / dot mapping for in-memory CSVs (header `SIMPLE_HEADER`); dates accept a time. */
export function simpleMapping(
  options: { readonly brokerId?: string; readonly withRef?: boolean } = {},
): CsvMapping {
  const columns: [CsvField, string][] = [
    [CsvField.TRADE_DATE, "date"],
    [CsvField.TYPE, "type"],
    [CsvField.SYMBOL, "symbol"],
    [CsvField.ISIN, "isin"],
    [CsvField.EXCHANGE, "exchange"],
    [CsvField.QUANTITY, "qty"],
    [CsvField.PRICE, "price"],
    [CsvField.CURRENCY, "ccy"],
    [CsvField.FEE, "fee"],
    [CsvField.CASH_AMOUNT, "cash"],
  ];
  if (options.withRef ?? true) columns.unshift([CsvField.EXTERNAL_REF, "ref"]);
  return csvMapping({
    brokerId: options.brokerId ?? "generic_csv",
    defaultCurrency: Currencies.PLN,
    columns: new Map(columns),
  });
}

/** A deterministic id factory: `prefix-1`, `prefix-2`... */
export function counterIds(prefix: string): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `${prefix}-${next}`;
  };
}

/** `counterIds` for instrument ids. */
export function counterInstrumentIds(prefix: string): () => InstrumentId {
  const ids = counterIds(prefix);
  return () => asInstrumentId(ids());
}

/** `imp_support.instrument`: an Orlen-like stored instrument with overridable fields. */
export function instrumentOf(
  instrumentId: string,
  options: {
    readonly name?: string;
    readonly symbol?: string | null;
    readonly isin?: string | null;
    readonly mic?: string | null;
    readonly currency?: Currency;
    readonly assetClass?: AssetClass;
    readonly aliases?: readonly InstrumentAlias[];
  } = {},
): Instrument {
  return instrument({
    id: asInstrumentId(instrumentId),
    name: options.name ?? "Orlen",
    currency: options.currency ?? Currencies.PLN,
    assetClass: options.assetClass ?? AssetClass.EQUITY,
    symbol: options.symbol === undefined ? "PKN" : options.symbol,
    isin: options.isin ?? null,
    mic: options.mic === undefined ? "XWAR" : options.mic,
    aliases: options.aliases ?? [],
  });
}
