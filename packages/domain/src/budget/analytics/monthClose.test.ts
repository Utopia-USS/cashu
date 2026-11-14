// Month close (monthclose.py, investing_link.py): translates tests/test_month_close.py test-for-test on
// the synthetic household of conftest.seed_demo (testing/seedDemo.ts), September 2026: PLN income 9000,
// spending 4275.75, surplus 4724.25; EUR spending 9.99. The API's float view is `monthCloseView` with
// Decimals (the API layer writes floats). Not here: loading the strategy YAML (S14, the domain takes
// the loaded state), the settings file on disk and its 0600 mode (store / desktop), the CLI (S39b).

import { describe, expect, it } from "vitest";
import type { IsoDate } from "../../dates.js";
import { D, type Decimal } from "../../decimal.js";
import type { BudgetBook } from "./book.js";
import type { CushionEnv } from "./cushion.js";
import { type PlannedContribution, plannedContribution } from "./investingLink.js";
import { type MonthClose, monthClose, parseMonth } from "./monthClose.js";
import { type CurrencyCloseView, type MonthCloseView, monthCloseView } from "./monthCloseView.js";
import { type BudgetSettings, defaultBudgetSettings, parseBudgetSettings } from "./settings.js";
import { Household } from "./testing/household.js";
import { seedDemo } from "./testing/seedDemo.js";

const s = (d: Decimal | null | undefined) => (d == null ? d : d.toString());
const OCT_15: IsoDate = "2026-10-15";

interface CloseArgs {
  readonly settings?: BudgetSettings;
  readonly year?: number;
  readonly month?: number;
  readonly today?: IsoDate;
  readonly investments?: PlannedContribution | null;
}

function close(h: Household, args: CloseArgs = {}): MonthClose {
  const book: BudgetBook = h.book();
  const env: CushionEnv = h.env();
  return monthClose(book, {
    year: args.year ?? 2026,
    month: args.month ?? 9,
    today: args.today ?? OCT_15,
    settings: args.settings ?? defaultBudgetSettings(),
    env,
    investmentsEnabled: args.investments !== undefined,
    planned: args.investments ?? null,
  });
}

const view = (h: Household, args: CloseArgs = {}) => monthCloseView(close(h, args));

function pln(v: MonthCloseView): CurrencyCloseView {
  const c = v.currencies.find((x) => x.currency === "PLN");
  if (c === undefined) throw new Error("no PLN close");
  return c;
}

/** `_put`: the API body through `settings.parse`, account ids mapped to the household's. */
function cushion(
  h: Household,
  body: Record<string, unknown>,
  names: string[] = [],
): BudgetSettings {
  const parsed = parseBudgetSettings({ cushion: body });
  if (!parsed.ok) throw new Error(parsed.error);
  return {
    cushion: { ...parsed.settings.cushion, accountIds: names.map((n) => h.accountId(n)) },
  };
}

/** `STRATEGY_PLAN` (`version: 1`, `contributions: monthly_amount, day_of_month: 10`), loaded. */
function plan(currency: string, amount: string, state: "valid" | "partial" = "valid") {
  return plannedContribution(state, {
    baseCurrency: currency,
    contributions: { monthlyAmount: D(amount), dayOfMonth: 10 },
  });
}

