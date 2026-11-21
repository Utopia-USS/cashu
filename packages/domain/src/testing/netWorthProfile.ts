/**
 * Test-only: an in-memory profile for the loans / assets ports, the stand-in for Python's session in
 * the translated pytest files. It writes rows the way the Python services do (`add_manual_position`,
 * `set_balance`, `add_loan` / `set_loan`, `set_vehicle`, remove / restore) using the domain decisions,
 * and builds the `NetWorthBook` net worth reads. Synthetic data only.
 */

import { builtinRegistry } from "../core/builtinModules.js";
import { orderContributors } from "../core/modules.js";
import type { NetWorthBook } from "../core/networth.js";
import type { NetWorthAccount } from "../core/valuation.js";
import { assets, D, type Decimal, type IsoDate, loans } from "../index.js";

export interface ProfileAccount extends NetWorthAccount, loans.LoanAccountRow {
  readonly iban: string | null;
}

interface BalanceRow {
  readonly accountId: string;
  readonly date: IsoDate;
  readonly amount: Decimal;
  readonly source: string;
  readonly recordedAt: string;
}

const registry = builtinRegistry();

/** One synthetic profile; ids are `a1`, `a2`, ... (accounts) and `l1`, ... (loans) in creation order. */
export class SyntheticProfile {
  readonly today: IsoDate;
  accounts: ProfileAccount[] = [];
  balanceRows: BalanceRow[] = [];
  loanRows: loans.LoanTerms[] = [];
  curves: assets.DepreciationTerms[] = [];
  notes: assets.AssetNote[] = [];
  private tick = 0;
  private loanSeq = 0;

  constructor(today: IsoDate = "2026-10-01") {
    this.today = today;
  }

  /** A strictly increasing naive-UTC timestamp (Python's `utcnow()` at each write). */
  now(): string {
    this.tick += 1;
    return `2026-09-01 10:00:${String(this.tick % 60).padStart(2, "0")}.${String(this.tick).padStart(6, "0")}`;
  }

  account(id: string): ProfileAccount {
    const a = this.accounts.find((x) => x.id === id);
    if (a === undefined) throw new Error(`no account ${id}`);
    return a;
  }

  /** `get_or_create_account` by (bank, external id), else a new account. */
  getOrCreateAccount(init: {
    bank: string;
    name: string;
    externalId?: string | null;
    type?: string;
    currency?: string;
    iban?: string | null;
  }): ProfileAccount {
    const ext = init.externalId ?? null;
    const found = this.accounts.find(
      (a) => ext !== null && a.bank === init.bank && a.externalId === ext,
    );
    if (found !== undefined) return found;
    const account: ProfileAccount = {
      id: `a${this.accounts.length + 1}`,
      bank: init.bank,
      name: init.name,
      externalId: ext,
      type: init.type ?? "checking",
      currency: init.currency ?? "PLN",
      active: true,
      removedAt: null,
      iban: init.iban ?? null,
    };
    this.accounts.push(account);
    return account;
  }

  /** `upsert_balance` / `set_balance`: one row per (account, date, source), replaced in place. */
  setBalance(accountId: string, date: IsoDate, amount: string, source = "manual"): void {
    const row = { accountId, date, amount: D(amount), source, recordedAt: this.now() };
    const i = this.balanceRows.findIndex(
      (b) => b.accountId === accountId && b.date === date && b.source === source,
    );
    if (i >= 0) this.balanceRows[i] = row;
    else this.balanceRows.push(row);
  }

  /** `add_manual_position` (with the removed-key parking of `park_removed_key`). */
  addManualPosition(
    name: string,
    type: string,
    value: string,
    onDate: IsoDate = this.today,
  ): ProfileAccount {
    this.parkRemovedKey(`manual:${name}`);
    const account = this.getOrCreateAccount({
      bank: "manual",
      name,
      externalId: `manual:${name}`,
      type,
    });
    this.setBalance(account.id, onDate, value);
    return account;
  }

  /** `set_vehicle`. */
  setVehicle(
    name: string,
    price: string,
    purchaseDate: IsoDate,
    rate: string,
    floor: string | null,
  ): ProfileAccount {
    this.parkRemovedKey(`vehicle:${name}`);
    const account = this.getOrCreateAccount({
      bank: "manual",
      name,
      externalId: `vehicle:${name}`,
      type: "vehicle",
    });
    this.curves = this.curves.filter((c) => c.accountId !== account.id);
    this.curves.push({
      accountId: account.id,
      purchasePrice: D(price),
      purchaseDate,
      annualRate: D(rate),
      floor: floor === null ? null : D(floor),
    });
    return account;
  }

