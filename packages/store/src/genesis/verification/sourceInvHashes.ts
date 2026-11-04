import { detGidFor, type VaultSalt } from "../../gid.js";
import type { SqlDriver } from "../../sql/driver.js";
import type { GenesisResult, GenesisVault } from "../index.js";
import { type InstrumentRef, invHashes } from "../invHashes.js";
import { GenesisCounters } from "../report.js";
import { readPythonSource } from "../source.js";

export class SourceInvHashError extends Error {
  constructor() {
    super("source_investment_hash_mismatch");
    this.name = "SourceInvHashError";
  }
}

const VERIFIED_SUCCESS = [
  "ikey_broker",
  "ikey_isin_alias",
  "ikey_isin_col",
  "ikey_gid",
  "occ_v1_match",
  "recon_match",
] as const;

export interface SourceInvHashEvidence {
  readonly ordinal: number;
  readonly counters: Readonly<Record<(typeof VERIFIED_SUCCESS)[number], number>>;
  /** Private exact source-local-ID to expected native hash; never include in public status. */
  readonly hashes: ReadonlyMap<
    string,
    {
      readonly gid: string;
      readonly hash: string;
      readonly accountGid: string;
      readonly manual: boolean;
    }
  >;
}

function gidMap(vault: GenesisVault, table: string): Map<string, string> {
  return new Map(
    vault.ids.filter((entry) => entry.table === table).map((entry) => [entry.localId, entry.gid]),
  );
}

/**
 * Re-read raw investment rows and recompute every v1 occurrence and v2 hash from the frozen
 * source. This is independent of the exported event list. The replay verifier separately compares
 * these hashes to the actual native table after applying the canonical log.
 */
export function auditSourceInvHashes(
  driver: SqlDriver,
  result: GenesisResult,
): readonly SourceInvHashEvidence[] {
  try {
    const counters = new GenesisCounters();
    const source = readPythonSource(driver, { read: () => undefined, list: () => [] }, counters);
    return result.vaults.map((vault) => {
      const accounts = source.accounts.filter((row) => row.profileId === vault.profileId);
      const accountIds = new Set(accounts.map((row) => row.id));
      const accountGids = gidMap(vault, "accounts");
      const instrumentGids = gidMap(vault, "inv_instruments");
      const batchIds = new Set(
        source.invImportBatches.filter((row) => accountIds.has(row.accountId)).map((row) => row.id),
      );
      const batches = new Map(
        source.invImportBatches
          .filter((row) => batchIds.has(row.id))
          .map((row) => [row.id, row] as const),
      );
      const instruments = new Map<number, InstrumentRef>();
      for (const row of source.invInstruments) {
        const gid = instrumentGids.get(String(row.id));
        if (!gid) continue;
        instruments.set(row.id, {
          gid,
          isin: row.isin,
          aliases: source.invInstrumentAliases
            .filter((alias) => alias.instrumentId === row.id)
            .sort((a, b) => a.id - b.id),
        });
      }
      const rows = source.invTransactions.filter((row) => accountIds.has(row.accountId));
      const mapped = gidMap(vault, "inv_transactions");
      if (mapped.size !== rows.length) throw new SourceInvHashError();
      const computed = invHashes(
        {
          rows,
          accountGid: (id) => accountGids.get(String(id)),
          batches,
          instruments,
          missingInstrumentGid: () => {
            throw new SourceInvHashError();
          },
        },
        counters,
        vault.ordinal,
      );
      const hashes = new Map<
        string,
        {
          readonly gid: string;
          readonly hash: string;
          readonly accountGid: string;
          readonly manual: boolean;
        }
      >();
      for (const row of rows) {
        const localId = String(row.id);
        const gid = mapped.get(localId);
        const accountGid = accountGids.get(String(row.accountId));
        const hash =
          row.source === "manual" ? (gid ? `manual:${gid}` : undefined) : computed.get(row.id);
        if (!gid || !hash || !accountGid) throw new SourceInvHashError();
        hashes.set(localId, { gid, hash, accountGid, manual: row.source === "manual" });
      }
      const counts = Object.fromEntries(
        VERIFIED_SUCCESS.map((reason) => [
          reason,
          counters.get("inv_transactions", reason, vault.ordinal),
        ]),
      ) as Record<(typeof VERIFIED_SUCCESS)[number], number>;
      return { ordinal: vault.ordinal, counters: counts, hashes };
    });
  } catch {
    throw new SourceInvHashError();
  }
}

/** The source ID map must use the deterministic genesis key, even for an unreferenced row. */
export function verifySourceInvGids(evidence: SourceInvHashEvidence, salt: VaultSalt): void {
  const det = detGidFor(salt);
  for (const [localId, row] of evidence.hashes) {
    const expected = row.manual
      ? det("genesis", ["inv_transactions", localId])
      : det("inv_transactions", [row.accountGid, row.hash]);
    if (row.gid !== expected) throw new SourceInvHashError();
  }
}

/** Exact membership and hash equality of real replay rows, including manual and reconciliation. */
export function verifyReplayInvHashes(
  replay: readonly { readonly gid: string; readonly dedupHash: string }[],
  evidence: SourceInvHashEvidence,
): void {
  const expected = new Map([...evidence.hashes.values()].map((entry) => [entry.gid, entry.hash]));
  if (expected.size !== evidence.hashes.size || replay.length !== expected.size) {
    throw new SourceInvHashError();
  }
  const seen = new Set<string>();
  for (const row of replay) {
    if (seen.has(row.gid) || expected.get(row.gid) !== row.dedupHash) {
      throw new SourceInvHashError();
    }
    seen.add(row.gid);
  }
}
