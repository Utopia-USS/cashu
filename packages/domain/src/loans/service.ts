/**
 * Loans: amortization terms attached to mortgage / loan accounts, many per profile
 * (`modules/loans/service.py`), as pure decisions over the profile's rows.
 *
 * Python looks rows up through the session and raises `ValueError`; here the caller (a store
 * command, the CLI) passes the profile's accounts and gets a result union back: the refusal carries
 * a stable `reason` for the UI and Python's English `message` for the CLI. Writing the terms (events)
 * and parking a removed account's name key (`core.accounts.park_removed_key`) stay with the caller.
 */

import type { IsoDate } from "../dates.js";
import type { Decimal } from "../decimal.js";
import { normalizeIban } from "../iban.js";
import { pyStrip } from "../text.js";
import { type LoanSummary, summarize } from "./amortization.js";
import type { BalanceSource, LoanTerms, LoanValuation } from "./valuation.js";

/** `LOAN_TYPES`: the only account types loan terms attach to. */
export const LOAN_TYPES: readonly string[] = Object.freeze(["mortgage", "loan"]);

/** The institution id of manually created accounts (`core.institutions.MANUAL`). */
const MANUAL_BANK = "manual";

/** The fields of an account the loan decisions read (`core.models.Account`). */
export interface LoanAccountRow {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly bank: string;
  readonly externalId: string | null;
  /** Set when the owner removed the position: never a target of loan terms. */
  readonly removedAt: string | null;
}

export type LoanRefusalReason =
  | "no_account"
  | "not_loan"
  | "ambiguous"
  | "name_taken"
  | "no_named_account"
  | "bad_type"
  | "name_or_account"
  | "no_loan";

export interface LoanRefusal {
  readonly ok: false;
  readonly reason: LoanRefusalReason;
  /** Python's `ValueError` text (English, for the CLI and logs; the UI maps `reason`). */
  readonly message: string;
}

export type LoanResult<T> = { readonly ok: true; readonly value: T } | LoanRefusal;

function refuse(reason: LoanRefusalReason, message: string): LoanRefusal {
  return { ok: false, reason, message };
}

function ok<T>(value: T): LoanResult<T> {
  return { ok: true, value };
}

/** `is_loan_account`. */
export function isLoanAccount(account: { readonly type: string }): boolean {
  return LOAN_TYPES.includes(account.type);
}

/** `_describe`: how an account is named in a refusal. */
function describe(account: LoanAccountRow): string {
  return `'${account.name}' (id ${account.id}, ${account.type}, ${account.bank})`;
}

/**
 * `_visible_account`: the profile's account with this id that the owner has not removed (a removed
 * account is out of every view, so loan terms never attach to it). `accounts` = the profile's
 * accounts (another profile's account is unknown by construction).
 */
export function visibleAccount(
  accounts: readonly LoanAccountRow[],
  accountId: string,
): LoanResult<LoanAccountRow> {
  const account = accounts.find((a) => a.id === accountId);
  if (account === undefined || account.removedAt !== null) {
    return refuse("no_account", `No account with id ${accountId}`);
  }
  return ok(account);
}

/** `_require_loan_type`. */
export function requireLoanType(account: LoanAccountRow): LoanResult<LoanAccountRow> {
  if (isLoanAccount(account)) return ok(account);
  return refuse(
    "not_loan",
    `Account ${describe(account)} is not a loan: loan terms attach only to mortgage/loan accounts.`,
  );
}

function ambiguous(label: string, candidates: readonly LoanAccountRow[]): LoanRefusal {
  const listing = candidates.map(describe).join("; ");
  return refuse(
    "ambiguous",
    `'${label}' is ambiguous, several mortgage/loan accounts match: ${listing}. Pick one with --account ID.`,
  );
}

/** `set_loan`'s target: a visible mortgage / loan account of the profile. */
export function loanTermsTarget(
  accounts: readonly LoanAccountRow[],
  accountId: string,
): LoanResult<LoanAccountRow> {
  const account = visibleAccount(accounts, accountId);
  return account.ok ? requireLoanType(account.value) : account;
}

/**
 * How the user names an existing account: its id, or its exact name. (Python takes one value and
 * reads a digit string as an id; the CLI that parses user input decides which kind it is.)
 */
export type AccountReference =
  | { readonly kind: "id"; readonly id: string }
  | { readonly kind: "name"; readonly name: string };

