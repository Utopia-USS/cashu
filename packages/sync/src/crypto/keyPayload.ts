// Key payload v3: the plaintext of a wrap and the value kept in a KeyStore.

import { concat, fromUtf8, lengthPrefixed, Reader, u32, utf8 } from "./encoding.js";
import { CryptoError } from "./errors.js";
import { MAX_KEYS } from "./keyAcceptance.js";
import { inBounds, type KeyMaterial } from "./keyEntry.js";
import { assertVaultId, decodedRing, GID_SALT_BYTES, type Keyring } from "./keyring.js";
import { KEY_BYTES, PUBLIC_KEY_BYTES, type Sodium } from "./sodium.js";

const PAYLOAD_MAGIC = utf8("cashu/keys/v3");
/** u32 generation | u32 epoch | 32-byte key. */
const ENTRY_BYTES = 4 + 4 + KEY_BYTES;

/**
 * Binary key payload v3:
 *   "cashu/keys/v3" | lp(vault id) | recovery box pk (32) | recovery sign pk (32) | gid salt (32) | u32 count |
 *   (u32 generation | u32 epoch | 32-byte key)*
 * It is the plaintext of a wrap and the value kept in a KeyStore. Key ids are not on the wire; the
 * reader recomputes them. The caller wipes the returned bytes once sealed or stored.
 */
export function encodeKeyPayload(ring: Keyring, kids?: readonly string[]): Uint8Array {
  const chosen = kids ? kids.map((kid) => ring.get(kid) ?? missing()) : ring.entries();
  if (chosen.length === 0 || chosen.length > MAX_KEYS) throw new CryptoError("bad_payload");
  const { boxPublicKey, signPublicKey } = ring.recovery;
  const gidSalt = ring.gidSalt();
  try {
    const head = concat(
      PAYLOAD_MAGIC,
      lengthPrefixed(utf8(ring.vaultId)),
      boxPublicKey,
      signPublicKey,
      gidSalt.expose(),
      u32(chosen.length),
    );
    // Written key by key into one buffer: no argument spread, so a ring of any accepted size encodes.
    const out = new Uint8Array(head.length + chosen.length * ENTRY_BYTES);
    out.set(head, 0);
    const view = new DataView(out.buffer);
    let at = head.length;
    for (const e of chosen) {
      view.setUint32(at, e.generation);
      view.setUint32(at + 4, e.epoch);
      out.set(e.key.expose(), at + 8);
      at += ENTRY_BYTES;
    }
    return out;
  } finally {
    gidSalt.wipe();
  }
}

function missing(): never {
  throw new CryptoError("unknown_key");
}

/**
 * Parses a key payload into an unchecked ring. Callers never use it directly: they `merge` it into
 * a ring (or into an `emptyLike`) so the acceptance policy applies (`mergeKeyPayload`).
 */
export function decodeKeyPayload(sodium: Sodium, payload: Uint8Array): Keyring {
  const r = new Reader(payload);
  const magic = r.take(PAYLOAD_MAGIC.length);
  if (!magic.every((b, i) => b === PAYLOAD_MAGIC[i])) throw new CryptoError("bad_payload");
  let vaultId: string;
  try {
    vaultId = fromUtf8(r.lengthPrefixed(64));
    assertVaultId(vaultId);
  } catch {
    throw new CryptoError("bad_payload");
  }
  const recovery = {
    boxPublicKey: r.take(PUBLIC_KEY_BYTES).slice(),
    signPublicKey: r.take(PUBLIC_KEY_BYTES).slice(),
  };
  const gidSalt = r.take(GID_SALT_BYTES).slice();
  const count = r.u32();
  if (count === 0 || count > MAX_KEYS) throw new CryptoError("bad_payload");
  const keys: KeyMaterial[] = [];
  for (let i = 0; i < count; i++) {
    const generation = r.u32();
    const epoch = r.u32();
    if (!inBounds(generation, epoch)) throw new CryptoError("bad_payload");
    // Copy: the caller wipes the payload buffer, the ring keeps its own bytes.
    keys.push({ generation, epoch, key: r.take(KEY_BYTES).slice() });
  }
  r.end();
  try {
    return decodedRing(sodium, { vaultId, recovery, gidSalt }, keys);
  } finally {
    gidSalt.fill(0);
  }
}

/** Decodes a payload and merges it into `target` under the acceptance policy (all or nothing). */
export function mergeKeyPayload(sodium: Sodium, payload: Uint8Array, target: Keyring): void {
  const incoming = decodeKeyPayload(sodium, payload);
  try {
    target.merge(incoming);
  } finally {
    incoming.wipe();
  }
}
