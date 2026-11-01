/**
 * One profile's `NetWorthBook` from the read-only source, with every module's TS contributor: budget's
 * cash pool, assets' depreciation curves, loans' amortization (anchored on balances recorded after the
 * terms) and investments' brokerage valuation. Account and loan ids are the goldens' natural keys.
 * Shared by the core.networth, core.networth_series, loans.valuation and assets.depreciation producers.
 */

import { assets, budget, core, D, type IsoDate, loans } from "@cashu/domain";
import type { PythonDb } from "../../sources/index.ts";
import { finiteRows } from "../finite.ts";
import { brokerageContributor } from "../investments/brokerage.ts";

export interface ProfileBook {
  readonly book: core.NetWorthBook;
  /** The profile's loan terms (natural keys), in id order. */
  readonly loans: readonly loans.LoanTerms[];
  /** Balance rows with `created_at` per account (natural key), in id order. */
  readonly recorded: ReadonlyMap<string, readonly loans.RecordedBalance[]>;
  /** The profile's depreciation curves (natural keys), in id order. */
  readonly curves: readonly assets.DepreciationTerms[];
  /** Transactions left out of the cash pool valuation for a non-finite amount (`finite.ts`). */
  readonly skippedNonFinite: number;
}

/** `loans` rows -> domain terms (ids as natural keys). */
export function loanTerms(db: PythonDb, profileId: number): loans.LoanTerms[] {
  return db.loansAssets.loans(profileId).map((l) => ({
    id: db.keys.key("loans", l.id),
    accountId: db.keys.key("accounts", l.accountId),
    principal: D(l.principal),
    annualRate: D(l.annualRate),
    termMonths: l.termMonths,
    startDate: l.startDate,
    originationDate: l.originationDate,
    updatedAt: l.updatedAt,
    paymentIban: l.paymentIban,
    paymentText: l.paymentText,
  }));
}

/** `depreciations` rows -> domain curves (account ids as natural keys). */
export function depreciationTerms(db: PythonDb, profileId: number): assets.DepreciationTerms[] {
  return db.loansAssets.depreciations(profileId).map((d) => ({
    accountId: db.keys.key("accounts", d.accountId),
    purchasePrice: D(d.purchasePrice),
    purchaseDate: d.purchaseDate,
    annualRate: D(d.annualRate),
    floor: d.floor === null ? null : D(d.floor),
  }));
}

/** The loan accounts' balance rows with `created_at` per account (natural key), in id order. */
export function recordedBalances(
  db: PythonDb,
  profileId: number,
): Map<string, loans.RecordedBalance[]> {
  const out = new Map<string, loans.RecordedBalance[]>();
  for (const b of db.loansAssets.loanAccountBalances(profileId)) {
    const id = db.keys.key("accounts", b.accountId);
    const list = out.get(id) ?? [];
    list.push({ date: b.date, amount: D(b.amount), recordedAt: b.createdAt });
    out.set(id, list);
  }
  return out;
}

export function profileBook(
  db: PythonDb,
  registry: core.CoreRegistry,
  profileId: number,
  today: IsoDate = db.asOf,
): ProfileBook {
  const key = (accountId: number): string => db.keys.key("accounts", accountId);
  const accounts: core.NetWorthAccount[] = db
    .accounts(profileId, { includeRemoved: true })
    .map((a) => ({
      id: key(a.id),
      type: a.type,
      currency: a.currency,
      active: a.active,
      removedAt: a.removedAt,
    }));
  const balances = new Map<string, core.BalanceSnapshot[]>();
  for (const b of db.balances(profileId)) {
    const id = key(b.accountId);
    const list = balances.get(id) ?? [];
    list.push({ date: b.date, amount: D(b.amount), source: b.source });
    balances.set(id, list);
  }
  // `transactions` is in (account_id, id) order: per account that is id order, the anchor order
  // budget's contributor needs (it values each pool from that pool's rows only).
  const txns = finiteRows(db.transactions(profileId));
  const cash = budget.cashContributor(
    txns.rows.map((t) => ({
      account: key(t.accountId),
      bookingDate: t.bookingDate,
      amount: t.value,
    })),
  );
  const terms = loanTerms(db, profileId);
  const recorded = recordedBalances(db, profileId);
  const curves = depreciationTerms(db, profileId);
  const contributors = core.orderContributors(registry, {
    budget: cash,
    assets: assets.assetsContributor(curves),
    loans: loans.loansContributor({ loans: terms, balances: recorded }),
    investments: brokerageContributor(db, profileId),
  });
  return {
    book: { accounts, balances, contributors, types: registry.accountTypes, today },
    loans: terms,
    recorded,
    curves,
    skippedNonFinite: txns.skipped,
  };
}
