import { isValidIban } from "../../events/v1/identity.js";
import type { SqlDriver } from "../../sql/driver.js";
import { isJsonObject, rowIdOf } from "../idFields.js";
import type { GenesisResult } from "../index.js";
import { ROUNDTRIP_COLUMNS } from "./columns.js";
import { auditGlobalInstruments } from "./sourceGlobal.js";
import { auditSourceInvHashes } from "./sourceInvHashes.js";

export class SourceCounterError extends Error {
  constructor() {
    super("source_counter_mismatch");
    this.name = "SourceCounterError";
  }
}

/** Only counters with an independently checked source meaning. Others remain strict refusals. */
export interface SourceCounterEvidence {
  readonly format: 1;
  readonly jsonFloat: Readonly<Record<string, number>>;
  readonly vaults: readonly {
    readonly ordinal: number;
    readonly ibanInvalid: number;
    readonly instrumentOrphan: number;
    readonly danglingWatchlistDetails: number;
    readonly investment: Readonly<Record<string, number>>;
  }[];
}

const NUMBER_TOKEN = /"(?:[^"\\]|\\.)*"|-?\d+(\.\d+)?([eE][+-]?\d+)?/g;
const TABLE = /^[a-z][a-z0-9_]*$/;
const COLUMN = /^[a-z][a-z0-9_]*$/;

function jsonFractions(raw: unknown): number {
  if (raw === null) return 0;
  if (typeof raw !== "string") throw new SourceCounterError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SourceCounterError();
  }
  if (parsed === null) return 0;
  let count = 0;
  for (let token = NUMBER_TOKEN.exec(raw); token !== null; token = NUMBER_TOKEN.exec(raw)) {
    if (token[0].startsWith('"')) continue;
    if (token[1] !== undefined || token[2] !== undefined) count++;
  }
  NUMBER_TOKEN.lastIndex = 0;
  return count;
}

/** Read JSON number tokens and account IBANs again from the frozen SQLite source. */
export function auditSourceSuccessCounters(
  driver: SqlDriver,
  result: GenesisResult,
): SourceCounterEvidence {
  const jsonFloat: Record<string, number> = {};
  for (const table of Object.keys(ROUNDTRIP_COLUMNS)) {
    if (!TABLE.test(table)) throw new SourceCounterError();
    const jsonColumns = driver
      .prepare(`PRAGMA table_info("${table}")`)
      .all<{ name: string; type: string }>()
      .filter((column) => column.type.toUpperCase() === "JSON")
      .map((column) => column.name);
    let count = 0;
    for (const column of jsonColumns) {
      if (!COLUMN.test(column)) throw new SourceCounterError();
      const rows = driver
        .prepare(`SELECT "${column}" AS value FROM "${table}"`)
        .all<{ value: unknown }>();
      for (const row of rows) count += jsonFractions(row.value);
    }
    if (!Number.isSafeInteger(count)) throw new SourceCounterError();
    if (count > 0) jsonFloat[table] = count;
  }
  const global = auditGlobalInstruments(driver, result);
  const investment = auditSourceInvHashes(driver, result);
  const watchlistOwners = new Map(
    driver
      .prepare("SELECT id,profile_id AS profileId FROM watchlist_items")
      .all<{ id: number; profileId: number }>()
      .map((row) => [row.id, row.profileId]),
  );
  const vaults = result.vaults.map((vault) => {
    const accounts = driver
      .prepare("SELECT iban FROM accounts WHERE profile_id=?")
      .all<{ iban: string | null }>(vault.profileId);
    const ibanInvalid = accounts.filter(({ iban }) => iban !== null && !isValidIban(iban)).length;
    const watchlistIds = new Set(
      driver
        .prepare("SELECT id FROM watchlist_items WHERE profile_id=?")
        .all<{ id: number }>(vault.profileId)
        .map((row) => row.id),
    );
    let danglingWatchlistDetails = 0;
    for (const row of driver
      .prepare("SELECT details FROM research_notes WHERE profile_id=?")
      .all<{ details: string | null }>(vault.profileId)) {
      if (row.details === null) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.details);
      } catch {
        throw new SourceCounterError();
      }
      if (!isJsonObject(parsed)) continue;
      const id = rowIdOf(parsed.watchlist_item_id);
      if (id !== undefined && !watchlistIds.has(id)) {
        if (watchlistOwners.has(id)) throw new SourceCounterError();
        danglingWatchlistDetails++;
      }
    }
    const closure = global.vaults[vault.ordinal];
    const hashes = investment[vault.ordinal];
    if (
      !closure ||
      closure.ordinal !== vault.ordinal ||
      !hashes ||
      hashes.ordinal !== vault.ordinal
    )
      throw new SourceCounterError();
    return {
      ordinal: vault.ordinal,
      ibanInvalid,
      instrumentOrphan: closure.omitted,
      danglingWatchlistDetails,
      investment: hashes.counters,
    };
  });
  return { format: 1, jsonFloat, vaults };
}
