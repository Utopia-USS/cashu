import { createHash } from "node:crypto";
import { join } from "node:path";
import { openNodeSqlite } from "@cashu/node-host/sqlite";
import {
  builtinModules,
  canonicalJson,
  detGidFor,
  type SqlDriver,
  Store,
  viewHash,
} from "@cashu/store";
import * as genesis from "@cashu/store/genesis";
import {
  assertCompleteSourcePartition,
  assertSourceSchemaCoverage,
  auditGlobalInstruments,
  auditSourceInvHashes,
  auditSourceSuccessCounters,
  compareUtf8,
  dumps,
  GidKeys,
  type GidRow,
  projectSourceEntries,
  projectView,
  ROUNDTRIP_COLUMNS,
  verifyDeviceLocalSource,
  verifyReplayInvHashes,
  verifySourceCacheReceipt,
  verifySourceInvGids,
} from "@cashu/store/genesis/verification";
import { accountGenesis } from "./accounting.js";
import { MigrationError } from "./contract.js";
import { filesOf, type StrictConversion } from "./convert.js";
import { assertPrivateStagingSeal, assertSameSource, sealPythonSource } from "./sourceSeal.js";

const VERIFIED = new Set(Object.keys(ROUNDTRIP_COLUMNS));

export interface SemanticReplayProof {
  readonly format: 1;
  readonly profiles: number;
  readonly tables: number;
  readonly rows: number;
  /** Ephemeral one-day SSE invalidation history omitted from the fresh vault. */
  readonly excludedChangeEvents: number;
  readonly sourceCache: {
    readonly sha256: string;
    readonly bytes: number;
    readonly priceBars: number;
    readonly fxRates: number;
    readonly macroBars: number;
  };
  /** Only digests and counts leave the private verifier. */
  readonly vaults: readonly {
    readonly ordinal: number;
    readonly viewHash: string;
    readonly semanticHash: string;
    readonly deviceLocalHash: string;
    readonly notifications: number;
    readonly connectorFetch: number;
  }[];
}

const utf8Order = compareUtf8;
function digestRows(rows: readonly GidRow[]): string {
  const keyed = rows
    .map(({ gid, row }) => [gid, row] as const)
    .sort((a, b) => compareUtf8(a[0], b[0]));
  return createHash("sha256").update(dumps(keyed)).digest("hex");
}

function replayVault(
  vault: genesis.GenesisVault,
  key: genesis.VaultKeys,
  source: SqlDriver,
  asOf: string,
  invHashes: ReturnType<typeof auditSourceInvHashes>[number],
  files: genesis.GenesisFiles,
): { readonly viewHash: string; readonly semanticHash: string; readonly rows: number } {
  if (key.vault !== vault.vault || vault.lines.length !== vault.events.length) {
    throw new MigrationError("mapping_invalid");
  }
  const logDigest = createHash("sha256").update(vault.lines.join(""), "utf8").digest("hex");
  if (logDigest !== vault.logSha256) throw new MigrationError("replay_mismatch");
  const parsed = vault.lines.map((line) => {
    if (!line.endsWith("\n")) throw new MigrationError("replay_mismatch");
    const event: unknown = JSON.parse(line);
    if (`${canonicalJson(event)}\n` !== line) throw new MigrationError("replay_mismatch");
    return event as genesis.GenesisVault["events"][number];
  });
  const store = Store.open({
    driver: openNodeSqlite(":memory:"),
    vault: vault.vault,
    salt: key.salt,
    modules: builtinModules(),
  });
  try {
    for (let i = 0; i < parsed.length; i += genesis.GENESIS_CHUNK) {
      const result = store.applyWire({
        device: vault.device,
        events: parsed.slice(i, i + genesis.GENESIS_CHUNK),
      });
      if (
        result.parked ||
        result.suppressed ||
        result.rejected.length ||
        result.conflicts.length ||
        result.needsUpgrade
      ) {
        throw new MigrationError("replay_mismatch");
      }
    }
    if (
      store.needsUpgrade() ||
      store.read<{ n: number }>("SELECT COUNT(*) AS n FROM unknown_events")[0]?.n !== 0 ||
      store.read<{ n: number }>("SELECT COUNT(*) AS n FROM account_conflicts")[0]?.n !== 0
    ) {
      throw new MigrationError("replay_mismatch");
    }
    verifySourceInvGids(invHashes, key.salt);
    verifyReplayInvHashes(
      store.read<{ gid: string; dedupHash: string }>(
        "SELECT gid, dedup_hash AS dedupHash FROM inv_transactions",
      ),
      invHashes,
    );
    const ids = new Map(vault.ids.map((entry) => [`${entry.table}\0${entry.localId}`, entry.gid]));
    const keys = new GidKeys(
      {
        det: detGidFor(key.salt),
        sources: new Map(
          vault.ids.map((entry) => [entry.gid, { table: entry.table, localId: entry.localId }]),
        ),
      },
      {
        key: (table, id) => {
          const gid = ids.get(`${table}\0${id}`);
          if (!gid) throw new MigrationError("mapping_invalid");
          return gid;
        },
        prefix: (table) => table,
      },
    );
    const hashes: string[] = [];
    let rows = 0;
    for (const table of [...VERIFIED].sort(utf8Order)) {
      const def = store.publicTables().find((item) => item.name === table);
      if (!def) throw new MigrationError("replay_mismatch");
      const expected = projectSourceEntries(
        source,
        table,
        def,
        vault.profileId,
        vault.ids,
        asOf,
        files,
        detGidFor(key.salt),
      );
      const actual = projectView(store, table, keys, asOf);
      const equal = digestRows(expected) === digestRows(actual);
      if (expected.length !== actual.length || !equal) {
        throw new MigrationError("replay_mismatch");
      }
      rows += actual.length;
      hashes.push(`${table}:${digestRows(actual)}`);
    }
    return {
      viewHash: viewHash(store).hash,
      semanticHash: createHash("sha256").update(hashes.join("\n")).digest("hex"),
      rows,
    };
  } finally {
    store.close();
  }
}

