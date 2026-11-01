/// <reference types="node" />
// The Polish cash literals (matching data written onto rows) are byte-identical to the live Python
// source: `parity/python/vectors_budget_transfers.py` reads them from cash.py's AST, this test rebuilds
// the same object from the TS constants and functions and compares it and its sha256.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { D } from "../decimal.js";
import { loadVectors } from "../testing/vectors.js";
import {
  CASH_ACCOUNT_TYPE,
  CASH_EXPENSE_PREFIX,
  CASH_LEG_PREFIX,
  CASH_WITHDRAWAL,
  cashLegFields,
  cashPoolExternalId,
  cashPoolName,
  MANUAL_CATEGORY_SOURCE,
} from "./cash.js";

/** `json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))`. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The literal parts of a template the way the generator lists an f-string's (`{}` = a value). */
function templateParts(render: (value: string) => string): string[] {
  return render("\u0000")
    .split("\u0000")
    .flatMap((part, i) => (i === 0 ? [part] : ["{}", part]))
    .filter((part) => part !== "");
}

const [, python, sha] = loadVectors("budget-cash-matching-data").rows[0] as [
  string,
  Record<string, unknown>,
  string,
];

describe("Polish cash literals: byte-identical to the live Python source", () => {
  it("pool, leg and expense literals and their sha256", () => {
    const leg = cashLegFields(
      {
        bookingDate: "2024-01-05",
        valueDate: null,
        amount: D("-1"),
        currency: "PLN",
        description: null,
        reference: null,
      },
      null,
    );
    const ts = {
      cash_account_type: CASH_ACCOUNT_TYPE,
      pool_external_id: templateParts(cashPoolExternalId),
      pool_name_base: cashPoolName("PLN", "PLN"),
      pool_name_other: templateParts((c) => cashPoolName(c, "PLN")),
      leg_withdrawal_category: CASH_WITHDRAWAL,
      leg_dedup_hash: templateParts((id) => `${CASH_LEG_PREFIX}${id}`),
      leg_counterparty_name: leg.counterpartyName,
      leg_description_fallback: leg.description,
      leg_reference: leg.reference,
      leg_category: leg.category,
      leg_category_source: leg.categorySource,
      expense_dedup_hash: templateParts((id) => `${CASH_EXPENSE_PREFIX}${id}`),
      expense_category_source: MANUAL_CATEGORY_SOURCE,
    };
    expect(ts).toEqual(python);
    expect(createHash("sha256").update(stableStringify(ts), "utf8").digest("hex")).toBe(sha);
    for (const s of Object.values(ts).flat()) expect(s.normalize("NFC")).toBe(s);
  });
});
