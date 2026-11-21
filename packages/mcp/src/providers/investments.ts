import { pyCasefold, pyStrip } from "@cashu/domain";
import type { NameSources } from "../privacy/names.js";
import { pyIsDigit } from "../privacy/pyText.js";
export interface InvestmentNameRow {
  readonly inProfile: boolean;
  readonly own: {
    readonly name: string;
    readonly symbol: string | null;
    readonly assetClass: string;
    readonly valuationMode: string;
    readonly isin: string | null;
  };
  readonly shared: {
    readonly name: string;
    readonly symbol: string | null;
    readonly isin: string | null;
  };
  readonly overrideName: string | null;
}
export function ownerNamed(row: InvestmentNameRow["own"]): boolean {
  return (
    row.assetClass === "claim" ||
    row.assetClass === "other" ||
    (row.valuationMode === "manual" && !row.isin)
  );
}
/** Overrides decide private identity; protect shared and owner labels of private instruments. */
export function investmentNameSources(rows: readonly InvestmentNameRow[]): NameSources {
  const persons = new Set<string>();
  const strictAliases: [string, string][] = [];
  const knownSymbols = new Set<string>();
  for (const row of rows) {
    const privateName = ownerNamed(row.own);
    if (row.inProfile) {
      if (privateName) {
        for (const label of [row.own.name, row.own.symbol, row.shared.name, row.shared.symbol])
          if (label) persons.add(label);
      } else if (row.own.symbol && pyIsDigit(row.own.symbol)) knownSymbols.add(row.own.symbol);
    }
    if (!privateName && row.overrideName) {
      const publicName = row.shared.name || row.shared.symbol || row.shared.isin || "instrument";
      const alias = pyStrip(row.overrideName);
      if (alias && pyCasefold(alias) !== pyCasefold(publicName))
        strictAliases.push([alias, publicName]);
    }
  }
  return { persons, strongNames: persons, privatePayees: [], strictAliases, knownSymbols };
}
