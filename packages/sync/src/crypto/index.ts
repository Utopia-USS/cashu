export { CryptoError, type CryptoErrorCode } from "./errors.js";
export {
  FRAME_OVERHEAD,
  FRAME_VERSION,
  type FrameContext,
  frameKeyId,
  openFrame,
  sealFrame,
} from "./frame.js";
export {
  assertVaultId,
  createKeyring,
  createVaultId,
  type KeyEntry,
  Keyring,
  keyId,
  rotateKeyring,
} from "./keys.js";
export {
  type BlobFiles,
  createSafeStorageKeyStore,
  createSecureStoreKeyStore,
  deviceKeyName,
  InMemoryKeyStore,
  type KeyStore,
  keyringName,
  loadDeviceKeyPair,
  loadKeyring,
  type SafeStorageLike,
  type SecureStoreLike,
  saveDeviceKeyPair,
  saveKeyring,
} from "./keystore.js";
export {
  createRecoveryKey,
  type NewRecoveryKey,
  normalizePhrase,
  RECOVERY_WORDS,
  recoveryKeyPair,
} from "./recovery.js";
export { Secret } from "./secret.js";
export { fromLibsodium, type LibsodiumLike, loadNodeSodium, type Sodium } from "./sodium.js";
export { BoxKeyPair, createDeviceKeyPair, unwrapKeys, wrapKeys } from "./wrap.js";
