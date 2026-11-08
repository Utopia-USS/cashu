/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { Decimal } from "../../decimal.js";
import { expectAll, loadVectors, Mismatches } from "../../testing/vectors.js";
import { TxnType } from "../domain/index.js";
import { deriveAmounts } from "./cash.js";
import { importFileExtension } from "./contract.js";
import {
  datePattern,
  decimalFormat,
  parseDatetimeWithPatterns,
  parseDateWithPatterns,
  parseDecimal,
  tryParseDatetime,
} from "./csvValues.js";
import { didYouMean } from "./didYouMean.js";
import { currencyOf } from "./testing/support.js";
import { canonicalOut } from "./testing/vectorOut.js";
import { decodeImportText, type ImportTextEncoding, parseEncoding } from "./text.js";

// Differential replay of the Python importing helpers (the retired Python vectors_inv_importing.py).
const pad = (n: number) => String(n).padStart(2, "0");
const timeText = (t: { hour: number; minute: number; second: number } | null) =>
  t === null ? null : `${pad(t.hour)}:${pad(t.minute)}:${pad(t.second)}`;
const bytesOf = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));

describe("decimal formats (csv_values.DecimalFormat.parse)", () => {
  const rows = loadVectors("inv-importing-decimals").rows as [string, string, string, unknown][];

  it("every parse and every refused separator pair equals Python", () => {
    const m = new Mismatches();
    for (const [decimalSep, thousandsSep, raw, want] of rows) {
      if (raw === "<construct>") {
        let threw = false;
        try {
          decimalFormat(decimalSep, thousandsSep);
        } catch {
          threw = true;
        }
        m.check(`construct ${decimalSep}|${thousandsSep}`, threw, typeof want === "object");
        continue;
      }
      const parsed = parseDecimal(decimalFormat(decimalSep, thousandsSep), raw);
      const got = parsed.ok
        ? parsed.value === null
          ? null
          : parsed.value.toString()
        : { error: "ValueError", message: parsed.message };
      m.check(`${JSON.stringify([decimalSep, thousandsSep, raw])}`, got, want);
    }
    expectAll(m);
  });
});

describe("date patterns (csv_values.DatePattern)", () => {
  const rows = loadVectors("inv-importing-dates").rows;

  it("every pattern match, refused pattern and pattern list equals Python", () => {
    const m = new Mismatches();
    for (const row of rows) {
      if (row[0] === "pattern") {
        const [, pattern, raw, want] = row as [string, string, string, unknown];
        const parsed = tryParseDatetime(datePattern(pattern), raw);
        m.check(
          JSON.stringify([pattern, raw]),
          parsed === null ? null : [parsed.date, timeText(parsed.time)],
          want,
        );
      } else if (row[0] === "bad_pattern") {
        const [, pattern] = row as [string, string];
        let threw = false;
        try {
          datePattern(pattern);
        } catch {
          threw = true;
        }
        m.check(`bad ${pattern}`, threw, true);
      } else {
        const [, patterns, raw, want] = row as [string, string[], string, unknown];
        const list = patterns.map(datePattern);
        const timed = parseDatetimeWithPatterns(raw, list);
        const only = parseDateWithPatterns(raw, list);
        const got = timed.ok
          ? [
              timed.value === null ? null : [timed.value.date, timeText(timed.value.time)],
              only.ok ? only.value : "error",
            ]
          : { error: "ValueError", message: timed.message };
        m.check(JSON.stringify([patterns, raw]), got, want);
      }
    }
    expectAll(m);
  });
});

describe("text decoding, encoding names and file extensions (text.py, contract.py)", () => {
  const rows = loadVectors("inv-importing-text").rows;

  it("every decode, name and extension equals Python", () => {
    const m = new Mismatches();
    for (const row of rows) {
      if (row[0] === "decode") {
        const [, encoding, lenient, b64, want] = row as [
          string,
          ImportTextEncoding,
          boolean,
          string,
          unknown,
        ];
        const decoded = decodeImportText(bytesOf(b64), encoding, { lenient });
        m.check(
          `${encoding} ${lenient} ${b64}`,
          decoded.ok ? ["ok", decoded.text] : ["err", decoded.reason, decoded.start],
          want,
        );
      } else if (row[0] === "encoding") {
        m.check(`encoding ${row[1]}`, parseEncoding(row[1] as string), row[2]);
      } else {
        m.check(
          `extension ${row[1]}`,
          importFileExtension({ name: row[1] as string, content: new Uint8Array() }),
          row[2],
        );
      }
    }
    expectAll(m);
  });
});

describe("amount derivation (cash.derive_amounts)", () => {
  const rows = loadVectors("inv-importing-cash").rows as unknown[][];
  const dec = (v: unknown) => (v === null ? null : Decimal.parse(v as string));

  it("every derivation and every failure message equals Python", () => {
    const m = new Mismatches();
    for (const row of rows) {
      const [type, currency, cashCurrency, gross, cash, quantity, price, fee, tax, fxRate, want] =
        row as [TxnType, string, string, ...unknown[]];
      const got = deriveAmounts({
        txnType: type,
        currency: currencyOf(currency),
        cashCurrency: currencyOf(cashCurrency),
        gross: dec(gross),
        cash: dec(cash),
        quantity: dec(quantity),
        price: dec(price),
        fee: dec(fee) ?? undefined,
        tax: dec(tax) ?? undefined,
        fxRate: dec(fxRate),
      });
      m.check(
        JSON.stringify(row.slice(0, 10)),
        got.ok
          ? ["ok", got.value.grossAmount.toString(), got.value.cashAmount.toString()]
          : ["err", got.message, got.kind],
        want,
      );
    }
    expectAll(m);
  });
});

describe("spelling hints (csv_mapping.did_you_mean)", () => {
  const rows = loadVectors("inv-importing-misc").rows as [string, string, string[], string][];

  it("every hint equals Python", () => {
    const m = new Mismatches();
    for (const [, text, candidates, want] of rows) {
      m.check(JSON.stringify([text, candidates]), didYouMean(text, candidates), want);
    }
    expectAll(m);
  });
});

it("the importing vectors cover every transaction type", () => {
  const types = new Set(
    (loadVectors("inv-importing-cash").rows as unknown[][]).map((row) => row[0] as string),
  );
  expect([...types].sort()).toEqual(Object.values(TxnType).sort());
});

describe("canonical documents (canonical.py, validation.py): the fast slice", () => {
  // The whole file (about 2,400 documents) is `canonical.vectors.exhaustive.test.ts`; its head holds the
  // documented examples and their first mutations, enough to catch a broken port on every change.
  const rows = loadVectors("inv-importing-canonical").rows.slice(0, 60) as [
    string,
    string,
    unknown,
  ][];

  it("the first documents equal Python (warnings, rows, detection, validation report)", () => {
    const m = new Mismatches();
    for (const [i, [b64, name, want]] of rows.entries()) {
      m.check(`#${i} ${name}`, canonicalOut(bytesOf(b64), name), want);
    }
    expectAll(m);
  });
});