/**
 * Independent mapped-table proof: parse actual canonical log lines, recompute their hash, replay
 * into a fresh view, then hash source fields and replayed fields separately by exact row gid.
 * Unmapped auxiliary/device-local state refuses. The one-shot importer separately reopens encrypted
 * vault logs and exact device-local rows before publishing the native inventory.
 */
export function verifyStrictCoreReplay(
  conversion: StrictConversion,
  keys: ReadonlyMap<string, genesis.VaultKeys>,
): SemanticReplayProof {
  try {
    assertSameSource(conversion.snapshot, sealPythonSource(conversion.snapshot.root));
    assertPrivateStagingSeal(conversion.snapshot);
    const db = openNodeSqlite(join(conversion.snapshot.root, "cashu.db"), { readOnly: true });
    try {
      accountGenesis(conversion.genesis, auditSourceSuccessCounters(db, conversion.genesis));
      assertCompleteSourcePartition(db, conversion.genesis, new Set(keys.keys()));
      verifySourceCacheReceipt(db, conversion.cacheReceipt);
      assertSourceSchemaCoverage(db, conversion.genesis.schema);
      // Schema coverage is the sole source-table classifier for both conversion and verification.
      const excludedChangeEvents =
        db.prepare("SELECT COUNT(*) AS n FROM change_events").get<{ n: number }>()?.n ?? 0;
      auditGlobalInstruments(db, conversion.genesis);
      const investment = auditSourceInvHashes(db, conversion.genesis);
      const vaults = conversion.genesis.vaults.map((vault) => {
        const key = keys.get(vault.slug);
        if (!key) throw new MigrationError("mapping_invalid");
        const deviceLocal = verifyDeviceLocalSource(db, vault);
        const invHashes = investment[vault.ordinal];
        if (!invHashes || invHashes.ordinal !== vault.ordinal) {
          throw new MigrationError("mapping_invalid");
        }
        const sealedFiles = filesOf(conversion.snapshot.root, conversion.snapshot);
        const profileFiles: genesis.GenesisFiles = {
          read(relative) {
            return relative.startsWith(`imports/${vault.slug}/`)
              ? sealedFiles.read(relative)
              : undefined;
          },
          list: sealedFiles.list,
        };
        return {
          ordinal: vault.ordinal,
          ...replayVault(vault, key, db, conversion.asOf, invHashes, profileFiles),
          deviceLocalHash: deviceLocal.digest,
          notifications: deviceLocal.notifications,
          connectorFetch: deviceLocal.connectorFetch,
        };
      });
      assertSameSource(conversion.snapshot, sealPythonSource(conversion.snapshot.root));
      return {
        format: 1,
        profiles: vaults.length,
        tables: vaults.length * VERIFIED.size,
        rows: vaults.reduce((n, v) => n + v.rows, 0),
        excludedChangeEvents,
        sourceCache: {
          sha256: conversion.cacheReceipt.digest,
          bytes: conversion.cacheReceipt.bytes,
          priceBars: conversion.cacheReceipt.priceBars,
          fxRates: conversion.cacheReceipt.fxRates,
          macroBars: conversion.cacheReceipt.macroBars,
        },
        vaults: vaults.map(
          ({
            ordinal,
            viewHash,
            semanticHash,
            deviceLocalHash,
            notifications,
            connectorFetch,
          }) => ({
            ordinal,
            viewHash,
            semanticHash,
            deviceLocalHash,
            notifications,
            connectorFetch,
          }),
        ),
      };
    } finally {
      db.close();
    }
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    throw new MigrationError("replay_mismatch");
  }
}