describe("numbers and the default month", () => {
  it("test_month_close_without_investments", () => {
    const v = view(seedDemo());
    expect([v.month, v.baseCurrency, v.complete]).toEqual(["2026-09", "PLN", true]);
    expect(view(seedDemo(), { today: "2026-09-30" }).complete).toBe(false);
    expect(v.investing).toBeNull();
    expect(v.cushion).toBeNull();
    const p = pln(v);
    expect([s(p.income), s(p.spending), s(p.surplus)]).toEqual(["9000.00", "4275.75", "4724.25"]);
    expect([s(p.suggestedTransfer), s(p.cushionTopUp)]).toEqual(["4724.25", "0.00"]);
    const top = new Map(p.spendingByCategory.map((r) => [r.category, s(r.amount)]));
    expect(top.get("loans")).toBe("3000.00");
    expect(top.get("groceries")).toBe("227.75");
    expect(top.has("transfer") || top.has("cash_withdrawal")).toBe(false);
    expect(p.incomeByCategory.map((r) => r.category)).toEqual(["income_salary"]);
  });

  it("test_month_close_rejects_a_bad_month", () => {
    for (const bad of ["2026-13", "2026/09", "26-09", "september"]) {
      expect(parseMonth(bad), bad).toEqual({ ok: false, error: "month must be YYYY-MM" });
    }
    expect(parseMonth("2026-09")).toEqual({ ok: true, year: 2026, month: 9 });
  });

  it("parse_month takes what Python's int() takes, and no year before 1900", () => {
    expect(parseMonth("2026-9")).toEqual({ ok: true, year: 2026, month: 9 });
    expect(parseMonth("2026- 9 ")).toEqual({ ok: true, year: 2026, month: 9 });
    expect(parseMonth("2026-0_9")).toEqual({ ok: true, year: 2026, month: 9 });
    expect(parseMonth("２０２６-１２")).toEqual({ ok: true, year: 2026, month: 12 });
    for (const bad of [
      "1899-01",
      " 2026-09",
      "2026-_9",
      "2026-9_",
      "2026-",
      "2026-09-01",
      "2026-+-9",
    ]) {
      expect(parseMonth(bad).ok, bad).toBe(false);
    }
  });

  it("test_default_month_is_the_newest_closed_month_with_data", () => {
    const h = seedDemo();
    const at = (today: IsoDate) =>
      monthClose(h.book(), {
        today,
        settings: defaultBudgetSettings(),
        env: h.env(),
        investmentsEnabled: false,
        planned: null,
      });
    const oct5 = at("2026-10-05");
    expect([oct5.label, oct5.complete]).toEqual(["2026-09", true]);
    expect(at("2026-09-20").label).toBe("2026-08"); // the running month is not closed yet
    expect(at("2027-03-01").label).toBe("2026-09"); // the newest month with data
    expect(close(h, { today: "2026-09-20" }).complete).toBe(false);
  });

  it("uncategorized rows close as income_other / other", () => {
    const h = new Household("PLN");
    const acc = h.account({ name: "Konto Test", iban: "99114000000000000000000009" });
    h.ingest(acc, [
      { date: "2026-09-02", amount: "100.00", ref: "WPLYW TEST" },
      { date: "2026-09-03", amount: "-30.00", ref: "WYDATEK TEST" },
    ]);
    const [c] = view(h).currencies;
    expect(c?.incomeByCategory.map((r) => [r.category, s(r.amount)])).toEqual([
      ["income_other", "100.00"],
    ]);
    expect(c?.spendingByCategory.map((r) => [r.category, s(r.amount)])).toEqual([
      ["other", "30.00"],
    ]);
    expect(c?.transactions).toBe(2);
  });

  it("test_empty_profile_month_close", () => {
    const v = view(new Household("PLN"));
    expect(v.currencies).toEqual([]);
    expect(v.firstMonth).toBeNull();
    expect(v.investing).toBeNull();
    expect(v.cushion).toBeNull();
  });
});

describe("investments plan (read only, only when the module is on)", () => {
  it("test_planned_contribution_is_compared_when_investments_is_on", () => {
    expect(view(seedDemo()).investing).toBeNull(); // the module is off: the strategy is ignored
    const inv = view(seedDemo(), { investments: plan("PLN", "2000") }).investing;
    expect(inv?.enabled).toBe(true);
    expect(inv?.strategyState).toBe("valid");
    expect(inv?.planned).toEqual({ amount: D("2000"), currency: "PLN", dayOfMonth: 10 });
    const c = inv?.comparison;
    expect([c?.currency, c?.hasData, s(c?.surplus), s(c?.suggestedTransfer)]).toEqual([
      "PLN",
      true,
      "4724.25",
      "4724.25",
    ]);
    expect([s(c?.difference), c?.status]).toEqual(["2724.25", "covered"]);
  });

  it("test_investments_on_without_a_usable_plan", () => {
    const missing = view(seedDemo(), { investments: plannedContribution("missing", null) });
    expect(missing.investing).toEqual({
      enabled: true,
      strategyState: "missing",
      planned: null,
      comparison: null,
    });
    // valid, but no contributions section
    const noPlan = plannedContribution("valid", { baseCurrency: "PLN", contributions: null });
    const inv = view(seedDemo(), { investments: noPlan }).investing;
    expect([inv?.strategyState, inv?.planned]).toEqual(["valid", null]);
    const invalid = view(seedDemo(), {
      investments: plannedContribution("invalid", null),
    }).investing;
    expect([invalid?.strategyState, invalid?.planned]).toEqual(["invalid", null]);
  });

  it("test_a_partial_strategy_still_gives_its_plan", () => {
    const inv = view(seedDemo(), { investments: plan("PLN", "1500", "partial") }).investing;
    expect(inv?.strategyState).toBe("partial");
    expect(s(inv?.planned?.amount)).toBe("1500");
  });

  it("test_plan_in_another_currency_uses_that_currency", () => {
    const eur = view(seedDemo(), { investments: plan("EUR", "100") }).investing?.comparison;
    expect([eur?.currency, s(eur?.surplus), s(eur?.suggestedTransfer), eur?.status]).toEqual([
      "EUR",
      "-9.99",
      "0.00",
      "short",
    ]);
    expect(s(eur?.difference)).toBe("-100.00");
    const usd = view(seedDemo(), { investments: plan("USD", "100") }).investing?.comparison;
    expect([usd?.hasData, usd?.status]).toEqual([false, "short"]);
  });
});

