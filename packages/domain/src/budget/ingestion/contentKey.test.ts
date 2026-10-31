import { describe, expect, it } from "vitest";
import { D } from "../../decimal.js";
import { loadVectors, Mismatches } from "../../testing/vectors.js";
import { contentKeyV2, dedupHashV2, merchantKey, TX_DATE_SUFFIX_CLASSES } from "./contentKey.js";
import { type RawRow, rawFromRow } from "./testing/vectorRows.js";

const vectors = loadVectors("budget-hash");

describe("content hash vectors (parity/python/vectors_budget.py)", () => {
  it("contentKeyV2 and dedupHashV2 equal Python (v1 = sha1(account|key) checked by the generator)", () => {
    const m = new Mismatches();
    for (const row of vectors.rows.filter((r) => r[0] === "hash")) {
      const [, raw, key, v2] = row as [string, RawRow, string, string];
      const input = rawFromRow(raw);
      m.check(`key ${JSON.stringify(raw)}`, contentKeyV2(input), key);
      m.check(`v2 ${JSON.stringify(raw)}`, dedupHashV2(input), v2);
    }
    expect(m.items, m.report()).toEqual([]);
    expect(m.checked).toBeGreaterThan(6000);
  });

  it("gid.md section 8's budget vector", () => {
    const input = {
      bookingDate: "2026-01-15",
      amount: D("-12.50"),
      currency: "PLN",
      counterpartyName: "SKLEP TESTOWY",
      counterpartyIban: null,
      description: "ZAKUP TESTOWY",
      reference: null,
    };
    expect(contentKeyV2(input)).toBe("2026-01-15|-12.50|PLN|SKLEP TESTOWY|ZAKUP TESTOWY");
    expect(dedupHashV2(input)).toBe("451a4e645c5442bf030c14db4e9674a3592a8486");
  });

  it("the IGNORECASE classes of DATA TRANSAKCJI: are Python's (budget-matching-data)", () => {
    const [, data] = loadVectors("budget-matching-data").rows[0] as [
      string,
      { normalize: Record<string, unknown> },
    ];
    expect(data.normalize.TX_DATE_SUFFIX).toBe("DATA TRANSAKCJI:.*$");
    expect(TX_DATE_SUFFIX_CLASSES).toEqual(data.normalize.TX_DATE_SUFFIX_IGNORECASE);
  });

  it("merchant_key equals Python (IGNORECASE classes, \\r, \\x85, \\n at the end)", () => {
    const m = new Mismatches();
    for (const row of vectors.rows.filter((r) => r[0] === "merchant")) {
      const [, fields, want] = row as [string, (string | null)[], string];
      m.check(JSON.stringify(fields), merchantKey(...fields), want);
    }
    expect(m.items, m.report()).toEqual([]);
    expect(m.checked).toBeGreaterThan(600);
  });
});

// tests/test_parsing.py
describe("test_parsing.py", () => {
  // test_merchant_key_strips_date_and_location
  it("strips the transaction date suffix and the location padding", () => {
    expect(merchantKey("CARREFOUR EXPRESS K/KRAKOW              DATA TRANSAKCJI: 2022-03-22")).toBe(
      "CARREFOUR EXPRESS K/KRAKOW",
    );
    expect(merchantKey("  ", "ANNA NOWAK  UL.PRZYKLADOWA 40")).toBe("ANNA NOWAK");
    expect(merchantKey(null, null)).toBe("");
  });
});
