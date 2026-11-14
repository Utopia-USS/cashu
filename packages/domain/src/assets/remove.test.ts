// Translation of the logic parts of tests/test_asset_remove.py (F7 MB1: vehicle rows carry their
// depreciation terms; MB2: a removed manual position or vehicle is gone from the list, from net worth now
// and in the history and from the loans list, kept for a restore; loans follow the same name re-use rule)
// over an in-memory profile seeded like conftest.seed_demo's positions. The HTTP status codes, routes and
// the accounts / summary endpoints are the API layer's; name-key parking itself is core's (the profile
// stand-in parks like `core.accounts.park_removed_key`, the store's parking scenarios cover the real one),
// so test_a_new_position_with_a_removed_name_starts_fresh (key parking and unparking) is not translated here.

import { describe, expect, it } from "vitest";
import { netWorth, netWorthComponentSeries } from "../core/networth.js";
import { D, decimalKey } from "../decimal.js";
import { loans } from "../index.js";
import { SyntheticProfile } from "../testing/netWorthProfile.js";
import { depreciatedValue } from "./depreciation.js";
import { isModuleAccount } from "./service.js";

const TODAY = "2026-10-01";

/** conftest.seed_demo's accounts and positions (balances of the bank account, the property, the mortgage
 * with its loan, the vehicle, the cash pool). */
function seed(): SyntheticProfile {
  const p = new SyntheticProfile(TODAY);
  const main = p.getOrCreateAccount({
    bank: "mbank",
    name: "mKonto Test",
    iban: "PL61109010140000071219812874",
  });
  p.setBalance(main.id, "2026-09-30", "5000.00", "csv");
  p.getOrCreateAccount({ bank: "manual", name: "Gotówka", externalId: "cash:PLN", type: "cash" });
  p.addManualPosition("Mieszkanie Test", "property", "600000", "2026-06-01");
  const mortgage = p.addManualPosition(
    "Kredyt hipoteczny Test",
    "mortgage",
    "390000",
    "2026-06-01",
  );
  p.writeTerms(mortgage.id, {
    principal: "400000",
    rate: "6.0",
    months: 300,
    start: "2025-01-05",
    origination: "2024-12-10",
  });
  p.setVehicle("Auto Test", "80000", "2025-05-01", "15", "10000");
  return p;
}

function rows(p: SyntheticProfile) {
  return p.manualRows(netWorth(p.book()).lines);
}

function byName(p: SyntheticProfile, name: string) {
  const row = rows(p).find((r) => r.name === name);
  if (row === undefined) throw new Error(`no row ${name}`);
  return row;
}

const names = (p: SyntheticProfile) => rows(p).map((r) => r.name);

/** Everything net-worth related (current and history), by value. */
function snapshot(p: SyntheticProfile) {
  const book = p.book();
  const nw = netWorth(book);
  const series = (g: "daily" | "monthly") =>
    netWorthComponentSeries(book, "PLN", g).map(([d, comps]) => [
      d,
      Object.fromEntries([...comps].map(([k, v]) => [k, decimalKey(v)])),
    ]);
  return {
    totals: Object.fromEntries([...nw.totals].map(([c, v]) => [c, decimalKey(v)])),
    accounts: nw.lines.map((ln) => ln.account.id),
    series: series("daily"),
    monthly: series("monthly"),
  };
}

const pln = (p: SyntheticProfile) => netWorth(p.book()).totals.get("PLN") ?? D("0");
const loanKeys = (p: SyntheticProfile) =>
  p.listLoans().map(([l]) => ({
    accountId: l.accountId,
    principal: decimalKey(l.principal),
    annualRate: decimalKey(l.annualRate),
    termMonths: l.termMonths,
    startDate: l.startDate,
  }));

