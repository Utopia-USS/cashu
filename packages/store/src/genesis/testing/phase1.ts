// Phase-1 test harness (S26 spec 10): a synthetic Python database read, scoped and run through
// `vaultIds` per profile with fixed test keys. Synthetic only.
import { vaultSalt } from "../../gid.js";
import type { SqlDriver } from "../../sql/driver.js";
import { type VaultIds, vaultIds } from "../ids.js";
import { GenesisCounters } from "../report.js";
import {
  type GenesisFiles,
  type PythonSource,
  readPythonSource,
  scopeProfiles,
} from "../source.js";

/** gid.md 8: the fixed test salt `00 01 .. 1f`. */
const TEST_SALT = vaultSalt(Uint8Array.from({ length: 32 }, (_, i) => i));
export const TEST_VAULT = "0123456789abcdef0123456789abcdef";

export const NO_FILES: GenesisFiles = { read: () => undefined, list: () => [] };

export interface Phase1 {
  readonly source: PythonSource;
  readonly counters: GenesisCounters;
  /** Phase 1 of every profile (by ordinal); vault n > 0 gets a salt and vault id of its own. */
  readonly vaults: readonly VaultIds[];
}

export function phase1(driver: SqlDriver, files: GenesisFiles = NO_FILES): Phase1 {
  const counters = new GenesisCounters();
  const source = readPythonSource(driver, files, counters);
  const vaults = scopeProfiles(source, counters).map((scope, ordinal) =>
    vaultIds(
      scope,
      { instruments: source.invInstruments, aliases: source.invInstrumentAliases },
      ordinal === 0
        ? { vault: TEST_VAULT, salt: TEST_SALT }
        : {
            vault: String(ordinal).padStart(32, "0"),
            salt: vaultSalt(Uint8Array.from({ length: 32 }, (_, i) => (i + 7 * ordinal) % 256)),
          },
      ordinal,
      counters,
    ),
  );
  return { source, counters, vaults };
}

/** The gid of a row, failing loudly when phase 1 did not export it. */
export function gidOf(
  vault: VaultIds | undefined,
  table: string,
  localId: string | number,
): string {
  const gid = vault?.resolver.gid(table, String(localId));
  if (gid === undefined) throw new Error(`no gid for ${table} ${localId}`);
  return gid;
}
