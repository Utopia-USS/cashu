// Cushion level of the month close (monthclose.cushion_level / cushion_state): translates
// tests/test_fxb_month_close.py test-for-test. F6 review V7: a cushion kept on the income account never
// counts the month's surplus twice (level = balance at the month start + the month's transfers); F7
// review R5: a transfer out that funded spending on another own account is added back up to that
// spending. Synthetic household (testing/seedDemo.ts), September 2026 on "mKonto Test": income 9000,
// spending 4235.75, transfers out 1300 (1000 to savings, 300 ATM); PLN surplus 4724.25.

import { describe, expect, it } from "vitest";
import { D, type Decimal } from "../../decimal.js";
import { pyMax, pyMin } from "./cushion.js";
import { monthClose } from "./monthClose.js";
import { type CurrencyCloseView, type MonthCloseView, monthCloseView } from "./monthCloseView.js";
import { type BudgetSettings, parseBudgetSettings } from "./settings.js";
import type { Household, Raw } from "./testing/household.js";
import { IBAN_EUR, IBAN_MAIN, seedDemo } from "./testing/seedDemo.js";

const s = (d: Decimal | null | undefined) => (d == null ? d : d.toString());

function put(h: Household, body: Record<string, unknown>, names: string[] = []): BudgetSettings {
  const parsed = parseBudgetSettings({ cushion: body });
  if (!parsed.ok) throw new Error(parsed.error);
  return { cushion: { ...parsed.settings.cushion, accountIds: names.map((n) => h.accountId(n)) } };
}

function sept(h: Household, settings: BudgetSettings): MonthCloseView {
  return monthCloseView(
    monthClose(h.book(), {
      year: 2026,
      month: 9,
      today: "2026-10-15",
      settings,
      env: h.env(),
      investmentsEnabled: false,
      planned: null,
    }),
  );
}

function pln(v: MonthCloseView): CurrencyCloseView {
  const c = v.currencies.find((x) => x.currency === "PLN");
  if (c === undefined) throw new Error("no PLN close");
  return c;
}

const MAIN_CUSHION = { enabled: true, target_amount: 5000 };

