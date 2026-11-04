/** Test-only entry for exact synthetic OS KeyStore namespaces. Never import from a production entry. */
export type { OsKeyringDeletePort, OsKeyringPort } from "./keyring/native.js";
export {
  createTestKeyStore,
  createTestMigrationKek,
  type TestKeyStoreInput,
} from "./keyring/production.js";
