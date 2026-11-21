/** Python MCP research._exposure: group already-computed portfolio fractions, never amounts. */
export interface ExposurePosition {
  readonly instrument: string;
  readonly weight: number | null;
  readonly assetClass: string | null;
  readonly region: string | null;
  readonly sector: string | null;
}
export function researchExposure(
  positions: readonly ExposurePosition[],
  ownerNamed: ReadonlySet<string>,
) {
  const groups = {
    asset_class: new Map<string, number>(),
    region: new Map<string, number>(),
    sector: new Map<string, number>(),
  };
  for (const position of positions) {
    if (position.weight === null) continue;
    for (const key of ["asset_class", "region", "sector"] as const) {
      const value =
        key === "asset_class"
          ? position.assetClass
          : ownerNamed.has(position.instrument)
            ? null
            : position[key];
      const name = value || "unclassified",
        bucket = groups[key];
      // Source explicitly accumulates floats in position order, rather than an exact Decimal sum.
      bucket.set(name, (bucket.get(name) ?? 0) + position.weight);
    }
  }
  const rows = (map: ReadonlyMap<string, number>) => [...map].sort((a, b) => b[1] - a[1]);
  return {
    asset_classes: rows(groups.asset_class).map(([asset_class, weight]) => ({
      asset_class,
      weight,
    })),
    regions: rows(groups.region).map(([region, weight]) => ({ region, weight })),
    sectors: rows(groups.sector).map(([sector, weight]) => ({ sector, weight })),
  };
}
