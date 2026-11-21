// The key module's public surface: data key entries and kid derivation (keyEntry.ts), the
// acceptance policy (keyAcceptance.ts), the keyring model (keyring.ts) and the key payload codec
// (keyPayload.ts). Other crypto files import from here.

export { MAX_KEYS_PER_GENERATION } from "./keyAcceptance.js";
export {
  type KeyEntry,
  type KeyMaterial,
  KID_BYTES,
  MAX_EPOCH,
  MAX_GENERATION,
} from "./keyEntry.js";
export { decodeKeyPayload, encodeKeyPayload, mergeKeyPayload } from "./keyPayload.js";
export {
  assertVaultId,
  createKeyring,
  createVaultId,
  emptyLike,
  GID_SALT_BYTES,
  Keyring,
  rotateKeyring,
  type VaultInfo,
} from "./keyring.js";