describe("test_asset_remove.py: MB1 depreciation terms on vehicle rows", () => {
  it("test_vehicle_rows_carry_their_depreciation_terms", () => {
    const p = seed();
    const car = byName(p, "Auto Test");
    // stored as 15 (percent); the contract's annual_rate is a fraction
    const dep = car.depreciation;
    expect(
      dep && [dep.purchasePrice, dep.purchaseDate, dep.annualRate, dep.floor].map(String),
    ).toEqual(["80000", "2025-05-01", "0.15", "10000"]);
    const expected = depreciatedValue(D("80000"), "2025-05-01", D("15"), TODAY, D("10000"));
    expect(car.balance?.toString()).toBe(expected.toString());
    expect(byName(p, "Mieszkanie Test").depreciation).toBeNull();
    expect(byName(p, "Kredyt hipoteczny Test").depreciation).toBeNull();
  });

  it("test_a_vehicle_without_stored_terms_has_null_depreciation", () => {
    const p = seed();
    p.getOrCreateAccount({
      bank: "manual",
      name: "Rower Test",
      externalId: "vehicle:Rower Test",
      type: "vehicle",
    });
    const bike = byName(p, "Rower Test");
    expect([bike.kind, bike.depreciation]).toEqual(["vehicle", null]);
  });
});

describe("test_asset_remove.py: MB2 remove + restore", () => {
  it("test_remove_hides_everywhere_and_restore_brings_everything_back", () => {
    const p = seed();
    p.notes = [{ accountId: byName(p, "Mieszkanie Test").id, note: "Do sprzedaży" }];
    const flat = byName(p, "Mieszkanie Test");
    const before = snapshot(p);

    p.remove(flat.id);
    expect(names(p)).not.toContain("Mieszkanie Test");
    const after = snapshot(p);
    expect(after.totals.PLN).toBe(decimalKey(D(before.totals.PLN as string).sub(D("600000"))));
    expect(after.accounts).not.toContain(flat.id);
    for (const series of [after.series, after.monthly]) {
      expect(series.every(([, comps]) => !("property" in (comps as object)))).toBe(true);
    }
    expect(before.series.some(([, comps]) => "property" in (comps as object))).toBe(true);
    // kept for a restore
    expect(p.account(flat.id).removedAt).not.toBeNull();

    // idempotent
    p.remove(flat.id);
    expect(names(p)).not.toContain("Mieszkanie Test");

    p.restore(flat.id);
    expect(byName(p, "Mieszkanie Test")).toEqual(flat); // the row as before, note included
    expect(snapshot(p)).toEqual(before);
    p.restore(flat.id);
    expect(byName(p, "Mieszkanie Test")).toEqual(flat);
  });

  it("test_a_vehicle_is_removed_and_restored_too", () => {
    const p = seed();
    const before = snapshot(p);
    const car = byName(p, "Auto Test");
    p.remove(car.id);
    const after = snapshot(p);
    expect(names(p)).not.toContain("Auto Test");
    expect(after.totals.PLN).toBe(
      decimalKey(D(before.totals.PLN as string).sub(car.balance ?? D("0"))),
    );
    expect(after.series.every(([, comps]) => !("vehicle" in (comps as object)))).toBe(true);
    p.restore(car.id);
    expect(byName(p, "Auto Test")).toEqual(car);
    expect(snapshot(p)).toEqual(before);
  });

  it("test_profile_routes_unknown_ids_and_isolation (logic part)", () => {
    const p = seed();
    const other = new SyntheticProfile(TODAY);
    // another profile's rows never show this profile's positions
    expect(rows(other)).toEqual([]);
    // an account that is not a manual position is not this module's
    const checking = p.accounts.find((a) => a.name === "mKonto Test");
    expect(checking && isModuleAccount(checking)).toBe(false);
    expect(names(p)).not.toContain("mKonto Test");
  });

  it("test_a_removed_loan_account_leaves_the_loans_list", () => {
    const p = seed();
    const listed = loanKeys(p);
    expect(listed.length).toBeGreaterThan(0);
    const accountId = listed[0]?.accountId as string;
    p.remove(accountId);
    expect(loanKeys(p).map((x) => x.accountId)).not.toContain(accountId);
    p.restore(accountId);
    expect(loanKeys(p)).toEqual(listed);
  });
});

