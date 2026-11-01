/**
 * Producer of `core.networth_series` (`parity/python/checks/core.py:networth_series`): per profile and
 * currency of its accounts (removed ones too, as the check's query), the daily total, the weekly
 * liquid series and the monthly components. Every contributor answers `at()` / `axisDates()` in TS
 * (`book.ts`); the series math is `@cashu/domain` core.
 */

import { core } from "@cashu/domain";
import type { PythonDb } from "../../sources/index.ts";
import type { OutValue } from "../output.ts";
import { profileBook } from "./book.ts";

export function produceNetworthSeries(db: PythonDb): OutValue {
  const registry = core.builtinRegistry();
  const out: Record<string, OutValue> = {};
  for (const p of db.profiles()) {
    const { book } = profileBook(db, registry, p.id);
    const currencies = [
      ...new Set(db.accounts(p.id, { includeRemoved: true }).map((a) => a.currency)),
    ].sort();
    const per: Record<string, OutValue> = {};
    for (const c of currencies) {
      per[c] = {
        daily_total: core.netWorthSeries(book, c, "daily", "total"),
        weekly_liquid: core.netWorthSeries(book, c, "weekly", "liquid"),
        monthly_components: core
          .netWorthComponentSeries(book, c, "monthly", "total")
          .map(([d, comps]) => [d, Object.fromEntries(comps)]),
      };
    }
    out[db.keys.key("profiles", p.id)] = per;
  }
  return out;
}
