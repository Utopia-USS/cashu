/**
 * The investments domain values as `parity/python/canon.py` writes their Python dataclasses: field
 * names in snake_case, decimals as `str()`, floats as Python floats, sets as sorted lists, and the
 * app's `str(pk)` ids replaced by natural keys where canon.py maps the field (`*_id`, a bare `id`
 * under `instrument`). Fields canon.py keeps raw stay raw (dict keys such as `last_trade_prices`).
 */

import { formatDateTime, investments as inv } from "@cashu/domain";
import type { PythonDb } from "../../sources/index.ts";
import { type OutValue, pyFloat } from "../output.ts";
import { pk } from "./rows.ts";

/** canon.py `_as_row_id`: a digit string without a leading zero is a row id. */
function isRowId(value: string): boolean {
  return /^[0-9]+$/.test(value) && !value.startsWith("0");
}

export class Serializer {
  private readonly db: PythonDb;

  constructor(db: PythonDb) {
    this.db = db;
  }

  private key(table: string, id: string): string {
    return isRowId(id) ? this.db.keys.key(table, pk(id)) : id;
  }

  account = (id: string): string => this.key("accounts", id);
  instrumentKey = (id: string): string => this.key("inv_instruments", id);
  txn = (id: string): string => this.key("inv_transactions", id);
  profile = (id: string): string => this.key("profiles", id);

  /** An id-like field canon.py has no table for: a row id there would fail the golden check. */
  private unmapped(field: string, value: string): string {
    if (isRowId(value)) throw new Error(`unmapped id in field ${field}`);
    return value;
  }

  money(m: inv.Money): OutValue {
    return { amount: m.amount, currency: m.currency };
  }

  lot(lot: inv.OpenLot): OutValue {
    return {
      account_id: this.account(lot.accountId),
      instrument_id: this.instrumentKey(lot.instrumentId),
      open_txn_id: this.txn(lot.openTxnId),
      open_date: lot.openDate,
      quantity: lot.quantity,
      currency: lot.currency,
      unit_cost: lot.unitCost,
    };
  }

  realized(t: inv.RealizedTrade): OutValue {
    return {
      account_id: this.account(t.accountId),
      instrument_id: this.instrumentKey(t.instrumentId),
      open_txn_id: this.txn(t.openTxnId),
      close_txn_id: this.txn(t.closeTxnId),
      open_date: t.openDate,
      close_date: t.closeDate,
      quantity: t.quantity,
      close_unit_price: t.closeUnitPrice,
      currency: t.currency,
      cost_currency: t.costCurrency,
      open_unit_cost: t.openUnitCost,
      pnl: t.pnl,
    };
  }

  holding(h: inv.Holding): OutValue {
    return {
      account_id: this.account(h.accountId),
      instrument_id: this.instrumentKey(h.instrumentId),
      currency: h.currency,
      quantity: h.quantity,
      lots: h.lots.map((l) => this.lot(l)),
    };
  }

  cash(c: inv.CashBalance): OutValue {
    return { account_id: this.account(c.accountId), currency: c.currency, amount: c.amount };
  }

  snapshot(s: inv.PortfolioSnapshot): OutValue {
    const prices: Record<string, OutValue> = {};
    for (const [id, p] of s.lastTradePrices) {
      prices[id] = { date: p.date, price: p.price, currency: p.currency };
    }
    return {
      profile_id: this.profile(s.profileId),
      as_of: s.asOf,
      holdings: s.holdings.map((h) => this.holding(h)),
      cash: s.cash.map((c) => this.cash(c)),
      deposits: s.deposits.map((d) => ({
        account_id: this.account(d.accountId),
        date: d.date,
        amount: this.money(d.amount),
      })),
      realized: s.realized.map((t) => this.realized(t)),
      last_trade_prices: prices,
      warnings: s.warnings.map((w) => this.warning(w)),
    };
  }

  instrument(i: inv.Instrument): OutValue {
    return {
      id: this.instrumentKey(i.id),
      name: i.name,
      currency: i.currency,
      asset_class: i.assetClass,
      symbol: i.symbol,
      isin: i.isin,
      mic: i.mic,
      region: i.region,
      sector: i.sector,
      tags: [...i.tags],
      needs_classification: i.needsClassification,
      aliases: i.aliases.map((a) => ({
        namespace: a.namespace,
        value: a.value,
        guessed: a.guessed,
      })),
      valuation_mode: i.valuationMode,
      status: i.status,
      plan: i.plan,
      plan_at: i.planAt === null ? null : formatDateTime(i.planAt),
      plan_reason: i.planReason,
      segment: i.segment,
      segment_by: i.segmentBy,
    };
  }

