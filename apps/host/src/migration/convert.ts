import { createHash } from "node:crypto";
import { closeSync, constants, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openNodeSqlite } from "@cashu/node-host/sqlite";
import * as genesis from "@cashu/store/genesis";
import {
  assertCompleteSourcePartition,
  assertSourceSchemaCoverage,
  auditGlobalInstruments,
  auditSourceSuccessCounters,
  captureSourceCacheReceipt,
  type SourceCacheProof,
  verifyDeviceLocalSource,
} from "@cashu/store/genesis/verification";
import { accountGenesis, type MigrationAccounting } from "./accounting.js";
import { MigrationError } from "./contract.js";
import {
  assertPrivateStagingSeal,
  assertSameSource,
  type SourceSeal,
  sealPythonSource,
} from "./sourceSeal.js";

export interface StrictConversion {
  /** Private source identity. Never send paths or profile metadata to a renderer status. */
  readonly snapshot: SourceSeal;
  readonly genesis: genesis.GenesisResult;
  readonly accounting: MigrationAccounting;
  /** Private plaintext until the production preparation authority encrypts and seals it. */
  readonly cacheReceipt: SourceCacheProof;
  /** Frozen verifier day for effective alert status, derived from conversion time. */
  readonly asOf: string;
}

export function filesOf(root: string, seal: SourceSeal): genesis.GenesisFiles {
  const entries = new Map(seal.entries.map((entry) => [entry.path, entry]));
  const prefix = (dir: string) => `${dir}/`;
  return {
    read(relative) {
      const expected = entries.get(relative);
      if (!expected) return undefined;
      const fd = openSync(join(root, relative), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const bytes = readFileSync(fd);
        if (
          bytes.length !== expected.bytes ||
          createHash("sha256").update(bytes).digest("hex") !== expected.sha256
        )
          throw new MigrationError("source_changed");
        return bytes;
      } finally {
        closeSync(fd);
      }
    },
    list(dir) {
      const names = new Set<string>();
      for (const path of entries.keys()) {
        if (!path.startsWith(prefix(dir))) continue;
        const rest = path.slice(prefix(dir).length);
        if (!rest.includes("/")) names.add(rest);
      }
      return [...names].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    },
  };
}

/**
 * Strict native conversion of a private, already frozen canonical SQLite snapshot.
 * The importer supplies vault IDs/salts; this function never mints recovery keys.
 * It reads no original source path and never invokes Python.
 */
export function convertStrictGenesis(
  snapshotRoot: string,
  keys: ReadonlyMap<string, genesis.VaultKeys>,
  now: number,
): StrictConversion {
  try {
    const before = sealPythonSource(snapshotRoot);
    assertPrivateStagingSeal(before);
    if (
      before.entries.some((entry) => entry.path === "cashu.db-wal" || entry.path === "cashu.db-shm")
    ) {
      throw new MigrationError("snapshot_unverified");
    }
    const driver = openNodeSqlite(join(snapshotRoot, "cashu.db"), { readOnly: true });
    let result: genesis.GenesisResult;
    let cacheReceipt: SourceCacheProof;
    let accounting: MigrationAccounting;
    try {
      result = genesis.genesis({ driver, files: filesOf(snapshotRoot, before) }, keys, {
        strict: true,
        now,
      });
      assertCompleteSourcePartition(driver, result, new Set(keys.keys()));
      assertSourceSchemaCoverage(driver, result.schema);
      cacheReceipt = captureSourceCacheReceipt(driver, result.schema);
      for (const vault of result.vaults) verifyDeviceLocalSource(driver, vault);
      auditGlobalInstruments(driver, result);
      accounting = accountGenesis(result, auditSourceSuccessCounters(driver, result));
    } finally {
      driver.close();
    }
    assertSameSource(before, sealPythonSource(snapshotRoot));
    return {
      snapshot: before,
      genesis: result,
      accounting,
      cacheReceipt,
      asOf: new Date(now).toISOString().slice(0, 10),
    };
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    if (error instanceof genesis.GenesisError && error.code === "unsupported_schema") {
      throw new MigrationError("unsupported_schema");
    }
    throw new MigrationError("semantic_difference");
  }
}
