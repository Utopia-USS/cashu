// The store's SQLite on the phone: expo-sqlite's synchronous API behind the store's expo adapter, so
// the store engine runs in-process on the JS thread (cashu-ts-architecture layers.md, "Which process
// runs what"). One database file per vault in the app's private documents directory, which iOS keeps
// under its default data protection (complete until first user authentication), the same class as the
// Keychain item of the KeyStore (AFTER_FIRST_UNLOCK) so background sync can read both while locked.
import { builtinModules, expoSqliteDriver, Store, type VaultSalt } from "@cashu/store";
import { openDatabaseSync } from "expo-sqlite";

const fileName = (vault: string) => `vault-${vault}.db`;

/** Open (or create) the store of `vault`. The store sets WAL + synchronous NORMAL itself. */
export function openVaultStore(vault: string, salt: VaultSalt): Store {
  return Store.open({
    driver: expoSqliteDriver(openDatabaseSync(fileName(vault))),
    vault,
    salt,
    modules: builtinModules(),
  });
}
