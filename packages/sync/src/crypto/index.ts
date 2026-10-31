export { CryptoError, type CryptoErrorCode } from "./errors.js";
export {
  FRAME_OVERHEAD,
  FRAME_VERSION,
  type FrameContext,
  type FramePolicy,
  frameKeyId,
  frameSize,
  MAX_FRAME_PLAINTEXT,
  openFrame,
  padme,
  sealFrame,
} from "./frame.js";
export {
  assertDeviceId,
  BoxKeyPair,
  createDeviceId,
  createDeviceIdentity,
  DeviceIdentity,
  isDeviceId,
  RECOVERY_SIGNER_ID,
  RecoveryIdentity,
  type RecoveryPublicKeys,
  type WrapRecipient,
} from "./identity.js";
export {
  assertVaultId,
  createKeyring,
  createVaultId,
  GID_SALT_BYTES,
  type KeyEntry,
  type KeyMaterial,
  Keyring,
  MAX_EPOCH,
  MAX_GENERATION,
  rotateKeyring,
  type VaultInfo,
} from "./keys.js";
export {
  type BlobFiles,
  createSafeStorageKeyStore,
  createSecureStoreKeyStore,
  deviceIdentityName,
  type KeyStore,
  keyringName,
  loadDeviceIdentity,
  loadKeyring,
  type SafeStorageLike,
  type SecureStoreLike,
  saveDeviceIdentity,
  saveKeyring,
} from "./keystore.js";
export {
  createRecoveryKey,
  type NewRecoveryKey,
  normalizePhrase,
  RECOVERY_WORDS,
  recoveryIdentity,
} from "./recovery.js";
export { Secret } from "./secret.js";
export { fromLibsodium, type LibsodiumLike, loadNodeSodium, type Sodium } from "./sodium.js";
export {
  openPairingWrap,
  recoveryRecipient,
  sealForPairing,
  type TrustedSigner,
  unwrapKeys,
  WRAP_VERSION,
  wrapKeys,
} from "./wrap.js";
