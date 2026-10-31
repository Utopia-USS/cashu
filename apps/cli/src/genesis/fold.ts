// `--fold`: applies a vault's genesis log to a fresh file-backed store (`view.sqlite`) in
// `GENESIS_CHUNK` chunks and asserts the store-level invariants of S26 spec 8.4: nothing parked,
// rejected or suppressed, no identity conflicts, no reader behind the writer, no account conflicts.

import { writeFileSync } from "node:fs";
import { betterSqlite3Driver, builtinModules, genesis, Store, viewHash } from "@cashu/store";
import Database from "better-sqlite3";

/** A fold invariant failed (exit 65); the message carries counts only. */
export class FoldError extends Error {
  readonly exitCode = 65;

  constructor(message: string) {
    super(message);
    this.name = "FoldError";
  }
}

/** Folds `vault` into a new store at `path`; returns the view hash (sha256 hex). */
export function foldVault(
  path: string,
  vault: genesis.GenesisVault,
  keys: genesis.VaultKeys,
): string {
  // Created empty and private first: SQLite keeps the mode of an existing file.
  writeFileSync(path, "", { mode: 0o600, flag: "wx" });
  const store = Store.open({
    driver: betterSqlite3Driver(new Database(path)),
    vault: vault.vault,
    salt: keys.salt,
    modules: builtinModules(),
  });
  try {
    for (let i = 0; i < vault.events.length; i += genesis.GENESIS_CHUNK) {
      const r = store.applyWire({
        device: vault.device,
        events: vault.events.slice(i, i + genesis.GENESIS_CHUNK),
      });
      const broken = [
        r.parked > 0 ? `parked ${r.parked}` : "",
        r.suppressed > 0 ? `suppressed ${r.suppressed}` : "",
        r.rejected.length > 0 ? `rejected ${r.rejected.length}` : "",
        r.conflicts.length > 0 ? `conflicts ${r.conflicts.length}` : "",
        r.needsUpgrade ? "needs upgrade" : "",
      ].filter((s) => s !== "");
      if (broken.length > 0) {
        throw new FoldError(`vault ${vault.ordinal}: fold invariants failed: ${broken.join(", ")}`);
      }
    }
    if (store.needsUpgrade())
      throw new FoldError(`vault ${vault.ordinal}: the store needs an upgrade`);
    const accountConflicts =
      store.read<{ n: number }>("SELECT COUNT(*) AS n FROM account_conflicts")[0]?.n ?? 0;
    if (accountConflicts > 0) {
      throw new FoldError(`vault ${vault.ordinal}: account conflicts ${accountConflicts}`);
    }
    return viewHash(store).hash;
  } finally {
    store.close();
  }
}
