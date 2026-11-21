/**
 * The declarative specs of the four built-in modules (`modules/<id>/module.py` `MODULE`).
 *
 * Python keeps each spec inside its module. Here core builds the registries net worth depends on and
 * core may not import a module, so the manifests live in this file until the registry composition
 * moves above core; then each moves to `src/<module>/module.ts` and this file only lists them. Names
 * and labels are UI data (Polish + English); the loans installment phrases are Polish matching data,
 * verbatim from `modules/loans/patterns.py` (`INSTALLMENT_PHRASES`, byte-hash checked in
 * `loans/matchingData.test.ts`); their public home is `loans/patterns.ts`.
 */

import { accountType, netWorthBucket } from "./accountTypes.js";
import { institution } from "./institutions.js";
import { type CoreRegistry, createCoreRegistry, type ModuleSpec, moduleSpec } from "./modules.js";

export const LOANS_CATEGORY = "loans";

/** `modules/loans/patterns.py:INSTALLMENT_PHRASES` (matched against normalized outflow text). */
export const INSTALLMENT_PHRASES: readonly (readonly [string, string])[] = Object.freeze([
  ["RATA KREDYTU", LOANS_CATEGORY],
  ["RATY KREDYTU", LOANS_CATEGORY],
  ["SPLATA KREDYTU", LOANS_CATEGORY],
  ["SPLATA RATY", LOANS_CATEGORY],
  ["RATA POZYCZKI", LOANS_CATEGORY],
  ["SPLATA POZYCZKI", LOANS_CATEGORY],
  ["RATA LEASING", LOANS_CATEGORY],
  ["KREDYT HIPOTECZNY", LOANS_CATEGORY],
] as const);

/** Account type id owned by the investments module (`investments/store/transactions.py`). */
export const BROKERAGE = "brokerage";

export const BUDGET_MODULE: ModuleSpec = moduleSpec({
  id: "budget",
  name: "Budżet domowy",
  description: "Konta, wydatki, przepływy, subskrypcje · CSV lub Open Banking",
  nameEn: "Home budget",
  descriptionEn: "Accounts, expenses, cash flow, subscriptions · CSV or Open Banking",
  networth: true,
  accountTypes: [
    accountType("checking", "budget", "Konta osobiste", { labelEn: "Checking accounts" }),
    accountType("savings", "budget", "Oszczędności", { labelEn: "Savings" }),
    accountType("credit", "budget", "Karty kredytowe", { sign: "credit", labelEn: "Credit cards" }),
    accountType("cash", "budget", "Gotówka", { labelEn: "Cash" }),
  ],
  skill: "/budget-setup",
});

export const ASSETS_MODULE: ModuleSpec = moduleSpec({
  id: "assets",
  name: "Majątek",
  description: "Nieruchomości, auta i inne aktywa wyceniane ręcznie",
  nameEn: "Assets",
  descriptionEn: "Property, cars and other manually valued assets",
  networth: true,
  networthBuckets: [
    netWorthBucket("property", "Nieruchomości", 10, { labelEn: "Property" }),
    netWorthBucket("vehicle", "Auto", 20, { labelEn: "Car" }),
  ],
  accountTypes: [
    accountType("property", "assets", "Nieruchomości", {
      liquid: false,
      bucket: "property",
      labelEn: "Property",
    }),
    accountType("vehicle", "assets", "Auto", { liquid: false, bucket: "vehicle", labelEn: "Car" }),
    accountType("investment", "assets", "Inwestycje", { labelEn: "Investments" }),
    accountType("other", "assets", "Inne", { labelEn: "Other" }),
  ],
  skill: "/assets-setup",
});

export const LOANS_MODULE: ModuleSpec = moduleSpec({
  id: "loans",
  name: "Kredyty",
  description: "Hipoteka i kredyty: harmonogram, odsetki, saldo w czasie",
  nameEn: "Loans",
  descriptionEn: "Mortgage and loans: repayment schedule, interest, balance over time",
  networth: true,
  networthBuckets: [
    netWorthBucket("mortgage", "Hipoteka", 30, { liability: true, labelEn: "Mortgage" }),
    netWorthBucket("loan", "Kredyt", 40, { liability: true, labelEn: "Loan" }),
  ],
  accountTypes: [
    accountType("mortgage", "loans", "Hipoteka", {
      sign: "liability",
      liquid: false,
      bucket: "mortgage",
      labelEn: "Mortgage",
    }),
    accountType("loan", "loans", "Pożyczki", {
      sign: "liability",
      liquid: false,
      bucket: "loan",
      labelEn: "Loans",
    }),
  ],
  // Installments are loan repayments, never subscriptions.
  textRules: INSTALLMENT_PHRASES,
  notSubscriptionCategories: [LOANS_CATEGORY],
  skill: "/loans-setup",
});

export const INVESTMENTS_MODULE: ModuleSpec = moduleSpec({
  id: "investments",
  name: "Inwestycje",
  description: "Rachunki maklerskie, alokacja vs strategia, sygnały, dziennik decyzji",
  nameEn: "Investments",
  descriptionEn: "Brokerage accounts, allocation vs strategy, signals, decision journal",
  available: true,
  cliName: "invest",
  networth: true,
  networthBuckets: [netWorthBucket("investments", "Inwestycje", 5, { labelEn: "Investments" })],
  accountTypes: [
    accountType(BROKERAGE, "investments", "Rachunki maklerskie", {
      bucket: "investments",
      labelEn: "Brokerage accounts",
    }),
  ],
  // Display names only: imports go through the cashU format or a CSV mapping.
  institutions: [
    institution("dif", "broker", "DIF Broker"),
    institution("xtb", "broker", "XTB"),
    institution("binance", "exchange", "Binance"),
    institution("zonda", "exchange", "Zonda"),
  ],
  skill: "/investments-setup",
});

/** The built-in modules in display order (`MODULE_IDS`). */
export const BUILTIN_MODULES: readonly ModuleSpec[] = Object.freeze([
  BUDGET_MODULE,
  ASSETS_MODULE,
  LOANS_MODULE,
  INVESTMENTS_MODULE,
]);

/** The registries of a build with every built-in module (Python's `modules.registry()`). */
export function builtinRegistry(): CoreRegistry {
  return createCoreRegistry(BUILTIN_MODULES);
}
