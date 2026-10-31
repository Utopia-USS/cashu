// Per-profile data keys. A profile is a vault: one random vault id (opaque, never the profile slug,
// so a relay or a synced folder learns nothing from it) and a keyring of data keys. Each key has a
// generation (1, 2, ...) and a key id derived from the key itself; the highest generation encrypts,
// every held key still decrypts older frames. Rotation adds a generation; it never drops one.

import { concat, fromUtf8, lengthPrefixed, Reader, toHex, u32, utf8 } from "./encoding.js";
import { CryptoError } from "./errors.js";
import { Secret } from "./secret.js";
import { KEY_BYTES, type Sodium } from "./sodium.js";

export const KID_BYTES = 16;
const KID_CONTEXT = utf8("cashu/kid/v1");
const PAYLOAD_MAGIC = utf8("cashu/keys/v1");
const MAX_KEYS = 1024;
const VAULT_ID = /^[0-9a-f]{32}$/;
const INSPECT = Symbol.for("nodejs.util.inspect.custom");

export interface KeyEntry {
  readonly kid: string;
  readonly generation: number;
  readonly key: Secret;
}

/**
 * Key id = BLAKE2b-128 keyed by the data key over a fixed context: stable across devices, checks
 * itself on unwrap, and reveals nothing about the key (a PRF output, not a hash of the key).
 */
export function keyId(sodium: Sodium, key: Secret): string {
  return toHex(sodium.hash(KID_BYTES, KID_CONTEXT, key.expose()));
}

export function createVaultId(sodium: Sodium): string {
  return toHex(sodium.randomBytes(16));
}

export function assertVaultId(vaultId: string): void {
  if (!VAULT_ID.test(vaultId)) throw new RangeError("vault id must be 32 lowercase hex characters");
}

export class Keyring {
  readonly vaultId: string;
  #entries = new Map<string, KeyEntry>();

  constructor(vaultId: string, entries: Iterable<KeyEntry> = []) {
    assertVaultId(vaultId);
    this.vaultId = vaultId;
    for (const e of entries) this.add(e);
  }

  /**
   * The key new frames are encrypted with: highest generation; two devices that rotated
   * concurrently produce the same generation, so the larger key id breaks the tie on every device.
   */
  get active(): KeyEntry {
    let best: KeyEntry | undefined;
    for (const e of this.#entries.values()) {
      if (
        !best ||
        e.generation > best.generation ||
        (e.generation === best.generation && e.kid > best.kid)
      ) {
        best = e;
      }
    }
    if (!best) throw new CryptoError("unknown_key");
    return best;
  }

  get size(): number {
    return this.#entries.size;
  }

  get(kid: string): KeyEntry | undefined {
    return this.#entries.get(kid);
  }

  /** Oldest generation first. */
  entries(): KeyEntry[] {
    return [...this.#entries.values()].sort(
      (a, b) => a.generation - b.generation || (a.kid < b.kid ? -1 : 1),
    );
  }

  /** Union by key id: re-adding a held key is a no-op, so merging rings from two devices commutes. */
  add(entry: KeyEntry): void {
    if (!this.#entries.has(entry.kid)) this.#entries.set(entry.kid, entry);
  }

  merge(other: Keyring): void {
    if (other.vaultId !== this.vaultId) throw new CryptoError("vault_mismatch");
    for (const e of other.entries()) this.add(e);
  }

  wipe(): void {
    for (const e of this.#entries.values()) e.key.wipe();
    this.#entries.clear();
  }

  toJSON(): { vaultId: string; keys: { kid: string; generation: number }[] } {
    return {
      vaultId: this.vaultId,
      keys: this.entries().map(({ kid, generation }) => ({ kid, generation })),
    };
  }

  [INSPECT](): string {
    return `Keyring(${this.vaultId}, ${this.#entries.size} keys)`;
  }
}

function entryFor(sodium: Sodium, generation: number, keyBytes: Uint8Array): KeyEntry {
  const key = new Secret(keyBytes);
  return { kid: keyId(sodium, key), generation, key };
}

/** A new vault for a profile: fresh vault id (unless given) and a generation-1 data key. */
export function createKeyring(sodium: Sodium, vaultId: string = createVaultId(sodium)): Keyring {
  return new Keyring(vaultId, [entryFor(sodium, 1, sodium.randomBytes(KEY_BYTES))]);
}

/**
 * Adds a fresh key one generation above the newest and returns it; it becomes `active`. Revoking a
 * device is a rotation whose new key is wrapped only for the devices that remain (S29).
 */
export function rotateKeyring(sodium: Sodium, ring: Keyring): KeyEntry {
  const entry = entryFor(sodium, ring.active.generation + 1, sodium.randomBytes(KEY_BYTES));
  ring.add(entry);
  return entry;
}

/**
 * Binary key payload: magic | vault id | count | (generation, key)*. It is the plaintext of a
 * pairing / recovery wrap and the value kept in a KeyStore. Key ids are not on the wire; the reader
 * recomputes them. The caller wipes the returned bytes once sealed or stored.
 */
export function encodeKeyPayload(ring: Keyring, kids?: readonly string[]): Uint8Array {
  const chosen = kids ? kids.map((kid) => ring.get(kid) ?? missing()) : ring.entries();
  if (chosen.length === 0 || chosen.length > MAX_KEYS) throw new CryptoError("bad_payload");
  const count = new Uint8Array(2);
  new DataView(count.buffer).setUint16(0, chosen.length);
  return concat(
    PAYLOAD_MAGIC,
    lengthPrefixed(utf8(ring.vaultId)),
    count,
    ...chosen.flatMap((e) => [u32(e.generation), e.key.expose()]),
  );
}

function missing(): never {
  throw new CryptoError("unknown_key");
}

/** Parses a key payload; `expectedVaultId` rejects keys meant for another vault (profile). */
export function decodeKeyPayload(
  sodium: Sodium,
  payload: Uint8Array,
  expectedVaultId?: string,
): Keyring {
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
  if (expectedVaultId !== undefined && vaultId !== expectedVaultId)
    throw new CryptoError("vault_mismatch");
  const count = r.u16();
  if (count === 0 || count > MAX_KEYS) throw new CryptoError("bad_payload");
  const entries: KeyEntry[] = [];
  for (let i = 0; i < count; i++) {
    const generation = r.u32();
    if (generation === 0) throw new CryptoError("bad_payload");
    // Copy: the caller wipes the payload buffer, the ring keeps its own bytes.
    entries.push(entryFor(sodium, generation, r.take(KEY_BYTES).slice()));
  }
  r.end();
  return new Keyring(vaultId, entries);
}
