/**
 * The manual positions list (`modules/assets/api.py:_rows`, `GET /assets/manual`) as a read model:
 * every manual position and vehicle of the profile still in net worth, with its signed value, note
 * and (vehicles) depreciation curve, largest first. Decimals stay Decimals; the API layer turns
 * them into JSON numbers.
 */

import type { InstitutionRegistry, NetWorthLine, UiLang } from "../core/index.js";
import type { IsoDate } from "../dates.js";
import { D, type Decimal } from "../decimal.js";
import type { DepreciationTerms } from "./depreciation.js";
import { type AssetNote, isModuleAccount, isVehicle, notesOf } from "./service.js";

const HUNDRED = D("100");

/** The account fields the list shows beyond what net worth reads. */
export interface PositionAccountDetails {
  readonly bank: string;
  readonly name: string;
  readonly iban: string | null;
  readonly externalId: string | null;
}

/** `_depreciation`: the stored curve in the API's shape (`annualRate` a fraction: 0.15, not 15). */
export interface DepreciationView {
  readonly purchasePrice: Decimal;
  readonly purchaseDate: IsoDate;
  readonly annualRate: Decimal;
  readonly floor: Decimal | null;
}

export interface ManualPositionRow {
  readonly id: string;
  readonly bank: string;
  readonly bankName: string;
  readonly name: string;
  readonly type: string;
  readonly currency: string;
  /** Last four characters of the IBAN ("" when none). */
  readonly ibanTail: string;
  /** Signed net-worth contribution (a liability is negative); null = no value yet. */
  readonly balance: Decimal | null;
  readonly asOf: IsoDate | null;
  readonly isLiability: boolean;
  readonly kind: "vehicle" | "manual";
  readonly note: string | null;
  /** Vehicles only; null for a manual position or a vehicle without stored terms. */
  readonly depreciation: DepreciationView | null;
}

export interface ManualPositionsInput {
  /** `core.netWorth(book).lines` (active, non-removed accounts, storage order). */
  readonly lines: readonly NetWorthLine[];
  /** Bank, name, IBAN and external id per account id. */
  readonly details: ReadonlyMap<string, PositionAccountDetails>;
  readonly notes: readonly AssetNote[];
  /** The profile's depreciation curves. */
  readonly curves: readonly DepreciationTerms[];
  readonly institutions: InstitutionRegistry;
  readonly lang: UiLang;
}

/** Python `str` order (code points), not UTF-16 units. */
function codePointCompare(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const d = (x[i]?.codePointAt(0) ?? 0) - (y[i]?.codePointAt(0) ?? 0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

function depreciationView(dep: DepreciationTerms | undefined): DepreciationView | null {
  if (dep === undefined) return null;
  return {
    purchasePrice: dep.purchasePrice,
    purchaseDate: dep.purchaseDate,
    annualRate: dep.annualRate.div(HUNDRED),
    floor: dep.floor,
  };
}

/** `_rows`: largest absolute value first (as JSON floats), then by name. */
export function manualPositionRows(input: ManualPositionsInput): ManualPositionRow[] {
  const rows: { row: ManualPositionRow; size: number }[] = [];
  const lines = input.lines.filter((ln) => {
    const d = input.details.get(ln.account.id);
    return d !== undefined && isModuleAccount(d);
  });
  const notes = notesOf(
    input.notes,
    lines.map((ln) => ln.account.id),
  );
  const curves = new Map(input.curves.map((c) => [c.accountId, c]));
  for (const ln of lines) {
    const account = ln.account;
    const d = input.details.get(account.id) as PositionAccountDetails;
    const vehicle = isVehicle(d);
    const row: ManualPositionRow = {
      id: account.id,
      bank: d.bank,
      bankName: input.institutions.displayName(d.bank, input.lang),
      name: d.name,
      type: account.type,
      currency: account.currency,
      ibanTail: Array.from(d.iban ?? "")
        .slice(-4)
        .join(""),
      balance: ln.contribution,
      asOf: ln.asOf,
      isLiability: ln.isLiability,
      kind: vehicle ? "vehicle" : "manual",
      note: notes.get(account.id) ?? null,
      depreciation: vehicle ? depreciationView(curves.get(account.id)) : null,
    };
    rows.push({ row, size: ln.contribution === null ? 0 : Math.abs(ln.contribution.toFloat()) });
  }
  rows.sort((a, b) => b.size - a.size || codePointCompare(a.row.name, b.row.name));
  return rows.map((r) => r.row);
}
