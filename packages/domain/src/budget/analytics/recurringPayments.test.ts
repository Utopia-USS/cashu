// The recurring-payments list over a stored book (the Subskrypcje tab and `recurring_payments`):
// foreign-currency subscriptions whose PLN amount drifts. Synthetic household only.

import { describe, expect, it } from "vitest";
import { builtinRegistry } from "../../core/index.js";
import { merchantKey } from "../ingestion/index.js";
import {
  activeRecurring,
  recurringPayments,
  recurringSeries,
  subscriptionExclusions,
} from "./recurring.js";
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

describe("recurringSeries: each candidate's own charges", () => {
  const series = (rows: Parameters<Household["ingest"]>[1]) => {
    const { h, account } = household();
    h.ingest(account, rows);
    h.categorize();
    const book = h.book();
    return recurringSeries(recurringPayments(book, h.engineContext(), NOT_SUBSCRIPTION), book);
  };
  const months = ["2026-05", "2026-06", "2026-07", "2026-08"];

  it("a one-off purchase at a subscription merchant is not a charge of the series", () => {
    const [s, ...rest] = series([
      ...months.map((m) => ({ date: `${m}-12`, amount: "-50.00", cp: "TELCO TEST", ref: CARD })),
      { date: "2026-08-20", amount: "-300.00", cp: "TELCO TEST", ref: CARD },
    ]);
    expect(rest).toHaveLength(0);
    expect(s?.key).toBe(`${merchantKey("TELCO TEST", CARD, null)}:PLN:50.00`);
    expect(s?.rows.map((t) => t.amount.toString())).toEqual([
      "-50.00",
      "-50.00",
      "-50.00",
      "-50.00",
    ]);
  });

  it("a new price on the expected date continues the series (a price rise)", () => {
    const [s] = series([
      ...months.map((m) => ({ date: `${m}-03`, amount: "-49.00", cp: "STREAM TEST", ref: CARD })),
      { date: "2026-09-03", amount: "-60.00", cp: "STREAM TEST", ref: CARD },
      // off the cadence: not the series
      { date: "2026-09-17", amount: "-60.00", cp: "STREAM TEST", ref: CARD },
    ]);
    expect(s?.rows.map((t) => [t.bookingDate, t.amount.toString()])).toEqual([
      ["2026-05-03", "-49.00"],
      ["2026-06-03", "-49.00"],
      ["2026-07-03", "-49.00"],
      ["2026-08-03", "-49.00"],
      ["2026-09-03", "-60.00"],
    ]);
  });

  it("two series of one merchant: one key each, each with its own charges", () => {
    const out = series([
      ...months.map((m) => ({ date: `${m}-05`, amount: "-9.99", cp: "CLOUD TEST", ref: CARD })),
      ...months.map((m) => ({ date: `${m}-20`, amount: "-49.99", cp: "CLOUD TEST", ref: CARD })),
    ]);
    expect(out.map((s) => [s.key.split(":").slice(1).join(":"), s.rows.length]).sort()).toEqual([
      ["PLN:49.99", 4],
      ["PLN:9.99", 4],
    ]);
  });
});
