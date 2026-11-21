// Data key entries: every data key is used only through two subkeys (keyed BLAKE2b-256 with
// distinct contexts): the frame key (XChaCha20-Poly1305) and the kid key (key id PRF). The raw key
// is used for nothing else. The key id is computed from the key, the vault id, the generation and
// the epoch, so a key can never be relabelled.

import { concat, lengthPrefixed, toHex, u32, utf8 } from "./encoding.js";
import { CryptoError } from "./errors.js";
import { Secret } from "./secret.js";
import { KEY_BYTES, type Sodium } from "./sodium.js";

export const KID_BYTES = 16;
/**
 * Generations go up to 2^31 - 1 (u32 on the wire): at one generation per signed wrap, a device that
 * floods the ring cannot exhaust rotation (and so revocation) in any practical time. Epochs count
 * revocation events and stay bounded at 2^20.
 */
export const MAX_GENERATION = 2_147_483_647;
export const MAX_EPOCH = 1_048_576;
const KID_CONTEXT = utf8("cashu/kid/v2");
const FRAME_SUBKEY_CONTEXT = utf8("cashu/subkey/frame/v2");
const KID_SUBKEY_CONTEXT = utf8("cashu/subkey/kid/v2");

export function inBounds(generation: number, epoch: number): boolean {
  return (
    Number.isInteger(generation) &&
    generation >= 1 &&
    generation <= MAX_GENERATION &&
    Number.isInteger(epoch) &&
    epoch >= 0 &&
    epoch <= MAX_EPOCH
  );
}

export interface KeyEntry {
  /** Always computed from the key, the vault id, the generation and the epoch. */
  readonly kid: string;
  readonly generation: number;
  readonly epoch: number;
  /** The raw data key; only the subkeys below are ever used with a primitive. */
  readonly key: Secret;
  /** XChaCha20-Poly1305 key for frames. */
  readonly frameKey: Secret;
}

/** Key material as it travels (payload) or is created: the kid is never part of it. */
export interface KeyMaterial {
  generation: number;
  epoch: number;
  key: Uint8Array;
}

function subkey(sodium: Sodium, key: Uint8Array, context: Uint8Array): Uint8Array {
  return sodium.hash(KEY_BYTES, context, key);
}

/** kid = hex(BLAKE2b-128(key = kidKey, "cashu/kid/v2" | lp(vaultId) | u32 generation | u32 epoch)). */
function computeKid(
  sodium: Sodium,
  key: Uint8Array,
  vaultId: string,
  generation: number,
  epoch: number,
): string {
  const kidKey = subkey(sodium, key, KID_SUBKEY_CONTEXT);
  try {
    const message = concat(KID_CONTEXT, lengthPrefixed(utf8(vaultId)), u32(generation), u32(epoch));
    return toHex(sodium.hash(KID_BYTES, message, kidKey));
  } finally {
    kidKey.fill(0);
  }
}

/** Builds an entry; takes ownership of `key`. */
export function makeEntry(sodium: Sodium, vaultId: string, material: KeyMaterial): KeyEntry {
  const { generation, epoch, key } = material;
  if (!inBounds(generation, epoch) || key.length !== KEY_BYTES)
    throw new CryptoError("bad_payload");
  return {
    kid: computeKid(sodium, key, vaultId, generation, epoch),
    generation,
    epoch,
    key: new Secret(key),
    frameKey: new Secret(subkey(sodium, key, FRAME_SUBKEY_CONTEXT)),
  };
}
