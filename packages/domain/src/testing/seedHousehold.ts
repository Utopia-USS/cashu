/**
 * Test-only: the whole `tests/conftest.py:seed_demo` household for the overview read models, the
 * budget half (`budget/analytics/testing/seedDemo.ts`) plus the net-worth half the Python seed adds
 * through the services: the mortgage's terms (`set_loan` after its 390 000 placeholder balance) and the
 * car's depreciation curve (`set_vehicle`). Synthetic data only.
 */

import { seedDemo } from "../budget/analytics/testing/seedDemo.js";
import type { IsoDate } from "../dates.js";
import { assets, type budget, type core, D, loans } from "../index.js";

export interface SeedHousehold {
  /** The budget rows and accounts (cashflow, recurring). */
  readonly household: ReturnType<typeof seedDemo>;
  readonly budgetBook: budget.BudgetBook;
  /** Net worth with every module's contributor, "now" = `today`. */
  netWorthBook(today: IsoDate): core.NetWorthBook;
}

export function seedHousehold(): SeedHousehold {
  const household = seedDemo();
  const mortgage = household.accountId("Kredyt hipoteczny Test");
  const car = household.accountId("Auto Test");
  // set_loan runs after add_manual_position recorded the placeholder: the terms supersede it.
  const loanBook: loans.LoansBook = {
    loans: [
      {
        id: "l1",
        accountId: mortgage,
        principal: D("400000"),
        annualRate: D("6.0"),
        termMonths: 300,
        startDate: "2025-01-05",
        originationDate: "2024-12-10",
        updatedAt: "2026-10-01 10:00:02.000000",
        paymentIban: null,
        paymentText: null,
      },
    ],
    balances: new Map([
      [
        mortgage,
        [{ date: "2026-06-01", amount: D("390000"), recordedAt: "2026-10-01 10:00:01.000000" }],
      ],
    ]),
  };
  const curves: assets.DepreciationTerms[] = [
    {
      accountId: car,
      purchasePrice: D("80000"),
      purchaseDate: "2025-05-01",
      annualRate: D("15"),
      floor: D("10000"),
    },
  ];
  return {
    household,
    budgetBook: household.book(),
    netWorthBook: (today) =>
      household.netWorthBook(today, {
        loans: loans.loansContributor(loanBook),
        assets: assets.assetsContributor(curves),
      }),
  };
}
