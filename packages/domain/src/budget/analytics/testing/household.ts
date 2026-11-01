/**
 * Test helper: a synthetic household built the way the Python service layer stores it, through the
 * domain ports of each step: rows are ingested per account, `categorize()` runs the transfer match
 * (S08) and the deterministic categorization with the recurring signal (S09) over every row (claims
 * kept), `setCategory` records the owner's per-row choice (a `cash_withdrawal` mirrors the row into the
 * cash pool, cash.py), `cashExpense` logs a pool expense. `book()` / `env()` are what the analytics
 * read. Synthetic data only.
 */

import {
  type BalanceSnapshot,
  builtinRegistry,
  latestBalancePerAccount,
  type NetWorthBook,
  orderContributors,
  ownIbans,
  textRules,
} from "../../../core/index.js";
import type { IsoDate } from "../../../dates.js";
import { D, type Decimal } from "../../../decimal.js";
import { normalizeIban } from "../../../iban.js";
import {
  CASH_ACCOUNT_TYPE,
  CASH_WITHDRAWAL,
  cashExpenseAmount,
  cashLegFields,
  cashPoolName,
  MANUAL_CATEGORY_SOURCE,
} from "../../cash.js";
import {
  type CategoryClaimValue,
  type ClaimSource,
  categorizeAll,
  type EngineContext,
  type MerchantRule,
  rulesByMerchant,
} from "../../categorize/index.js";
import { cashContributor } from "../../networth.js";
import { matchTransfers, transferAccountKeys } from "../../transfers.js";
import type { BudgetAccount, BudgetBook, BudgetTxn } from "../book.js";
import type { CushionEnv } from "../cushion.js";
import { subscriptionExclusions } from "../recurring.js";

const REGISTRY = builtinRegistry();

/** A `RawTransaction` (amount as text, `currency` defaults to PLN). */
export interface Raw {
  readonly date: IsoDate;
  readonly amount: string;
  readonly ref?: string | null;
  readonly cp?: string | null;
  readonly iban?: string | null;
  readonly desc?: string | null;
  readonly currency?: string;
  readonly bankId?: string | null;
}

interface Row {
  key: string;
  account: string;
  raw: Raw;
  amount: Decimal;
  category: string | null;
  categorySource: string | null;
  isInternalTransfer: boolean;
  transferGroup: string | null;
  claim: CategoryClaimValue | null;
  cashLegOf: string | null;
}

export interface AccountInit {
  readonly name: string;
  readonly iban?: string | null;
  readonly type?: string;
  readonly currency?: string;
  readonly active?: boolean;
}

export class Household {
  readonly baseCurrency: string;
  private readonly accounts: BudgetAccount[] = [];
  private readonly rows: Row[] = [];
  private readonly balances = new Map<string, BalanceSnapshot[]>();
  private rules: MerchantRule[] = [];
  private nextAccount = 1;
  private nextRow = 1;

  constructor(baseCurrency = "PLN") {
    this.baseCurrency = baseCurrency;
  }

  /** `get_or_create_account` (a new account; the IBAN normalized as Python stores it). */
  account(init: AccountInit): string {
    const id = `acc-${this.nextAccount++}`;
    this.accounts.push({
      id,
      name: init.name,
      iban: normalizeIban(init.iban) || null,
      type: init.type ?? "checking",
      currency: init.currency ?? "PLN",
      active: init.active ?? true,
      removedAt: null,
    });
    return id;
  }

  /** The id of the account named `name`. */
  accountId(name: string): string {
    const a = this.accounts.find((x) => x.name === name);
    if (a === undefined) throw new Error(`no account ${name}`);
    return a.id;
  }

  /** `upsert_balance` (CSV). */
  balance(account: string, date: IsoDate, amount: string): void {
    const list = (this.balances.get(account) ?? []).filter((b) => b.date !== date);
    list.push({ date, amount: D(amount), source: "csv" });
    this.balances.set(account, list);
  }

  /** `ingest_transactions`: stores the rows uncategorized (run `categorize()` afterwards). */
  ingest(account: string, rows: readonly Raw[]): string[] {
    return rows.map((raw) => this.add(account, raw, null, null).key);
  }

  /** `category_rules` of the profile. */
  setRules(rules: readonly MerchantRule[]): void {
    this.rules = [...rules];
  }

  private add(
    account: string,
    raw: Raw,
    claim: CategoryClaimValue | null,
    legOf: string | null,
  ): Row {
    const row: Row = {
      key: `t${this.nextRow++}`,
      account,
      raw,
      amount: D(raw.amount),
      category: null,
      categorySource: null,
      isInternalTransfer: false,
      transferGroup: null,
      claim,
      cashLegOf: legOf,
    };
    this.rows.push(row);
    return row;
  }

  private accountOf(id: string): BudgetAccount {
    const a = this.accounts.find((x) => x.id === id);
    if (a === undefined) throw new Error(`no account ${id}`);
    return a;
  }

  private ctx(): EngineContext {
    return {
      ownIbans: ownIbans(this.accounts),
      rules: rulesByMerchant(this.rules),
      patterns: [],
      moduleTextRules: textRules(REGISTRY),
    };
  }

