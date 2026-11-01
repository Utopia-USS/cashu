/**
 * Producer of `core.networth` (`parity/python/checks/core.py:networth`): per profile, net worth now
 * and 365 days before as_of, the lines, the breakdown per currency, the bucket order.
 *
 * Inputs: the profile's rows from the read-only source (`sources/pythonDb.ts`) and every module's TS
 * contributor (`book.ts`: budget's cash pool, assets' depreciation, loans' amortization, investments'
 * brokerage valuation). Everything core owns runs in `@cashu/domain` core.
 */

import { addDays, core, type Decimal } from "@cashu/domain";
import type { PythonDb } from "../../sources/index.ts";
import type { OutValue } from "../output.ts";
import { profileBook } from "./book.ts";

function decimals(map: ReadonlyMap<string, Decimal>): Record<string, Decimal> {
  return Object.fromEntries(map);
}

function lineOut(line: core.NetWorthLine): OutValue {
  return {
    account_id: line.account.id,
    type: line.account.type,
    currency: line.account.currency,
    as_of: line.asOf,
    amount: line.amount,
    contribution: line.contribution,
    is_liability: line.isLiability,
  };
}

export function produceNetworth(db: PythonDb): OutValue {
  const registry = core.builtinRegistry();
  const out: Record<string, OutValue> = {};
  for (const p of db.profiles()) {
    const { book } = profileBook(db, registry, p.id);
    const now = core.netWorth(book);
    const yearAgo = core.netWorth(book, addDays(db.asOf, -365));
    const breakdown: Record<string, OutValue> = {};
    for (const currency of [...now.totals.keys()].sort()) {
      const b = core.netWorthBreakdown(book, currency);
      breakdown[currency] = {
        assets: b.assets,
        liabilities: b.liabilities,
        net: b.net,
        property_value: b.propertyValue,
        mortgage: b.mortgage,
        home_equity: b.homeEquity,
        by_type: decimals(b.byType),
      };
    }
    out[db.keys.key("profiles", p.id)] = {
      totals: decimals(now.totals),
      totals_365d_ago: decimals(yearAgo.totals),
      lines: now.lines.map(lineOut),
      breakdown,
      component_order: core.componentOrder(registry.accountTypes),
      liability_components: [...core.liabilityComponents(registry.accountTypes)].sort(),
    };
  }
  return out;
}
