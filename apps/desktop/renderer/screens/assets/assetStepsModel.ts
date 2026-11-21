// The assets first steps' data (ab24ab6 modules/assets/Steps.tsx assetStepItems): the two statuses from the rows
// (ui-logic assetSteps, unchanged) and the figures of the done hints, formatted here so the steps view stays pure.
import { assetSteps, type Depreciation, monthlyLoss, ratePct } from "@cashu/ui-logic/assets/logic";
import { cur0s } from "@cashu/ui-logic/core/format";

/** A native asset row as far as the steps read it (useAssetDrawer `rows`). */
export interface AssetStepRow {
  name: string;
  type: string;
  kind: string;
  currency: string;
  amount: { toFloat(): number } | null;
  depreciation: {
    purchasePrice: { toFloat(): number };
    purchaseDate: string;
    annualRate: { toFloat(): number };
    floor: { toFloat(): number } | null;
  } | null;
}

export interface AssetStepsModel {
  position: "done" | "on";
  vehicle: "done" | "todo";
  /** Positions counted in `positionsDone`. */
  count: number;
  /** "545 000 zł · 12 000 €" (base currency first, never summed across currencies). */
  totals: string;
  /** The vehicles with a curve: name, yearly decline ("15"), monthly loss ("1 234 zł"). */
  vehicles: { name: string; rate: string; loss: string }[];
}

/** The old fraction-rate terms (native annualRate is a percent). */
const oldTerms = (d: NonNullable<AssetStepRow["depreciation"]>): Depreciation => ({
  purchase_price: d.purchasePrice.toFloat(),
  purchase_date: d.purchaseDate,
  annual_rate: d.annualRate.toFloat() / 100,
  floor: d.floor?.toFloat() ?? null,
});

export function assetStepsModel(rows: readonly AssetStepRow[], totals: string): AssetStepsModel {
  const old = rows.map((r) => ({
    ...r,
    depreciation: r.depreciation === null ? null : oldTerms(r.depreciation),
  }));
  const st = assetSteps(old);
  const vehicles = old.filter(
    (r) => (r.kind === "vehicle" || r.type === "vehicle") && r.depreciation,
  );
  return {
    position: st.position,
    vehicle: st.vehicle,
    count: rows.length,
    totals,
    vehicles: vehicles.map((v) => ({
      name: v.name,
      rate: ratePct(v.depreciation?.annual_rate ?? 0),
      loss: cur0s(monthlyLoss(v.amount?.toFloat(), v.depreciation) ?? 0, v.currency),
    })),
  };
}
