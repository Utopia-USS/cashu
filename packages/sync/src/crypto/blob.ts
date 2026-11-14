// Vault blob format 1. The ring's raw data key is used only to derive a distinct blob subkey.
// blob = 0x01 | kid (16) | nonce (24) | XChaCha20-Poly1305(padded content, AAD)
// AAD = "cashu/blob/v1" | 0x01 | kid | lp(vault id) | SHA-256(content) | lp(extension)
// padded content = u32 length | content | zero bytes up to Padme(length + 4).

import { sha256 } from "@noble/hashes/sha2.js";
import { concat, fromHex, lengthPrefixed, toHex, u32, utf8 } from "./encoding.js";
import { CryptoError } from "./errors.js";
import { padme } from "./frame.js";
import { assertVaultId, type Keyring, KID_BYTES } from "./keys.js";
import { KEY_BYTES, NONCE_BYTES, type Sodium, TAG_BYTES } from "./sodium.js";

export const BLOB_VERSION = 1;
export const MAX_BLOB_PLAINTEXT = 64 * 1024 * 1024;
export const BLOB_HEADER_BYTES = 1 + KID_BYTES + NONCE_BYTES;
const LENGTH_BYTES = 4;
const CONTEXT = utf8("cashu/blob/v1");
const SUBKEY_CONTEXT = utf8("cashu/subkey/blob/v1");
const SHA_RE = /^[0-9a-f]{64}$/;
const EXT_RE = /^[a-z0-9]{1,10}$/;

export interface BlobRef {
  readonly sha256: string;
  readonly ext: string;
}

export function blobSize(length: number): number {
  if (!Number.isInteger(length) || length < 0 || length > MAX_BLOB_PLAINTEXT)
    throw new CryptoError("bad_payload");
  return BLOB_HEADER_BYTES + TAG_BYTES + padme(length + LENGTH_BYTES);
}

function reference(ref: BlobRef): Uint8Array {
  if (!SHA_RE.test(ref.sha256) || !EXT_RE.test(ref.ext)) throw new CryptoError("bad_payload");
  return fromHex(ref.sha256);
}

function aad(kid: Uint8Array, vaultId: string, digest: Uint8Array, ext: string): Uint8Array {
  assertVaultId(vaultId);
  return concat(
    CONTEXT,
    Uint8Array.of(BLOB_VERSION),
    kid,
    lengthPrefixed(utf8(vaultId)),
    digest,
    lengthPrefixed(utf8(ext)),
  );
}

function sameDigest(bytes: Uint8Array, digest: Uint8Array): boolean {
  const computed = sha256(bytes);
  let difference = 0;
  for (let i = 0; i < computed.length; i++) difference |= (computed[i] ?? 0) ^ (digest[i] ?? 0);
  return difference === 0;
}

/** Encrypt with the current ring key. The caller owns the content and its content-addressed ref. */
export function sealBlob(
  sodium: Sodium,
  ring: Keyring,
  vaultId: string,
  ref: BlobRef,
  content: Uint8Array,
): Uint8Array {
  return sealBlobWithNonce(sodium, ring, vaultId, ref, content, sodium.randomBytes(NONCE_BYTES));
}

/** Deterministic nonce seam for portable golden vectors. Production calls sealBlob. */
export function sealBlobWithNonce(
  sodium: Sodium,
  ring: Keyring,
  vaultId: string,
  ref: BlobRef,
  content: Uint8Array,
  nonce: Uint8Array,
): Uint8Array {
  if (vaultId !== ring.vaultId) throw new CryptoError("vault_mismatch");
  if (nonce.length !== NONCE_BYTES || content.length === 0 || content.length > MAX_BLOB_PLAINTEXT)
    throw new CryptoError("bad_payload");
  const digest = reference(ref);
  if (!sameDigest(content, digest)) throw new CryptoError("bad_payload");
  const entry = ring.active;
  const kid = fromHex(entry.kid);
  const key = sodium.hash(KEY_BYTES, SUBKEY_CONTEXT, entry.key.expose());
  const padded = new Uint8Array(padme(content.length + LENGTH_BYTES));
  padded.set(u32(content.length));
  padded.set(content, LENGTH_BYTES);
  try {
    const cipher = sodium.aeadEncrypt(padded, aad(kid, vaultId, digest, ref.ext), nonce, key);
    return concat(Uint8Array.of(BLOB_VERSION), kid, nonce, cipher);
  } finally {
    key.fill(0);
    padded.fill(0);
  }
}

/** Open with the kid's retained epoch, strict padding, and an independently checked content hash. */
export function openBlob(
  sodium: Sodium,
  ring: Keyring,
  vaultId: string,
  ref: BlobRef,
  sealed: Uint8Array,
): Uint8Array {
  if (vaultId !== ring.vaultId) throw new CryptoError("vault_mismatch");
  const digest = reference(ref);
  if (sealed.length < blobSize(1) || sealed.length > blobSize(MAX_BLOB_PLAINTEXT))
    throw new CryptoError("bad_payload");
  if (sealed[0] !== BLOB_VERSION) throw new CryptoError("unsupported_version");
  const kid = sealed.subarray(1, 1 + KID_BYTES);
  const entry = ring.get(toHex(kid));
  if (!entry) throw new CryptoError("unknown_key");
  const nonce = sealed.subarray(1 + KID_BYTES, BLOB_HEADER_BYTES);
  const cipher = sealed.subarray(BLOB_HEADER_BYTES);
  const key = sodium.hash(KEY_BYTES, SUBKEY_CONTEXT, entry.key.expose());
  let padded: Uint8Array;
  try {
    padded = sodium.aeadDecrypt(cipher, aad(kid, vaultId, digest, ref.ext), nonce, key);
  } finally {
    key.fill(0);
  }
  try {
    if (padded.length < LENGTH_BYTES) throw new CryptoError("bad_padding");
    const length = new DataView(padded.buffer, padded.byteOffset, LENGTH_BYTES).getUint32(0);
    if (
      length === 0 ||
      length > MAX_BLOB_PLAINTEXT ||
      padded.length !== padme(length + LENGTH_BYTES)
    )
      throw new CryptoError("bad_padding");
    for (let i = LENGTH_BYTES + length; i < padded.length; i++) {
      if (padded[i] !== 0) throw new CryptoError("bad_padding");
    }
    const content = padded.slice(LENGTH_BYTES, LENGTH_BYTES + length);
    if (!sameDigest(content, digest)) {
      content.fill(0);
      throw new CryptoError("auth_failed");
    }
    return content;
  } finally {
    padded.fill(0);
  }
}
