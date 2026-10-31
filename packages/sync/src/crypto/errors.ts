// Errors carry a fixed code and a fixed message: never key bytes, plaintext, ids of a wrong key or
// recovery words, so an error that reaches a log cannot leak a secret.

export type CryptoErrorCode =
  | "truncated"
  | "unsupported_version"
  | "unknown_key"
  | "auth_failed"
  | "vault_mismatch"
  | "bad_payload"
  | "bad_mnemonic"
  | "bad_key_name"
  | "keystore_unavailable"
  | "wiped"
  | "unsupported_runtime";

const MESSAGES: Record<CryptoErrorCode, string> = {
  truncated: "encrypted data is truncated",
  unsupported_version: "encrypted data has an unsupported format version",
  unknown_key: "encrypted data uses a key this device does not hold",
  auth_failed: "encrypted data failed authentication (wrong key, wrong context or tampered)",
  vault_mismatch: "wrapped keys belong to a different vault",
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
