// Synthetic two-profile Python data dir for the end-to-end genesis tests (S26 spec 10
// `genesis.test.ts`): the database (rows in genesisSeed.ts) plus budget.json, strategy files, an
// import archive and a staged proposal file, and the vault keys of both profiles. Synthetic only.
import { vaultSalt } from "../../gid.js";
import type { SqlDriver } from "../../sql/driver.js";
import { TEST_SALT, TEST_VAULT } from "../../testing/store.js";
import type { VaultKeys } from "../ids.js";
import type { GenesisFiles } from "../source.js";
import { ARCHIVE, ARCHIVE_SHA, STAGED, STAGED_SHA, STRATEGY_YAML, seedAll } from "./genesisSeed.js";
import { PythonRows } from "./pythonRows.js";
import { pythonDb } from "./pythonSchema.js";

const utf8 = new TextEncoder();

/** The keys of the two profiles: vault 0 uses the store test vault and salt (fast test stores). */
export const KEYS: ReadonlyMap<string, VaultKeys> = new Map([
  ["anna", { vault: TEST_VAULT, salt: TEST_SALT }],
  [
    "piotr",
    {
      vault: "7".repeat(32),
      salt: vaultSalt(Uint8Array.from({ length: 32 }, (_, i) => 200 - i)),
    },
  ],
]);

export const NOW = Date.UTC(2026, 9, 31);

/** An in-memory `GenesisFiles` over path -> bytes. */
export function memoryFiles(entries: Iterable<readonly [string, Uint8Array]>): GenesisFiles {
  const files = new Map(entries);
  return {
    read: (rel) => files.get(rel),
    list: (dir) =>
      [...files.keys()]
        .filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes("/"))
        .map((p) => p.slice(dir.length + 1))
        .sort(),
  };
}

export const FILES = memoryFiles([
  [`imports/anna/${ARCHIVE_SHA}.CSV`, ARCHIVE],
  [`imports/anna/.proposals/${STAGED_SHA}-0123456789ab.csv`, STAGED],
  ["profiles/anna/strategy.yaml", utf8.encode(STRATEGY_YAML)],
  [
    "profiles/anna/budget.json",
    utf8.encode(
      '{"cushion": {"enabled": true, "currency": " pln ", "target_amount": 5000.5, "account_ids": [1, 99, 1]}, "x": 1}',
    ),
  ],
]);

/** A Python database at `schema` with the two synthetic profiles. */
export function seededDb(schema: "0025" | "0026" | "0029" = "0026"): SqlDriver {
  const driver = pythonDb(schema);
  seedAll(new PythonRows(driver), schema);
  return driver;
}
