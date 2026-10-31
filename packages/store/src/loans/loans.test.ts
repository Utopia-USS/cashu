// Loans store module: the row appears with terms (m7), and the payment patterns it contributes to
// the budget's categorization (Python `loans/patterns.py`). Synthetic data only.
import { describe, expect, it } from "vitest";
import type { ViewSql } from "../engine/types.js";
import type { Store } from "../materialize.js";
import { EventFactory, openTestStore } from "../testing/store.js";
import { loansModule } from "./index.js";

function readOnly(store: Store): ViewSql {
  const no = () => {
    throw new Error("read only");
  };
  return {
    write: no,
    insert: no,
    flush: () => {},
    get: (sql, ...p) => store.read(sql, ...p)[0] as never,
    all: (sql, ...p) => store.read(sql, ...p),
  };
}

describe("loans", () => {
  it("contribute one payment pattern per loan with matching, the text normalized", () => {
    const store = openTestStore();
    const f = new EventFactory();
    const det = store.deps.det;
    const acc = (key: string) => det("accounts", ["ext", "mbank", key]);
    const open = (key: string) =>
      f.make("account.opened", acc(key), {
        bank: "mbank",
        externalId: key,
        iban: null,
        currency: "PLN",
        type: "mortgage",
        name: "Hipoteka",
        keys: [`ext:mbank:${key}`],
      });
    const terms = (key: string) =>
      f.make("loan.termsSet", det("loans", [acc(key)]), {
        account: acc(key),
        principal: "300000.00",
        annualRate: "6.27",
        termMonths: 360,
        startDate: "2026-01-10",
        originationDate: null,
      });
    store.applyEnvelopes([open("l1"), open("l2"), open("l3"), terms("l1"), terms("l2")]);
    const r = store.applyEnvelopes([
      f.make("loan.paymentMatchingSet", det("loans", [acc("l1")]), {
        account: acc("l1"),
        paymentIban: null,
        paymentText: "Rata kredytu żółw",
      }),
      f.make("loan.paymentMatchingSet", det("loans", [acc("l3")]), {
        account: acc("l3"),
        paymentIban: "61109010140000071219812874",
        paymentText: null,
      }),
    ]);
    expect(r.touchedTables.has("loans")).toBe(true);
    // l3 has no terms: no row, no pattern (m7); l2 has no matching
    expect(loansModule.contributions?.paymentPatterns?.(readOnly(store))).toEqual([
      { category: "loans", counterpartyIban: null, text: "RATA KREDYTU ZOLW" },
    ]);
    expect(loansModule.contributions?.notSubscriptionCategories).toEqual(["loans"]);
  });
});