  /** `park_removed_key`: a removed holder of `key` moves aside to `<key>~<id>`. */
  parkRemovedKey(key: string): void {
    this.accounts = this.accounts.map((a) =>
      a.bank === "manual" && a.externalId === key && a.removedAt !== null
        ? { ...a, externalId: `${key}~${a.id}` }
        : a,
    );
  }

  remove(accountId: string): void {
    this.accounts = this.accounts.map((a) =>
      a.id === accountId && a.removedAt === null ? { ...a, removedAt: this.now() } : a,
    );
  }

  restore(accountId: string): void {
    this.accounts = this.accounts.map((a) => (a.id === accountId ? { ...a, removedAt: null } : a));
  }

  /** `set_loan` after the decision: create or update the terms, `updated_at` now. */
  writeTerms(
    accountId: string,
    terms: {
      principal: string;
      rate: string;
      months: number;
      start: IsoDate;
      origination?: IsoDate;
    },
    matching: { iban?: string | null; text?: string | null } = {},
  ): loans.LoanTerms {
    const current = this.loanRows.find((l) => l.accountId === accountId);
    const m = loans.paymentMatching(
      current ?? { paymentIban: null, paymentText: null },
      matching.iban,
      matching.text,
    );
    const row: loans.LoanTerms = {
      id: current?.id ?? `l${++this.loanSeq}`,
      accountId,
      principal: D(terms.principal),
      annualRate: D(terms.rate),
      termMonths: terms.months,
      startDate: terms.start,
      originationDate: terms.origination ?? null,
      updatedAt: this.now(),
      ...m,
    };
    if (current === undefined) this.loanRows.push(row);
    else this.loanRows = this.loanRows.map((l) => (l.id === row.id ? row : l));
    return row;
  }

  /** `set_loan`: refuses accounts that are not visible mortgage / loan accounts. */
  setLoan(
    accountId: string,
    terms: { principal: string; rate: string; months: number; start: IsoDate },
  ): loans.LoanResult<loans.LoanTerms> {
    const target = loans.loanTermsTarget(this.accounts, accountId);
    if (!target.ok) return target;
    return { ok: true, value: this.writeTerms(accountId, terms) };
  }

  /** `add_loan`. */
  addLoan(
    input: loans.AddLoanTarget & {
      principal: string;
      rate: string;
      months: number;
      start: IsoDate;
      iban?: string;
      text?: string;
    },
  ): loans.LoanResult<loans.LoanTerms> {
    const plan = loans.addLoanPlan(this.accounts, input);
    if (!plan.ok) return plan;
    let accountId: string;
    if (plan.value.kind === "existing") accountId = plan.value.account.id;
    else {
      this.parkRemovedKey(plan.value.externalId);
      accountId = this.getOrCreateAccount({
        bank: "manual",
        name: plan.value.name,
        externalId: plan.value.externalId,
        type: plan.value.type,
      }).id;
    }
    return {
      ok: true,
      value: this.writeTerms(accountId, input, { iban: input.iban, text: input.text }),
    };
  }

  /** `set_payment_matching`. */
  setPaymentMatching(
    loanId: string,
    iban?: string | null,
    text?: string | null,
  ): loans.LoanResult<loans.LoanTerms> {
    const loan = loans.visibleLoan(this.loanRows, this.accounts, loanId);
    if (!loan.ok) return loan;
    const row = { ...loan.value, ...loans.paymentMatching(loan.value, iban, text) };
    this.loanRows = this.loanRows.map((l) => (l.id === loanId ? row : l));
    return { ok: true, value: row };
  }

  /** The profile's net-worth inputs with every module's contributor (module display order). */
  book(today: IsoDate = this.today): NetWorthBook {
    const balances = new Map<string, { date: IsoDate; amount: Decimal; source: string }[]>();
    const recorded = new Map<string, loans.RecordedBalance[]>();
    for (const b of this.balanceRows) {
      balances.set(b.accountId, [...(balances.get(b.accountId) ?? []), b]);
      recorded.set(b.accountId, [...(recorded.get(b.accountId) ?? []), b]);
    }
    return {
      accounts: this.accounts,
      balances,
      contributors: orderContributors(registry, {
        assets: assets.assetsContributor(this.curves),
        loans: loans.loansContributor({ loans: this.loanRows, balances: recorded }),
      }),
      types: registry.accountTypes,
      today,
    };
  }

  /** `list_loans`. */
  listLoans(): [loans.LoanTerms, ProfileAccount][] {
    return loans.listLoans(this.loanRows, this.accounts);
  }

  /** The `/assets/manual` rows. */
  manualRows(
    lines: Parameters<typeof assets.manualPositionRows>[0]["lines"],
  ): assets.ManualPositionRow[] {
    return assets.manualPositionRows({
      lines,
      details: new Map(this.accounts.map((a) => [a.id, a])),
      notes: this.notes,
      curves: this.curves,
      institutions: registry.institutions,
      lang: "pl",
    });
  }
}