describe("test_asset_remove.py: F7 re-review B2, loans follow the same name re-use rule", () => {
  it("test_a_loan_under_a_removed_mortgages_name_gets_a_fresh_account", () => {
    const p = seed();
    const mortgage = byName(p, "Kredyt hipoteczny Test");
    const [original] = loanKeys(p);
    expect(original?.accountId).toBe(mortgage.id);
    expect(original?.principal).toBe("400000");
    const plnBefore = pln(p);

    p.remove(mortgage.id);
    expect(loanKeys(p)).toEqual([]);
    const plnRemoved = pln(p);
    expect(plnRemoved.gt(plnBefore)).toBe(true); // the mortgage debt is out of net worth

    // the /loans-setup flow with the same name
    const loan = p.addLoan({
      principal: "300000",
      rate: "7.0",
      months: 300,
      start: "2026-01-01",
      name: "Kredyt hipoteczny Test",
      type: "mortgage",
    });
    if (!loan.ok) throw new Error(loan.message);
    const freshId = loan.value.accountId;
    expect(freshId).not.toBe(mortgage.id);
    const [fresh, ...none] = loanKeys(p);
    expect(none).toEqual([]);
    expect([fresh?.accountId, fresh?.principal, fresh?.annualRate, fresh?.startDate]).toEqual([
      freshId,
      "300000",
      "7",
      "2026-01-01",
    ]);
    const accounts = netWorth(p.book()).lines.map((ln) => ln.account.id);
    expect(accounts).toContain(freshId);
    expect(accounts).not.toContain(mortgage.id);
    expect(pln(p).lt(plnRemoved)).toBe(true); // the new debt counts

    // restoring the old mortgage brings back ITS terms, never the new ones
    p.restore(mortgage.id);
    const restored = new Map(loanKeys(p).map((x) => [x.accountId, x]));
    expect(restored.get(mortgage.id)).toEqual(original);
    expect(restored.get(freshId)?.principal).toBe("300000");
    const keys = new Map(
      p.accounts
        .filter((a) => a.name === "Kredyt hipoteczny Test")
        .map((a) => [a.id, a.externalId]),
    );
    expect(keys).toEqual(
      new Map([
        [mortgage.id, `manual:Kredyt hipoteczny Test~${mortgage.id}`],
        [freshId, "manual:Kredyt hipoteczny Test"],
      ]),
    );
  });

  it("test_loan_lookups_never_reach_a_removed_account", () => {
    const p = seed();
    const mortgage = byName(p, "Kredyt hipoteczny Test");
    const [[loan]] = p.listLoans() as [[loans.LoanTerms, unknown]];
    p.remove(mortgage.id);
    const terms = { principal: "1", rate: "1", months: 12, start: "2026-01-01" };
    for (const result of [
      loans.visibleLoan(p.loanRows, p.accounts, loan.id),
      p.setLoan(mortgage.id, terms),
      p.addLoan({ ...terms, account: { kind: "id", id: mortgage.id } }),
      p.addLoan({ ...terms, account: { kind: "name", name: "Kredyt hipoteczny Test" } }),
    ]) {
      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.message).toMatch(/No (loan|account)/);
    }
    p.restore(mortgage.id);
    const back = loans.visibleLoan(p.loanRows, p.accounts, loan.id);
    expect(back.ok && decimalKey(back.value.principal)).toBe("400000");
  });

  it("test_a_removed_property_does_not_block_a_loan_name", () => {
    // The mirror case: a removed property holding `manual:<name>` no longer refuses the loan name.
    const p = seed();
    const flat = byName(p, "Mieszkanie Test");
    p.remove(flat.id);
    const loan = p.addLoan({
      principal: "1000",
      rate: "5",
      months: 12,
      start: "2026-01-01",
      name: "Mieszkanie Test",
      type: "loan",
    });
    expect(loan.ok && loan.value.accountId).not.toBe(flat.id);
    expect(loan.ok).toBe(true);
  });
});
