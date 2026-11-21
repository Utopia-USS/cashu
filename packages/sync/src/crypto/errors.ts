// Errors carry a fixed code and a fixed message: never key bytes, plaintext, ids of a wrong key or
// recovery words, so an error that reaches a log cannot leak a secret.

const ALL_CODES = [
  "truncated",
  "unsupported_version",
  "unknown_key",
  "auth_failed",
  "vault_mismatch",
  "recovery_key_mismatch",
  "gid_salt_mismatch",
  "generation_gap",
  "epoch_gap",
  "keystore_corrupt",
  "untrusted_sender",
  "key_not_allowed",
  "bad_padding",
  "frame_too_large",
  "bad_payload",
  "bad_mnemonic",
  "bad_key_name",
  "keystore_unavailable",
  "wiped",
  "unsupported_runtime",
] as const;

export type CryptoErrorCode = (typeof ALL_CODES)[number];

const MESSAGES: Record<CryptoErrorCode, string> = {
  truncated: "encrypted data is truncated",
  unsupported_version: "encrypted data has an unsupported format version",
  unknown_key: "encrypted data uses a key this device does not hold",
  auth_failed: "encrypted data failed authentication (wrong key, wrong context or tampered)",
  vault_mismatch: "wrapped keys belong to a different vault",
  recovery_key_mismatch: "wrapped keys name a different recovery key than this vault",
  gid_salt_mismatch: "wrapped keys carry a different gid salt than this vault",
  generation_gap: "wrapped keys skip a key generation; earlier keys are missing",
  epoch_gap: "wrapped keys skip a revocation epoch",
  keystore_corrupt: "a stored key could not be decrypted with this device's storage key",
  untrusted_sender: "wrapped keys come from a sender this device does not trust",
  key_not_allowed: "encrypted data uses a key not allowed for its writer",
  bad_padding: "decrypted data has invalid padding",
  frame_too_large: "encrypted data exceeds the maximum frame size",
  bad_payload: "wrapped key payload is malformed",
  bad_mnemonic: "recovery key is not a valid 24-word phrase",
  bad_key_name: "key store name is not allowed",
  keystore_unavailable: "secure key storage is not available on this device",
  wiped: "secret was already wiped",
  unsupported_runtime: "the crypto runtime lacks a required primitive",
};

export class CryptoError extends Error {
  readonly code: CryptoErrorCode;

  constructor(code: CryptoErrorCode) {
    super(MESSAGES[code]);
    this.name = "CryptoError";
    this.code = code;
  }
}