describe("cushion level (F6 V7, F7 R5)", () => {
  it("test_checking_cushion_counts_the_month_start_plus_transfers", () => {
    const h = seedDemo();
    h.balance(h.accountId("mKonto Test"), "2026-08-31", "5000.00");
    const v = sept(h, put(h, MAIN_CUSHION, ["mKonto Test"]));
    const c = v.cushion;
    // 5000 at the start, 1300 moved out (1000 to savings, 300 ATM of which 40 was spent from the cash
    // pool and is in the surplus): 5000 - 1300 + 40; the surplus is not part of it
    expect([s(c?.balance), s(c?.missing)]).toEqual(["3740.00", "1260.00"]);
    expect(s(pln(v).surplus)).toBe("4724.25");
    expect([s(pln(v).cushionTopUp), s(pln(v).suggestedTransfer)]).toEqual(["1260.00", "3464.25"]);
    // moving the suggested amount out leaves the account exactly at the target
    const after = D("5000")
      .add(D("9000"))
      .sub(D("4235.75"))
      .sub(D("1300"))
      .sub(pln(v).suggestedTransfer);
    expect(after.eq(c?.target ?? D("0"))).toBe(true);
  });

  it("test_a_full_checking_cushion_does_not_hold_back_the_surplus", () => {
    const h = seedDemo();
    h.balance(h.accountId("mKonto Test"), "2026-08-31", "6300.00");
    const p = pln(sept(h, put(h, MAIN_CUSHION, ["mKonto Test"])));
    expect([s(p.cushionTopUp), s(p.suggestedTransfer)]).toEqual(["0.00", "4724.25"]);
  });

  it("test_an_older_snapshot_is_rolled_forward_to_the_month_start", () => {
    // 2026-08-20 snapshot 5200; after it in August: -208 fuel, -55 unknown shop, -7 fee: 4930 at the start
    const h = seedDemo();
    h.balance(h.accountId("mKonto Test"), "2026-08-20", "5200.00");
    const c = sept(h, put(h, MAIN_CUSHION, ["mKonto Test"])).cushion;
    expect(s(c?.balance)).toBe("3670.00"); // 4930 - 1300 + 40
  });

  it("test_savings_cushion_is_unchanged", () => {
    // month-end 24000; with a balance before the month: 23000 + the 1000 moved in = the same level
    const h = seedDemo();
    const settings = put(h, { enabled: true, target_amount: 30000 });
    expect(s(sept(h, settings).cushion?.balance)).toBe("24000.00");
    h.balance(h.accountId("Erste Test"), "2026-08-31", "23000.00");
    const after = sept(h, settings);
    expect(s(after.cushion?.balance)).toBe("24000.00");
    expect(s(pln(after).cushionTopUp)).toBe(s(pyMin(D("6000.00"), pln(after).surplus)));
  });

  it("test_a_transfer_that_funds_spending_on_another_own_account_is_no_cushion_outflow", () => {
    // 2000 moved from the checking cushion to an own spending account and spent there by card in the
    // same month; the spending is in the surplus, so the transfer is added back
    const ibanSpending = "99999000000000000000000004";
    const h = seedDemo();
    const main = h.accountId("mKonto Test");
    const spend = h.account({ name: "Konto Wydatki Test", iban: ibanSpending });
    const raw = (day: number, amount: string, ref: string, iban: string | null = null): Raw => ({
      date: `2026-09-${String(day).padStart(2, "0")}`,
      amount,
      ref,
      iban,
    });
    h.ingest(main, [raw(12, "-2000.00", "ZASILENIE KONTA", ibanSpending)]);
    h.ingest(spend, [
      raw(12, "2000.00", "ZASILENIE KONTA", IBAN_MAIN),
      raw(18, "-2000.00", "SKLEP RTV TEST"),
    ]);
    h.categorize();
    h.balance(main, "2026-08-31", "5000.00");
    const v = sept(h, put(h, MAIN_CUSHION, ["mKonto Test"]));
    expect(s(pln(v).surplus)).toBe("2724.25");
    expect([s(v.cushion?.balance), s(pln(v).cushionTopUp)]).toEqual(["3740.00", "1260.00"]);
    expect(s(pln(v).suggestedTransfer)).toBe("1464.25");
    // the account holds 6464.25 at the month end: the suggested amount leaves it at the target
    const after = D("5000")
      .add(D("9000"))
      .sub(D("4235.75"))
      .sub(D("1300"))
      .sub(D("2000"))
      .sub(pln(v).suggestedTransfer);
    expect(after.eq(v.cushion?.target ?? D("0"))).toBe(true);
  });

  it("test_a_transfer_to_an_own_account_in_another_currency_stays_an_outflow", () => {
    // 2000 PLN from the checking cushion to the own EUR account, 465 EUR spent there: the EUR spending
    // is in the EUR close, not in the PLN surplus, so nothing is added back
    const h = seedDemo();
    const main = h.accountId("mKonto Test");
    const eur = h.accountId("eKonto EUR Test");
    h.balance(main, "2026-08-31", "5000.00");
    h.ingest(main, [
      { date: "2026-09-10", amount: "-2000.00", ref: "WYMIANA WALUT", iban: IBAN_EUR },
    ]);
    h.ingest(eur, [
      {
        date: "2026-09-10",
        amount: "465.00",
        ref: "WYMIANA WALUT",
        iban: IBAN_MAIN,
        currency: "EUR",
      },
      { date: "2026-09-15", amount: "-465.00", ref: "HOTEL TEST", currency: "EUR" },
    ]);
    h.categorize();
    const v = sept(h, put(h, MAIN_CUSHION, ["mKonto Test"]));
    expect([s(v.cushion?.balance), s(v.cushion?.missing)]).toEqual(["1740.00", "3260.00"]);
    expect([s(pln(v).surplus), s(pln(v).cushionTopUp)]).toEqual(["4724.25", "3260.00"]);
    expect(s(pln(v).suggestedTransfer)).toBe("1464.25");
    const after = D("5000")
      .add(D("9000"))
      .sub(D("4235.75"))
      .sub(D("1300"))
      .sub(D("2000"))
      .sub(pln(v).suggestedTransfer);
    expect(after.eq(v.cushion?.target ?? D("0"))).toBe(true);
  });
});

describe("Python min / max on Decimals", () => {
  it("return the first argument on a tie, keeping its exponent", () => {
    expect(pyMax(D("0.00"), D("0")).toString()).toBe("0.00");
    expect(pyMin(D("2000.0"), D("2000.00")).toString()).toBe("2000.0");
    expect(pyMax(D("0.00"), D("-1")).toString()).toBe("0.00");
    expect(pyMin(D("5"), D("4.99")).toString()).toBe("4.99");
  });
});
