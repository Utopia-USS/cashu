/**
 * Producer of `assets.depreciation` (`parity/python/checks/loans_assets.py:assets`): per profile, the
 * manual positions list (`GET /assets/manual` rows, JSON floats, Polish bank names as the goldens' run)
 * and every stored curve (id order, removed accounts too) with its value at the probe dates.
 * `@cashu/domain` assets does the math; this file only shapes the golden's JSON.
 */

import { assets, core, type Decimal } from "@cashu/domain";
import type { PythonDb } from "../../sources/index.ts";
import { depreciationTerms, profileBook } from "../core/book.ts";
import { probeDates } from "../loans/probes.ts";
import { type OutValue, pyFloat } from "../output.ts";

/** `core/api.py:f`: Decimal -> JSON number (None stays None). */
const f = (d: Decimal | null) => (d === null ? null : pyFloat(d.toFloat()));

function rowOut(r: assets.ManualPositionRow): OutValue {
  const dep = r.depreciation;
  return {
    id: r.id,
    bank: r.bank,
    bank_name: r.bankName,
    name: r.name,
    type: r.type,
    currency: r.currency,
    iban_tail: r.ibanTail,
    balance: f(r.balance),
    as_of: r.asOf,
    is_liability: r.isLiability,
    kind: r.kind,
    note: r.note,
    depreciation:
      dep === null
        ? null
        : {
            purchase_price: f(dep.purchasePrice),
            purchase_date: dep.purchaseDate,
            annual_rate: f(dep.annualRate),
            floor: f(dep.floor),
          },
  };
}

export function produceAssetsDepreciation(db: PythonDb): OutValue {
  const registry = core.builtinRegistry();
  const out: Record<string, OutValue> = {};
  for (const p of db.profiles()) {
    const { book } = profileBook(db, registry, p.id);
    const details = new Map(
      db.accounts(p.id, { includeRemoved: true }).map((a) => [db.keys.key("accounts", a.id), a]),
    );
    const notes = db.loansAssets.assetDetails(p.id).map((d) => ({
      accountId: db.keys.key("accounts", d.accountId),
      note: d.note,
    }));
    const curves = depreciationTerms(db, p.id);
    const rows = assets.manualPositionRows({
      lines: core.netWorth(book).lines,
      details,
      notes,
      curves,
      institutions: registry.institutions,
      lang: "pl",
    });
    out[db.keys.key("profiles", p.id)] = {
      manual_rows: rows.map(rowOut),
      depreciation: curves.map((dep) => ({
        account_id: dep.accountId,
        purchase_price: dep.purchasePrice,
        purchase_date: dep.purchaseDate,
        annual_rate: dep.annualRate,
        floor: dep.floor,
        values: probeDates(dep.purchaseDate, db.asOf).map((d) => ({
          date: d,
          value: assets.curveValue(dep, d),
        })),
      })),
    };
  }
  return out;
}