/** Accounts in Python's `ORDER BY id` order: the caller passes them in storage order. */
function visibleByName(accounts: readonly LoanAccountRow[], name: string): LoanAccountRow[] {
  return accounts.filter((a) => a.removedAt === null && a.name === name);
}

/** `_account_by_reference`: the account a loan attaches to, named explicitly by id or exact name. */
export function accountByReference(
  accounts: readonly LoanAccountRow[],
  ref: AccountReference,
): LoanResult<LoanAccountRow> {
  if (ref.kind === "id") return loanTermsTarget(accounts, ref.id);
  const text = pyStrip(ref.name);
  const named = visibleByName(accounts, text);
  const [first] = named;
  if (first === undefined)
    return refuse("no_named_account", `No account named '${text}' in this profile.`);
  const loanish = named.filter(isLoanAccount);
  if (loanish.length > 1) return ambiguous(text, loanish);
  const [loan] = loanish;
  return loan === undefined ? requireLoanType(first) : ok(loan);
}

/**
 * `_account_for_new_loan`: the existing loan account a named loan updates, or null when a new
 * manual account must be created. Only a mortgage / loan account with exactly this name qualifies;
 * when the manual key for this name (`manual:<name>`) is held by another kind of account, the name is
 * refused. Removed accounts are not looked at (the caller parks a removed key holder aside first, so
 * the new loan gets a fresh account and the removed one keeps its own terms for a restore).
 */
export function accountForNewLoan(
  accounts: readonly LoanAccountRow[],
  name: string,
): LoanResult<LoanAccountRow | null> {
  const key = `manual:${name}`;
  const rows = accounts.filter((a) => a.removedAt === null);
  const loanish = rows.filter((a) => a.name === name && isLoanAccount(a));
  if (loanish.length > 1) return ambiguous(name, loanish);
  const [loan] = loanish;
  if (loan !== undefined) return ok(loan);
  const taken = rows.find((a) => a.bank === MANUAL_BANK && a.externalId === key);
  if (taken !== undefined) {
    return refuse(
      "name_taken",
      `An account ${describe(taken)} already uses the name '${name}'; loan terms attach only to ` +
        "mortgage/loan accounts. Choose another loan name, or pass --account with the id of a " +
        "mortgage/loan account.",
    );
  }
  return ok(null);
}

export interface AddLoanTarget {
  /** `name` given: a new loan (or the loan account of that name); `account`: an existing one. */
  readonly name?: string | undefined;
  readonly account?: AccountReference | undefined;
  /** `mortgage` or `loan` (Python's default `loan`). */
  readonly type?: string | undefined;
}

/** What `add_loan` attaches the terms to: an existing account, or a new manual account. */
export type AddLoanPlan =
  | { readonly kind: "existing"; readonly account: LoanAccountRow }
  | {
      readonly kind: "create";
      readonly name: string;
      readonly externalId: string;
      readonly type: string;
    };

/**
 * `add_loan`'s checks and target: by `name` a new loan (a manual account of `type`) or the profile's
 * one mortgage / loan account of that name; by `account` an existing mortgage / loan account. Never
 * another account type; an ambiguous name lists the candidates.
 */
export function addLoanPlan(
  accounts: readonly LoanAccountRow[],
  input: AddLoanTarget,
): LoanResult<AddLoanPlan> {
  const type = input.type ?? "loan";
  if (!LOAN_TYPES.includes(type)) {
    return refuse("bad_type", `A loan account is 'mortgage' or 'loan', not '${type}'`);
  }
  if ((input.name === undefined) === (input.account === undefined)) {
    return refuse(
      "name_or_account",
      input.name !== undefined
        ? "Give the loan NAME (a new loan, or an existing loan account of that name) " +
            "or --account (an existing mortgage/loan account), not both."
        : "Give the loan NAME or --account (an existing mortgage/loan account).",
    );
  }
  if (input.account !== undefined) {
    const target = accountByReference(accounts, input.account);
    return target.ok ? ok({ kind: "existing", account: target.value }) : target;
  }
  const name = input.name as string;
  const existing = accountForNewLoan(accounts, name);
  if (!existing.ok) return existing;
  if (existing.value !== null) return ok({ kind: "existing", account: existing.value });
  return ok({ kind: "create", name, externalId: `manual:${name}`, type });
}

/**
 * Payment matching after `set_loan` / `set_payment_matching`: a given field replaces the current one
 * (IBAN normalized, text stripped, empty clears to null); an absent field (undefined or null, Python's
 * `None`) keeps it.
 */