describe("cushion rule", () => {
  it("test_settings_default_off_and_stored_privately (the parse / defaults half)", () => {
    expect(defaultBudgetSettings()).toEqual({
      cushion: {
        enabled: false,
        currency: null,
        targetAmount: null,
        targetMonths: null,
        accountIds: [],
        monthlyMax: null,
      },
    });
    const parsed = parseBudgetSettings({ cushion: { enabled: true, target_amount: 30000 } });
    expect(parsed.ok && s(parsed.settings.cushion.targetAmount)).toBe("30000.00");
  });

  it("test_cushion_top_up_comes_before_the_transfer", () => {
    // savings "Erste Test" holds 24000 at the end of September
    const h = seedDemo();
    const v = view(h, { settings: cushion(h, { enabled: true, target_amount: 30000 }) });
    const c = v.cushion;
    expect([c?.currency, s(c?.target), c?.targetSource]).toEqual(["PLN", "30000.00", "amount"]);
    expect([s(c?.balance), s(c?.missing), s(c?.topUp), c?.reached]).toEqual([
      "24000.00",
      "6000.00",
      "4724.25",
      false,
    ]);
    expect(c?.accounts.map((a) => a.name)).toEqual(["Erste Test"]);
    expect([s(pln(v).cushionTopUp), s(pln(v).suggestedTransfer)]).toEqual(["4724.25", "0.00"]);

    const capped = cushion(h, { enabled: true, target_amount: 30000, monthly_max: 1000 });
    const p = pln(view(h, { settings: capped }));
    expect([s(p.cushionTopUp), s(p.suggestedTransfer)]).toEqual(["1000.00", "3724.25"]);

    const reached = view(h, { settings: cushion(h, { enabled: true, target_amount: 20000 }) });
    expect(reached.cushion?.reached).toBe(true);
    expect(s(reached.cushion?.topUp)).toBe("0.00");
    expect(s(pln(reached).suggestedTransfer)).toBe("4724.25");
  });

  it("test_cushion_and_plan_together", () => {
    const h = seedDemo();
    const settings = cushion(h, { enabled: true, target_amount: 30000, monthly_max: 3000 });
    const c = view(h, { settings, investments: plan("PLN", "2000") }).investing?.comparison;
    expect(s(c?.suggestedTransfer)).toBe("1724.25");
    expect([c?.status, s(c?.difference)]).toEqual(["short", "-275.75"]);
  });

  it("test_cushion_target_in_months_of_spending", () => {
    const h = seedDemo();
    // June-September expenses: 4523.75, 4527.75, 4586.75, 4275.75 -> mean 4478.50
    const c = view(h, { settings: cushion(h, { enabled: true, target_months: 6 }) }).cushion;
    expect([c?.targetSource, c?.targetMonths]).toEqual(["months", 6]);
    expect(s(c?.averageSpending)).toBe("4478.50");
    expect(s(c?.target)).toBe("26871.00");
    expect(s(c?.missing)).toBe("2871.00"); // max(0, target - 24000)
  });

  it("test_cushion_balance_is_taken_at_the_month_end", () => {
    const h = seedDemo();
    const settings = cushion(h, { enabled: true, target_amount: 30000 });
    const aug = view(h, { settings, month: 8 });
    expect(s(aug.cushion?.balance)).toBe("0.00"); // the savings balance is first known on 2026-09-30
    expect(s(aug.cushion?.topUp)).toBe(s(pln(aug).surplus));
  });

  it("test_cushion_with_chosen_accounts_and_currency", () => {
    const h = seedDemo();
    const main = h.accountId("mKonto Test");
    // the income account as the cushion (F6 review V7): no balance before September, so its level is
    // the month-end 5000 minus September's income and spending booked on it (9000 - 4235.75), plus
    // the 40 of the ATM withdrawal spent from the cash pool (F7 review R5)
    const c = view(h, {
      settings: cushion(h, { enabled: true, target_amount: 6000 }, ["mKonto Test"]),
    }).cushion;
    expect(s(c?.balance)).toBe("275.75");
    expect(c?.accounts.map((a) => a.id)).toEqual([main]);

    const settings = cushion(h, { enabled: true, currency: "eur", target_amount: 1000 }, [
      "eKonto EUR Test",
    ]);
    const v = view(h, { settings });
    // month-end 460.04 without September's 9.99 of spending on it (that is the EUR surplus, V7)
    expect([v.cushion?.currency, s(v.cushion?.balance)]).toEqual(["EUR", "470.03"]);
    expect(s(v.cushion?.topUp)).toBe("0.00"); // EUR surplus is negative: nothing to set aside
    expect(s(pln(v).cushionTopUp)).toBe("0.00");
  });
});
