import type { SqlDriver } from "../../sql/driver.js";
import type { GenesisResult } from "../index.js";
import { sourceInstrumentIds } from "./sourceProject.js";

export interface GlobalInstrumentAudit {
  readonly format: 1;
  readonly sourceInstruments: number;
  readonly sourceAliases: number;
  readonly unreferencedInstruments: number;
  readonly unreferencedAliases: number;
  readonly vaults: readonly {
    readonly ordinal: number;
    readonly instruments: number;
    readonly aliases: number;
    readonly omitted: number;
  }[];
}

export class GlobalInstrumentAuditError extends Error {
  constructor() {
    super("global_instrument_mismatch");
    this.name = "GlobalInstrumentAuditError";
  }
}

function exactMap(
  ids: GenesisResult["vaults"][number]["ids"],
  table: string,
  selected: ReadonlySet<number>,
): void {
  const mapped = ids.filter((entry) => entry.table === table);
  if (
    mapped.length !== selected.size ||
    mapped.some((entry) => {
      const id = Number(entry.localId);
      return (
        !Number.isSafeInteger(id) || id <= 0 || String(id) !== entry.localId || !selected.has(id)
      );
    })
  ) {
    throw new GlobalInstrumentAuditError();
  }
}

/**
 * Independently account for the globally stored Python catalog and each vault's relational
 * closure. Counts alone are not authority: exact numeric map membership is required, and a truly
 * unreferenced catalog instrument must be retained in device-local source catalog storage.
 */
export function auditGlobalInstruments(
  driver: SqlDriver,
  result: GenesisResult,
): GlobalInstrumentAudit {
  const instruments = driver
    .prepare("SELECT id FROM inv_instruments ORDER BY id")
    .all<{ id: number }>();
  const aliases = driver
    .prepare("SELECT id, instrument_id FROM inv_instrument_aliases ORDER BY id")
    .all<{ id: number; instrument_id: number }>();
  const instrumentIds = new Set(instruments.map((row) => row.id));
  if (instrumentIds.size !== instruments.length) throw new GlobalInstrumentAuditError();
  if (aliases.some((alias) => !instrumentIds.has(alias.instrument_id))) {
    throw new GlobalInstrumentAuditError();
  }
  const referenced = new Set<number>();
  const vaults = result.vaults.map((vault) => {
    const closure = sourceInstrumentIds(driver, vault.profileId);
    for (const id of closure) {
      if (!instrumentIds.has(id)) throw new GlobalInstrumentAuditError();
      referenced.add(id);
    }
    const selectedAliases = new Set(
      aliases.filter((alias) => closure.has(alias.instrument_id)).map((alias) => alias.id),
    );
    exactMap(vault.ids, "inv_instruments", closure);
    exactMap(vault.ids, "inv_instrument_aliases", selectedAliases);
    return {
      ordinal: vault.ordinal,
      instruments: closure.size,
      aliases: selectedAliases.size,
      omitted: instruments.length - closure.size,
    };
  });
  return {
    format: 1,
    sourceInstruments: instruments.length,
    sourceAliases: aliases.length,
    unreferencedInstruments: instruments.length - referenced.size,
    unreferencedAliases: aliases.filter((alias) => !referenced.has(alias.instrument_id)).length,
    vaults,
  };
}
