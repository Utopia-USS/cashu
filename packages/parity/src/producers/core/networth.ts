/**
 * Producer of `core.networth` (`parity/python/checks/core.py:networth`): per profile, net worth now
 * and 365 days before as_of, the lines, the breakdown per currency, the bucket order.
 *
 * Inputs: accounts, balance snapshots and the cash pool's transactions from the read-only source
 * (`sources/pythonDb.ts`); the investments contributor is the domain `BrokerageContributor` over the
 * profile's investments rows (`../investments/brokerage.ts`); the loans / assets contributors come
 * from the Python bridge until their ports land (`bridge.ts`). Everything core owns runs in
 * `@cashu/domain` core.
 */

import { addDays, core, D, type Decimal } from "@cashu/domain";
import type { PythonDb } from "../../sources/index.ts";
import { brokerageContributor } from "../investments/brokerage.ts";
import type { OutValue } from "../output.ts";
import { type BridgeFile, bridgedContributors } from "./bridge.ts";
import { CashPoolContributor } from "./cashPool.ts";

function decimals(map: ReadonlyMap<string, Decimal>): Record<string, Decimal> {
  return Object.fromEntries(map);
}

/** The profile's `NetWorthBook`, account ids = the goldens' natural keys. */
function profileBook(
  db: PythonDb,
  registry: core.CoreRegistry,
  profileId: number,
  bridge: BridgeFile,
): core.NetWorthBook {
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
  const cash = new CashPoolContributor(
    db.transactions(profileId).map((t) => ({
      accountKey: key(t.accountId),
      id: t.id,
      bookingDate: t.bookingDate,
      amount: D(t.amount),
    })),
  );
  const profileKey = db.keys.key("profiles", profileId);
  const contributors = core.orderContributors(registry, {
    budget: cash,
    investments: brokerageContributor(db, profileId),
    ...bridgedContributors(bridge, profileKey, db.asOf),
  });
  return {
    accounts,
    balances,
    contributors,
    types: registry.accountTypes,
    today: db.asOf,
  };
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

export function produceNetworth(db: PythonDb, bridge: BridgeFile): OutValue {
  const registry = core.builtinRegistry();
  const out: Record<string, OutValue> = {};
  for (const p of db.profiles()) {
    const book = profileBook(db, registry, p.id, bridge);
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
