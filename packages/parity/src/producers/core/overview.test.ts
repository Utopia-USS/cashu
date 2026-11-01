// The core.overview producer over one synthetic dataset (invented values): the setup facts counted from
// the source's rows (removed accounts, the manual institution, default vs manual categories, a loan
// without the budget's help, the strategy file), the summary and the series view shapes.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withPythonDb } from "../../sources/index.ts";
import { type SyntheticDataset, syntheticDataset } from "../../sources/testing.ts";
import { dumps } from "../output.ts";
import { produceOverview } from "./overview.ts";

const SEED = `
INSERT INTO profiles VALUES (1, 'test-b', 'Test B', 'PLN', 'strict', NULL);
INSERT INTO profile_modules VALUES (1, 'budget', 1, NULL), (1, 'loans', 1, NULL),
  (1, 'assets', 1, NULL), (1, 'investments', 1, NULL);
INSERT INTO accounts VALUES
  (1, 'mbank', 'Konto Test', NULL, 'csv:1', 'PLN', 'checking', 1, NULL, 1, NULL),
  (2, 'pekao', 'Stare Konto', NULL, 'csv:2', 'PLN', 'checking', 1, NULL, 1, '2026-01-01 00:00:00'),
  (3, 'manual', 'Kredyt Test', NULL, 'manual:kredyt', 'PLN', 'loan', 1, NULL, 1, NULL),
  (4, 'manual', 'Dom Test', NULL, 'manual:dom', 'PLN', 'property', 1, NULL, 1, NULL),
  (5, 'manual', 'Auto Test', NULL, 'manual:auto', 'PLN', 'vehicle', 1, NULL, 1, '2026-02-01 00:00:00'),
  (6, 'xtb', 'Rachunek Test', NULL, 'xtb:1', 'PLN', 'brokerage', 1, NULL, 1, NULL);
INSERT INTO balances VALUES
  (1, 1, '2026-09-01', '1000.00', 'PLN', 'CSV', NULL),
  (2, 4, '2026-06-01', '500000', 'PLN', 'MANUAL', NULL);
INSERT INTO loans (id, account_id, principal, annual_rate, term_months, start_date, updated_at)
  VALUES (1, 3, '12000', '0', 24, '2025-01-01', '2026-01-01 00:00:00.000000');
INSERT INTO transactions VALUES
  (1, 1, '2026-08-02', NULL, '-20.00', 'PLN', NULL, NULL, 'SKLEP TEST', NULL, 'CSV', 'h1', 0,
   NULL, 0, 'other', 'default', NULL),
  (2, 1, '2026-08-03', NULL, '3000.00', 'PLN', NULL, NULL, 'PENSJA TEST', NULL, 'CSV', 'h2', 0,
   NULL, 0, 'salary', 'keyword', NULL);
`;

type Tree = Record<string, Record<string, unknown>>;

let ds: SyntheticDataset;
beforeEach(() => {
  ds = syntheticDataset(SEED);
});
afterEach(() => ds.dispose());

function run(): Tree {
  return withPythonDb({ dataset: "demo", sourceDir: ds.dir, runRoot: ds.runRoot }, (db) => {
    const tree = JSON.parse(dumps(produceOverview(db))) as Record<string, Tree>;
    return tree[db.keys.key("profiles", 1)] as Tree;
  });
}

interface SetupOut {
  readonly state: string;
  readonly steps: { readonly status: string }[];
}
const setupOf = (p: Tree, key: string) => (p.setup ?? {})[key] as SetupOut;
const stateOf = (p: Tree, key: string) => setupOf(p, key).state;
const statuses = (p: Tree, key: string) => setupOf(p, key).steps.map((s) => s.status);

describe("core.overview producer", () => {
  it("counts the setup facts as each module's setup.py does", () => {
    const p = run();
    // two bank accounts (a removed one counts), one uncategorized outflow, no transfers yet
    expect(statuses(p, "budget_pl")).toEqual(["done", "on", "todo"]);
    // the loan exists, no phrase, nothing categorized as loans
    expect(statuses(p, "loans_pl")).toEqual(["done", "on"]);
    // the removed car does not count: one position, the optional car step open
    expect(statuses(p, "assets_pl")).toEqual(["done", "todo"]);
    expect(stateOf(p, "assets_en")).toBe("ready");
    // an account, no strategy file, no transactions, no run
    expect(statuses(p, "investments_pl")).toEqual(["done", "on", "todo", "todo"]);
    expect(p.modules).toEqual([
      { enabled: true, id: "budget", setup_state: "partial" },
      { enabled: true, id: "assets", setup_state: "ready" },
      { enabled: true, id: "loans", setup_state: "partial" },
      { enabled: true, id: "investments", setup_state: "partial" },
    ]);
    const budget = p.setup?.budget_en as { cli_prefix: string; skill: string };
    expect([budget.cli_prefix, budget.skill]).toEqual(["cashu --profile test-b", "/budget-setup"]);
  });

  it("the strategy file closes the strategy step", () => {
    ds.writeFile("profiles/test-b/strategy.yaml", "version: 1\n");
    expect(statuses(run(), "investments_pl")).toEqual(["done", "done", "on", "todo"]);
  });

  it("the summary and the series view as the API shapes them", () => {
    const p = run();
    const summary = p.summary as Record<string, unknown>;
    expect(Object.keys(summary).sort()).toEqual([
      "breakdown",
      "month",
      "networth",
      "subscriptions",
    ]);
    expect(summary.month).toEqual({ label: "2026-08", income: 3000, expense: 20, net: 2980 });
    expect(summary.subscriptions).toEqual({ count: 0, monthly_total: 0, monthly_totals: {} });
    const series = p.series as Record<string, Record<string, { currency: string }>>;
    expect(Object.keys(series)).toEqual(["PLN"]);
    expect(Object.keys(series.PLN ?? {}).sort()).toEqual(
      [
        "daily_liquid",
        "daily_total",
        "monthly_liquid",
        "monthly_total",
        "weekly_liquid",
        "weekly_total",
      ].sort(),
    );
    expect((p.series_default as { currency: string }).currency).toBe("PLN");
  });
});
