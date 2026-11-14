// Random synthetic budget scripts for the recurring payments (M3): monthly charges of a few merchants
// over ten months on three accounts (two PLN, one EUR), with exact amounts, drifting amounts (one
// cluster), price rises (a new cluster) and one-off purchases at the same merchants; claims, merchant
// rules (a subscription or a not-subscription category, locked or not), a loan payment pattern, own
// IBAN counterparties, cash expenses (claimed and cleared), account removal and type changes (cash
// rows without a claim are judged by the engine). Used by `budget/derive/recurring.property.test.ts`
// and its exhaustive twin. Synthetic data only.
import fc from "fast-check";
import { nrb, type Step, scriptOf } from "./category-script.js";

const N1 = nrb("114000000000000000000001");
const FOREIGN = "DE89370400440532013000";

const pick = <T>(xs: readonly T[]) => fc.constantFrom(...xs);
const ACCOUNTS = ["A1", "A2", "A3"] as const;
const CURRENCY: Record<string, string> = { A1: "PLN", A2: "PLN", A3: "EUR" };
const MERCHANTS = ["NETFLIX DEMO", "SPOTIFY DEMO", "KINO PLUS", "BIEDRONKA 12"] as const;
const AMOUNTS = ["-43.00", "-49.00", "-46.20", "-60.00", "-23.99", "0.00", "15.00"] as const;
const EXPENSES = ["X1", "X2", "X3"] as const;

/** The date of month `m` (0 = 2026-01) on `day`. */
const dateOf = (m: number, day: number) =>
  `2026-${String(m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

const imported = (account: string, hash: string, data: Record<string, unknown>): Step => ({
  type: "txn.imported",
  gid: `T-${account}-${hash}-0`,
  data: {
    account,
    dedupHash: hash,
    occurrence: 0,
    currency: CURRENCY[account],
    counterpartyIban: null,
    reference: null,
    ...data,
  },
});

const OPENED: Record<string, Step> = {
  A1: { type: "account.opened", gid: "A1", data: { iban: N1, keys: [`iban:${N1}`] } },
  A2: { type: "account.opened", gid: "A2", data: { externalId: "k2", keys: ["ext:mbank:k2"] } },
  A3: {
    type: "account.opened",
    gid: "A3",
    data: { externalId: "k3", currency: "EUR", keys: ["ext:erste:k3"] },
  },
};

const step: fc.Arbitrary<Step> = fc.oneof(
  pick(ACCOUNTS).map((a) => OPENED[a] as Step),
  fc.constant({
    type: "account.opened",
    gid: "pool:PLN",
    data: {
      bank: "manual",
      name: "Gotówka",
      externalId: "cash:PLN",
      type: "cash",
      keys: ["ext:manual:cash:PLN"],
    },
  }),
  pick(ACCOUNTS).map((gid) => ({ type: "account.typeSet", gid, data: { type: "cash" } })),
  fc.record({ gid: pick(ACCOUNTS), removed: fc.boolean() }).map(({ gid, removed }) => ({
    type: removed ? "account.removed" : "account.restored",
    gid,
    data: {},
  })),
  // one row: a charge, a one-off purchase, an inflow, a transfer to an own account
  fc
    .record({
      account: pick(ACCOUNTS),
      m: fc.nat(9),
      day: pick([4, 6, 28]),
      merchant: pick([...MERCHANTS, null]),
      reference: pick([null, "RATA 1/120"]),
      iban: pick([null, null, null, N1, FOREIGN]),
      amount: pick(AMOUNTS),
    })
    .map(({ account, m, day, merchant, reference, iban, amount }) =>
      imported(account, `o${m}-${day}`, {
        bookingDate: dateOf(m, day),
        amount,
        counterpartyName: merchant,
        counterpartyIban: iban,
        reference,
      }),
    ),
  fc
    .record({
      account: pick(ACCOUNTS),
      m: fc.nat(9),
      category: pick(["subscriptions", "groceries", "housing", "entertainment"]),
      source: pick(["manual_txn", "llm_full"]),
    })
    .map(({ account, m, category, source }) => ({
      type: "txn.categorySet",
      gid: `T-${account}-s${m}-0`,
      data: { category, source },
    })),
  fc.record({ account: pick(ACCOUNTS), m: fc.nat(9) }).map(({ account, m }) => ({
    type: "txn.categoryCleared",
    gid: `T-${account}-s${m}-0`,
    data: {},
  })),
  fc
    .record({
      mk: pick(MERCHANTS),
      category: pick(["subscriptions", "housing", "entertainment", "groceries"]),
      locked: fc.boolean(),
    })
    .map(({ mk, category, locked }) => ({
      type: "categoryRule.set",
      gid: `R-${mk}`,
      data: { merchantKey: mk, category, source: "manual", locked },
    })),
  fc.constant({
    type: "loan.termsSet",
    gid: "LOAN-A2",
    data: {
      account: "A2",
      principal: "100.00",
      annualRate: "6.5",
      termMonths: 120,
      startDate: "2026-01-10",
      originationDate: null,
    },
  }),
  pick([null, "RATA"]).map((text) => ({
    type: "loan.paymentMatchingSet",
    gid: "LOAN-A2",
    data: { account: "A2", paymentIban: null, paymentText: text },
  })),
  fc
    .record({ x: pick(EXPENSES), m: fc.nat(9), title: pick(["NETFLIX DEMO", "Kawa"]) })
    .map(({ x, m, title }) => ({
      type: "txn.cashExpenseAdded",
      gid: `${x}-${m}`,
      data: {
        account: "pool:PLN",
        bookingDate: dateOf(m, 5),
        amount: "-43.00",
        title,
        category: "entertainment",
      },
    })),
  fc
    .record({ x: pick(EXPENSES), m: fc.nat(9) })
    .map(({ x, m }) => ({ type: "txn.deleted", gid: `${x}-${m}`, data: {} })),
);

/**
 * A monthly series of one merchant on an opened account (rows `s<m>`, claimable above): an exact amount, a
 * drift within one cluster (46.20 / 49.00) or a price rise (43.00 then 60.00), 3 to 8 months.
 */
const series: fc.Arbitrary<Step[]> = fc
  .record({
    account: pick(ACCOUNTS),
    from: fc.nat(4),
    n: fc.integer({ min: 3, max: 8 }),
    merchant: pick(MERCHANTS),
    shape: pick(["exact", "drift", "rise"]),
    day: pick([4, 5]),
  })
  .map(({ account, from, n, merchant, shape, day }) => [
    OPENED[account] as Step,
    ...Array.from({ length: Math.min(n, 10 - from) }, (_, i) => {
      const m = from + i;
      const amount =
        shape === "exact"
          ? "-43.00"
          : shape === "drift"
            ? i % 2 === 0
              ? "-46.20"
              : "-49.00"
            : i < 3
              ? "-43.00"
              : "-60.00";
      return imported(account, `s${m}`, {
        bookingDate: dateOf(m, day),
        amount,
        counterpartyName: merchant,
      });
    }),
  ]);

/** Random recurring scripts. */
export const recurringScript = scriptOf(step, series);