  /** `match_internal_transfers` + `categorize_all` over every row (owner choices and legs kept). */
  categorize(): void {
    const pairs = matchTransfers(
      this.rows.map((r) => ({
        key: r.key,
        account: r.account,
        bookingDate: r.raw.date,
        amount: r.amount,
        counterpartyIban: r.raw.iban ?? null,
      })),
      transferAccountKeys(this.accounts.map((a) => ({ key: a.id, iban: a.iban }))),
    );
    for (const r of this.rows) {
      r.isInternalTransfer = false;
      r.transferGroup = null;
    }
    pairs.forEach((p, i) => {
      for (const key of [p.out, p.in]) {
        const r = this.rows.find((x) => x.key === key) as Row;
        r.isInternalTransfer = true;
        r.transferGroup = `group-${i + 1}`;
      }
    });
    const { results } = categorizeAll(
      this.rows.map((r) => ({
        key: r.key,
        onCashAccount: this.accountOf(r.account).type === CASH_ACCOUNT_TYPE,
        bookingDate: r.raw.date,
        currency: r.raw.currency ?? "PLN",
        amount: r.amount,
        counterpartyName: r.raw.cp ?? null,
        counterpartyIban: r.raw.iban ?? null,
        reference: r.raw.ref ?? null,
        description: r.raw.desc ?? null,
        isInternalTransfer: r.isInternalTransfer,
        claim: r.claim,
      })),
      this.ctx(),
      subscriptionExclusions(REGISTRY),
    );
    for (const r of this.rows) {
      const e = results.get(r.key) ?? null;
      r.category = e?.category ?? null;
      r.categorySource = e?.source ?? null;
    }
  }

  private pool(currency: string): string {
    const found = this.accounts.find(
      (a) => a.type === CASH_ACCOUNT_TYPE && a.currency === currency,
    );
    if (found !== undefined) return found.id;
    return this.account({
      name: cashPoolName(currency, this.baseCurrency),
      type: CASH_ACCOUNT_TYPE,
      currency,
    });
  }

  /** `set_transaction_category` (manual); `cash_withdrawal` on a bank row makes its pool leg. */
  setCategory(key: string, category: string): void {
    const r = this.rows.find((x) => x.key === key);
    if (r === undefined) throw new Error(`no row ${key}`);
    r.claim = { category, source: MANUAL_CATEGORY_SOURCE };
    r.category = category;
    r.categorySource = MANUAL_CATEGORY_SOURCE;
    if (category === CASH_WITHDRAWAL && this.accountOf(r.account).type !== CASH_ACCOUNT_TYPE) {
      const currency = r.raw.currency ?? "PLN";
      const f = cashLegFields(
        {
          bookingDate: r.raw.date,
          valueDate: null,
          amount: r.amount,
          currency,
          description: r.raw.desc ?? null,
          reference: r.raw.ref ?? null,
        },
        null,
      );
      const leg = this.add(
        this.pool(currency),
        {
          date: f.bookingDate,
          amount: f.amount.toString(),
          cp: f.counterpartyName,
          desc: f.description,
          ref: f.reference,
          currency,
        },
        { category: f.category, source: f.categorySource as ClaimSource },
        r.key,
      );
      leg.category = f.category;
      leg.categorySource = f.categorySource;
    }
  }

  /** `add_cash_expense` (pool in `currency`, default the base currency). */
  cashExpense(
    date: IsoDate,
    amount: string,
    title: string,
    category: string,
    currency?: string,
  ): string {
    const cur = currency ?? this.baseCurrency;
    const parsed = cashExpenseAmount(D(amount));
    if (!parsed.ok) throw new Error(parsed.reason);
    const row = this.add(
      this.pool(cur),
      { date, amount: parsed.amount.toString(), cp: title, desc: title, ref: title, currency: cur },
      { category, source: MANUAL_CATEGORY_SOURCE },
      null,
    );
    row.category = category;
    row.categorySource = MANUAL_CATEGORY_SOURCE;
    return row.key;
  }

  /** The first row matching `pred`. */
  find(pred: (r: BudgetTxn) => boolean): BudgetTxn {
    const t = this.book().transactions.find(pred);
    if (t === undefined) throw new Error("no such row");
    return t;
  }

  /** The stored rows, in storage order (by account, then by row). */
  book(): BudgetBook {
    const order = new Map(this.accounts.map((a, i) => [a.id, i]));
    const transactions: BudgetTxn[] = this.rows
      .map((r, i) => ({ r, i }))
      .sort((a, b) => (order.get(a.r.account) ?? 0) - (order.get(b.r.account) ?? 0) || a.i - b.i)
      .map(({ r }) => ({
        key: r.key,
        account: r.account,
        bookingDate: r.raw.date,
        amount: r.amount,
        currency: r.raw.currency ?? "PLN",
        counterpartyName: r.raw.cp ?? null,
        counterpartyIban: r.raw.iban ?? null,
        description: r.raw.desc ?? null,
        reference: r.raw.ref ?? null,
        bankTransactionId: r.raw.bankId ?? null,
        category: r.category,
        categorySource: r.categorySource,
        isInternalTransfer: r.isInternalTransfer,
        transferGroup: r.transferGroup,
        cashLegOf: r.cashLegOf,
      }));
    return { baseCurrency: this.baseCurrency, accounts: [...this.accounts], transactions };
  }

  /** Balances through core net worth (snapshots, the cash pool's running sum). */
  env(today: IsoDate = "2026-10-15"): CushionEnv {
    const book = this.book();
    const nw: NetWorthBook = {
      accounts: book.accounts,
      balances: this.balances,
      contributors: orderContributors(REGISTRY, { budget: cashContributor(book.transactions) }),
      types: REGISTRY.accountTypes,
      today,
    };
    return { latestAt: (asOf) => latestBalancePerAccount(nw, asOf), types: REGISTRY.accountTypes };
  }

  /** The engine context `recurringPayments` reads. */
  engineContext(): EngineContext {
    return this.ctx();
  }
}
