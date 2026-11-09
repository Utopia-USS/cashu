// The recurring-payments list over a stored book (the Subskrypcje tab and `recurring_payments`):
// foreign-currency subscriptions whose PLN amount drifts. Synthetic household only.

import { describe, expect, it } from "vitest";
import { builtinRegistry } from "../../core/index.js";
import { merchantKey } from "../ingestion/index.js";
import { activeRecurring, recurringPayments, subscriptionExclusions } from "./recurring.js";
import { Household } from "./testing/household.js";

const NOT_SUBSCRIPTION = subscriptionExclusions(builtinRegistry());
const CARD = "ZAKUP PRZY UZYCIU KARTY";

function household(): { h: Household; account: string } {
  const h = new Household("PLN");
  return { h, account: h.account({ name: "Konto Test", iban: null }) };
}

describe("recurringPayments over the book", () => {
  it("lists an FX-billed subscription with drifting PLN amounts as active", () => {
    const { h, account } = household();
    h.ingest(account, [
      { date: "2026-07-04", amount: "-103.00", cp: "ACME CLOUD", ref: CARD },
      { date: "2026-08-04", amount: "-116.00", cp: "ACME CLOUD", ref: CARD },
      { date: "2026-09-04", amount: "-116.00", cp: "ACME CLOUD", ref: CARD },
    ]);
    h.categorize();
    const book = h.book();
    const active = activeRecurring(
      recurringPayments(book, h.engineContext(), NOT_SUBSCRIPTION),
      book,
    );
    expect(active.map((c) => [c.counterparty, c.typicalAmount.toString(), c.currency])).toEqual([
      [merchantKey("ACME CLOUD", CARD, null), "116.00", "PLN"],
    ]);
  });

  it("lists two months of a merchant the owner filed as subscriptions", () => {
    const { h, account } = household();
    const key = merchantKey("STREAMLY", CARD, null);
    h.setRules([{ merchantKey: key, category: "subscriptions", source: "manual", locked: true }]);
    h.ingest(account, [
      { date: "2026-08-20", amount: "-29.40", cp: "STREAMLY", ref: CARD },
      { date: "2026-09-20", amount: "-31.10", cp: "STREAMLY", ref: CARD },
    ]);
    h.categorize();
    const items = recurringPayments(h.book(), h.engineContext(), NOT_SUBSCRIPTION);
    expect(items.map((c) => [c.counterparty, c.occurrences, c.medianGapDays])).toEqual([
      [key, 2, 31],
    ]);
  });
});
