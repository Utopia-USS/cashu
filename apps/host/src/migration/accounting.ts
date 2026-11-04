import type { GenesisResult } from "@cashu/store/genesis";
import type { SourceCounterEvidence } from "@cashu/store/genesis/verification";
import { MigrationError } from "./contract.js";

const SCHEMAS = new Set([
  "0025_topic_view_sources",
  "0026_thesis_exit_plan_changed_at",
  "0027_alert_tag",
  "0028_sync_outbox",
  "0029_sync_inbound",
  "0030_sync_outbox_post",
]);

export interface MigrationAccounting {
  readonly format: 1;
  readonly schema: string;
  readonly profiles: number;
  readonly events: number;
  readonly ids: number;
  /** Safe ordinal-only counts. The private map and per-profile digest are stored separately. */
  readonly vaults: readonly {
    readonly ordinal: number;
    readonly events: number;
    readonly ids: number;
    readonly logSha256: string;
  }[];
}

const SHA256 = /^[0-9a-f]{64}$/;
const VAULT = /^[0-9a-f]{32}$/;

/**
 * Genesis strict mode checks invalid events and selected counters. Migration cannot silently accept
 * its other counters, including malformed settings, divergent strategy files, missing archives,
 * unscoped rows and JSON values that could lose precision. Refuse every unreviewed counter.
 */
export function accountGenesis(
  result: GenesisResult,
  evidence?: SourceCounterEvidence,
): MigrationAccounting {
  if (!SCHEMAS.has(result.schema) || result.report.schema !== result.schema) {
    throw new MigrationError("unsupported_schema");
  }
  if (evidence && (evidence.format !== 1 || evidence.vaults.length !== result.vaults.length)) {
    throw new MigrationError("semantic_difference");
  }
  for (const [table, reasons] of Object.entries(result.report.counters.global)) {
    for (const [reason, count] of Object.entries(reasons)) {
      const allowed = reason === "json_float" ? (evidence?.jsonFloat[table] ?? 0) : 0;
      if (!Number.isSafeInteger(count) || count < 0 || count !== allowed) {
        throw new MigrationError("semantic_difference");
      }
    }
  }
  for (const [ordinalText, tables] of Object.entries(result.report.counters.vaults)) {
    const ordinal = Number(ordinalText);
    const audited = evidence?.vaults[ordinal];
    if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= result.vaults.length) {
      throw new MigrationError("semantic_difference");
    }
    for (const [table, reasons] of Object.entries(tables)) {
      for (const [reason, count] of Object.entries(reasons)) {
        const allowed =
          audited?.ordinal === ordinal && table === "accounts" && reason === "iban_invalid"
            ? audited.ibanInvalid
            : audited?.ordinal === ordinal &&
                table === "research_notes" &&
                reason === "dangling_details.watchlist_item_id"
              ? audited.danglingWatchlistDetails
              : audited?.ordinal === ordinal &&
                  table === "inv_instruments" &&
                  reason === "instrument_orphan"
                ? audited.instrumentOrphan
                : audited?.ordinal === ordinal && table === "inv_transactions"
                  ? (audited.investment[reason] ?? 0)
                  : 0;
        if (!Number.isSafeInteger(count) || count < 0 || count !== allowed) {
          throw new MigrationError("semantic_difference");
        }
      }
    }
  }
  if (evidence) {
    for (const [table, expected] of Object.entries(evidence.jsonFloat)) {
      if (
        !Number.isSafeInteger(expected) ||
        expected < 0 ||
        (result.report.counters.global[table]?.json_float ?? 0) !== expected
      ) {
        throw new MigrationError("semantic_difference");
      }
    }
    for (const vault of evidence.vaults) {
      if (
        !Number.isSafeInteger(vault.ordinal) ||
        vault.ordinal < 0 ||
        vault.ordinal >= result.vaults.length ||
        !Number.isSafeInteger(vault.ibanInvalid) ||
        !Number.isSafeInteger(vault.instrumentOrphan) ||
        vault.ibanInvalid < 0 ||
        vault.instrumentOrphan < 0 ||
        !Number.isSafeInteger(vault.danglingWatchlistDetails) ||
        vault.danglingWatchlistDetails < 0 ||
        (result.report.counters.vaults[String(vault.ordinal)]?.accounts?.iban_invalid ?? 0) !==
          vault.ibanInvalid ||
        (result.report.counters.vaults[String(vault.ordinal)]?.inv_instruments?.instrument_orphan ??
          0) !== vault.instrumentOrphan ||
        (result.report.counters.vaults[String(vault.ordinal)]?.research_notes?.[
          "dangling_details.watchlist_item_id"
        ] ?? 0) !== vault.danglingWatchlistDetails
      ) {
        throw new MigrationError("semantic_difference");
      }
      for (const [reason, count] of Object.entries(vault.investment)) {
        if (
          !Number.isSafeInteger(count) ||
          count < 0 ||
          (result.report.counters.vaults[String(vault.ordinal)]?.inv_transactions?.[reason] ??
            0) !== count
        ) {
          throw new MigrationError("semantic_difference");
        }
      }
    }
  }
  if (result.vaults.length === 0 || result.report.vaults.length !== result.vaults.length) {
    throw new MigrationError("mapping_invalid");
  }
  const profiles = new Set<number>();
  const slugs = new Set<string>();
  const vaultIds = new Set<string>();
  let eventCount = 0;
  let idCount = 0;
  const vaults = result.vaults.map((vault, ordinal) => {
    const report = result.report.vaults[ordinal];
    if (
      vault.ordinal !== ordinal ||
      report?.ordinal !== ordinal ||
      !Number.isSafeInteger(vault.profileId) ||
      vault.profileId <= 0 ||
      !vault.slug ||
      !VAULT.test(vault.vault) ||
      !SHA256.test(vault.logSha256) ||
      profiles.has(vault.profileId) ||
      slugs.has(vault.slug) ||
      vaultIds.has(vault.vault) ||
      report.events !== vault.events.length ||
      vault.lines.length !== vault.events.length ||
      Object.values(report.byType).reduce((sum, count) => sum + count, 0) !== vault.events.length
    ) {
      throw new MigrationError("mapping_invalid");
    }
    profiles.add(vault.profileId);
    slugs.add(vault.slug);
    vaultIds.add(vault.vault);
    const keys = new Set<string>();
    const gids = new Set<string>();
    for (const id of vault.ids) {
      const key = `${id.table}\0${id.localId}`;
      if (!id.table || !id.localId || !id.gid || keys.has(key) || gids.has(id.gid)) {
        throw new MigrationError("mapping_invalid");
      }
      keys.add(key);
      gids.add(id.gid);
    }
    eventCount += vault.events.length;
    idCount += vault.ids.length;
    return {
      ordinal,
      events: vault.events.length,
      ids: vault.ids.length,
      logSha256: vault.logSha256,
    };
  });
  return {
    format: 1,
    schema: result.schema,
    profiles: profiles.size,
    events: eventCount,
    ids: idCount,
    vaults,
  };
}
