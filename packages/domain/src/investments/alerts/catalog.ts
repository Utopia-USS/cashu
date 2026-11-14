/** Ordered static catalog of the eleven alert kinds; metadata matches the Python catalog. */
import { CATALOG_DATA } from "./catalogData.js";
import type { AlertKind, KindInfo } from "./types.js";

export const CATALOG: ReadonlyMap<AlertKind, KindInfo> = new Map(
  CATALOG_DATA.map((info) => [info.kind, info]),
);
export function catalogDicts(): readonly KindInfo[] {
  return [...CATALOG.values()];
}
