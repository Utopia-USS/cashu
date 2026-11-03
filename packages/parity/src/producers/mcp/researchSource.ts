/** Bind native research composition to copied, genesis-folded vault facts and real cached market rows. */

import { type MacroCloses, USDPLN } from "@cashu/domain/investments/macro";
import { type NativeToolStore, researchServices, type ToolContext } from "@cashu/mcp";
import type { InvFxRateRow } from "../../sources/investments.ts";
import type { PythonDb } from "../../sources/pythonDb.ts";
import { nativeViewSources } from "../investments/viewSource.ts";

/** Python macro.closes adds the stored NBP PLN-per-USD history, not a market-result projection. */
export function researchMacroCloses(
  closes: MacroCloses,
  rates: readonly InvFxRateRow[],
  asOf: string,
): MacroCloses {
  const usd = rates
    .filter((row) => row.base === "PLN" && row.quote === "USD" && row.date <= asOf)
    .map((row): readonly [string, number] => [row.date, Number(row.rate)])
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return usd.length === 0 ? closes : { ...closes, [USDPLN]: usd };
}

export function bindResearchReads(
  db: PythonDb,
  profileId: number,
  context: ToolContext<NativeToolStore>,
) {
  const source = nativeViewSources(db).find((row) => row.profile.id === profileId);
  if (source === undefined) throw new Error("missing native research source");
  return researchServices(context, {
    portfolio: { ...source.request, lang: "pl" },
    macroCloses: researchMacroCloses(source.macroCloses, db.investments.fxRates(), db.asOf),
    isHolder: () => false,
  });
}