  valuedHolding(v: inv.ValuedHolding): OutValue {
    return {
      holding: this.holding(v.holding),
      instrument: this.instrument(v.instrument),
      is_stale: v.isStale,
      price: v.price,
      price_date: v.priceDate,
      market_value_base: v.marketValueBase,
      cost_basis_base: v.costBasisBase,
      unrealized_pct: v.unrealizedPct === null ? null : pyFloat(v.unrealizedPct),
      weight: v.weight === null ? null : pyFloat(v.weight),
      valuation_mode: v.valuationMode,
      price_currency: v.priceCurrency,
      missing_fx_currency: v.missingFxCurrency,
    };
  }

  valued(p: inv.ValuedPortfolio): OutValue {
    return {
      snapshot: this.snapshot(p.snapshot),
      base_currency: p.baseCurrency,
      cash_base: p.cashBase,
      total_base: p.totalBase,
      stale_weight: pyFloat(p.staleWeight),
      valued: p.valued.map((v) => this.valuedHolding(v)),
      cash: p.cash.map((c) => ({ cash: this.cash(c.cash), amount_base: c.amountBase })),
      warnings: p.warnings.map((w) => this.warning(w)),
      missing_fx_currencies: sortedStrings(p.missingFxCurrencies),
      realized: p.realized.map((r) => ({
        trade: this.realized(r.trade),
        proceeds_base: r.proceedsBase,
        cost_base: r.costBase,
      })),
    };
  }

  allocation(a: inv.AllocationResult): OutValue {
    const byBucket: Record<string, OutValue> = {};
    for (const [bucket, holdings] of a.holdingsByBucket) {
      byBucket[bucket] = holdings.map((h) => this.valuedHolding(h));
    }
    return {
      total_base: a.totalBase,
      unclassified_value_base: a.unclassifiedValueBase,
      unallocated_cash_base: a.unallocatedCashBase,
      allocations: a.allocations.map((b) => ({
        bucket_id: this.unmapped("bucket_id", b.bucketId),
        weight: pyFloat(b.weight),
        target: pyFloat(b.target),
        drift_pp: pyFloat(b.driftPp),
        drift_rel: pyFloat(b.driftRel),
        value_base: b.valueBase,
        drift_value_base: b.driftValueBase,
        cash_history_gap: b.cashHistoryGap,
      })),
      holdings_by_bucket: byBucket,
      unclassified: a.unclassified.map((h) => this.valuedHolding(h)),
    };
  }

  /**
   * A warning as its Python dataclass: no `kind` (a ClassVar), and `account_id` only on the
   * account-scoped kinds (a class attribute, not a field, on the others).
   */
  warning(w: inv.PortfolioWarning): OutValue {
    const out: Record<string, OutValue> = {};
    for (const [field, value] of Object.entries(w)) {
      if (field === "kind") continue;
      if (field === "accountId" && !ACCOUNT_SCOPED.has(w.kind)) continue;
      const name = snake(field);
      out[name] = this.warningValue(name, value);
    }
    return out;
  }

  private warningValue(name: string, value: unknown): OutValue {
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") return BigInt(value); // day counts (Python int)
    if (value instanceof Set) return sortedStrings(value as ReadonlySet<string>);
    if (typeof value === "string") {
      if (name === "account_id") return this.account(value);
      if (name === "instrument_id") return this.instrumentKey(value);
      if (name.endsWith("_id")) return this.unmapped(name, value);
      return value;
    }
    return value as OutValue; // Decimal
  }
}

const ACCOUNT_SCOPED: ReadonlySet<inv.WarningKind> = new Set<inv.WarningKind>([
  "history_gap",
  "unknown_cost_basis",
  "invalid_transaction",
  "mixed_lot_currencies",
  "realized_currency_mismatch",
  "cash_history_gap",
  "missing_cost_basis",
]);

const snake = (field: string): string => field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** canon.py sorts set items by their JSON text; for plain strings that is code-point order. */
function sortedStrings(values: ReadonlySet<string>): string[] {
  return [...values].sort(inv.comparePyStr);
}