export function paymentMatching(
  current: { readonly paymentIban: string | null; readonly paymentText: string | null },
  iban: string | null | undefined,
  text: string | null | undefined,
): { paymentIban: string | null; paymentText: string | null } {
  return {
    paymentIban: iban != null ? normalizeIban(iban) || null : current.paymentIban,
    paymentText: text != null ? pyStrip(text) || null : current.paymentText,
  };
}

/** `get_loan`: a loan of the profile whose account is still visible. */
export function visibleLoan<L extends { readonly id: string; readonly accountId: string }>(
  loans: readonly L[],
  accounts: readonly LoanAccountRow[],
  loanId: string,
): LoanResult<L> {
  const loan = loans.find((l) => l.id === loanId);
  if (loan === undefined || !visibleAccount(accounts, loan.accountId).ok) {
    return refuse("no_loan", `No loan with id ${loanId}`);
  }
  return ok(loan);
}

/**
 * `list_loans`: the profile's loans with their accounts, oldest first (`loans` in id order); a loan
 * whose account the owner removed is left out, like in net worth.
 */
export function listLoans<L extends { readonly accountId: string }, A extends LoanAccountRow>(
  loans: readonly L[],
  accounts: readonly A[],
): [L, A][] {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const out: [L, A][] = [];
  for (const loan of loans) {
    const account = byId.get(loan.accountId);
    if (account !== undefined && account.removedAt === null) out.push([loan, account]);
  }
  return out;
}

/** The account fields the loan summary shows. */
export interface LoanSummaryAccount {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly currency: string;
}

/**
 * `loan_summary` (the `/api/loan` fields plus identity) with Decimals; the API layer turns them into
 * JSON numbers. `outstanding` is what net worth uses (the schedule, or a balance recorded after the
 * terms: `balanceSource` says which); `scheduleOutstanding` is the pure schedule.
 */
export interface LoanSummaryView {
  readonly id: string;
  readonly accountId: string;
  readonly name: string | null;
  readonly type: string | null;
  readonly hasLoan: true;
  readonly currency: string;
  readonly principal: Decimal;
  readonly annualRate: Decimal;
  readonly termMonths: number;
  readonly monthlyPayment: Decimal;
  readonly startDate: IsoDate;
  readonly outstanding: Decimal;
  readonly scheduleOutstanding: Decimal;
  readonly balanceSource: BalanceSource;
  readonly monthsElapsed: number;
  readonly paidPrincipal: Decimal;
  readonly paidInterest: Decimal;
  readonly remainingInterest: Decimal;
  readonly totalInterest: Decimal;
  readonly payoffDate: IsoDate;
  /** Last four characters of the lender IBAN, null when none. */
  readonly paymentIbanTail: string | null;
  readonly paymentText: string | null;
  readonly summary: LoanSummary;
}

/**
 * `loan_summary`. `account` null = the account is gone: the currency is then `fallbackCurrency`
 * (Python: the default profile's base currency).
 */
export function loanSummary(
  loan: LoanTerms,
  account: LoanSummaryAccount | null,
  valuation: LoanValuation,
  asOf: IsoDate,
  fallbackCurrency: string,
): LoanSummaryView {
  const summ = summarize(
    loan.principal,
    loan.annualRate,
    loan.termMonths,
    loan.startDate,
    asOf,
    loan.originationDate,
  );
  // Python slices code points: `(payment_iban or "")[-4:]`.
  const ibanTail = Array.from(loan.paymentIban ?? "")
    .slice(-4)
    .join("");
  return {
    id: loan.id,
    accountId: loan.accountId,
    name: account === null ? null : account.name,
    type: account === null ? null : account.type,
    hasLoan: true,
    currency: account === null ? fallbackCurrency : account.currency,
    principal: summ.principal,
    annualRate: summ.annualRate,
    termMonths: summ.termMonths,
    monthlyPayment: summ.monthlyPayment,
    startDate: summ.startDate,
    outstanding: valuation.at(asOf),
    scheduleOutstanding: summ.outstanding,
    balanceSource: valuation.source(asOf),
    monthsElapsed: summ.monthsElapsed,
    paidPrincipal: summ.paidPrincipal,
    paidInterest: summ.paidInterest,
    remainingInterest: summ.remainingInterest,
    totalInterest: summ.totalInterest,
    payoffDate: summ.payoffDate,
    paymentIbanTail: ibanTail || null,
    paymentText: loan.paymentText,
    summary: summ,
  };
}
