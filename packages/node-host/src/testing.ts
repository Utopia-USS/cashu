/** Test-only entry for exact synthetic OS KeyStore namespaces. Never import from a production entry. */
export type { OsKeyringPort } from "./keyring/native.js";
export { createTestKeyStore, type TestKeyStoreInput } from "./keyring/production.js";
