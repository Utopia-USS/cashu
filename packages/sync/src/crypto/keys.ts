// Per-profile data keys. A profile is a vault: one random vault id (opaque, never the profile slug,
// so a relay or a synced folder learns nothing from it), the pinned recovery public keys and a
// keyring of data keys. Each key has a generation (1, 2, ...), an epoch (how many device
// revocations its creator had applied) and a key id computed from the key and that metadata.
// The highest (generation, epoch, kid) encrypts; every held key still decrypts older frames.
// Rotation adds a generation; it never drops one.
//
// Every data key is used only through two subkeys (keyed BLAKE2b-256 with distinct contexts):
// the frame key (XChaCha20-Poly1305) and the kid key (key id PRF). The raw key is used for nothing else.

import { concat, fromUtf8, lengthPrefixed, Reader, toHex, u32, utf8 } from "./encoding.js";
import { CryptoError } from "./errors.js";
import type { RecoveryPublicKeys } from "./identity.js";
import { Secret } from "./secret.js";
import { KEY_BYTES, PUBLIC_KEY_BYTES, type Sodium } from "./sodium.js";

export const KID_BYTES = 16;
export const GID_SALT_BYTES = 32;
/** Upper bound for generations and epochs (2^20): far above any real use, far below u32 overflow. */
export const MAX_GENERATION = 1_048_576;
export const MAX_EPOCH = 1_048_576;
const KID_CONTEXT = utf8("cashu/kid/v2");
const FRAME_SUBKEY_CONTEXT = utf8("cashu/subkey/frame/v2");
const KID_SUBKEY_CONTEXT = utf8("cashu/subkey/kid/v2");
const PAYLOAD_MAGIC = utf8("cashu/keys/v2");
const MAX_KEYS = 1024;
const VAULT_ID = /^[0-9a-f]{32}$/;
const INSPECT = Symbol.for("nodejs.util.inspect.custom");
const INTERNAL = Symbol("keyring-internal");

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

/** What identifies a vault across devices; carried in every key payload. */
export interface VaultInfo {
  vaultId: string;
  recovery: RecoveryPublicKeys;
  /** Per-vault salt for deterministic gids (HMAC-SHA256 key); never rotated. */
  gidSalt: Uint8Array;
}

/** Key material as it travels (payload) or is created: the kid is never part of it. */
export interface KeyMaterial {
  generation: number;
  epoch: number;
  key: Uint8Array;
}

export function createVaultId(sodium: Sodium): string {
  return toHex(sodium.randomBytes(16));
}

export function assertVaultId(vaultId: string): void {
  if (!VAULT_ID.test(vaultId)) throw new RangeError("vault id must be 32 lowercase hex characters");
}

function inBounds(generation: number, epoch: number): boolean {
  return (
    Number.isInteger(generation) &&
    generation >= 1 &&
    generation <= MAX_GENERATION &&
    Number.isInteger(epoch) &&
    epoch >= 0 &&
    epoch <= MAX_EPOCH
  );
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
function makeEntry(sodium: Sodium, vaultId: string, material: KeyMaterial): KeyEntry {
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

/** Total order of `active`: generation, then epoch, then kid. */
function compareEntries(a: KeyEntry, b: KeyEntry): number {
  return (
    a.generation - b.generation || a.epoch - b.epoch || (a.kid < b.kid ? -1 : a.kid > b.kid ? 1 : 0)
  );
}

function samePublicKeys(a: RecoveryPublicKeys, b: RecoveryPublicKeys): boolean {
  return equalBytes(a.boxPublicKey, b.boxPublicKey) && equalBytes(a.signPublicKey, b.signPublicKey);
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function checkRecovery(recovery: RecoveryPublicKeys): RecoveryPublicKeys {
  if (
    recovery.boxPublicKey.length !== PUBLIC_KEY_BYTES ||
    recovery.signPublicKey.length !== PUBLIC_KEY_BYTES
  ) {
    throw new RangeError("recovery public keys must be 32 bytes each");
  }
  return {
    boxPublicKey: recovery.boxPublicKey.slice(),
    signPublicKey: recovery.signPublicKey.slice(),
  };
}

/**
 * A vault's keys on one device. Built only by `createKeyring`, `rotateKeyring`, `Keyring.fromKeys`
 * and the payload decoder; every key that arrives from outside goes through `merge`, the one
 * acceptance policy (same vault, same recovery key, no generation gap, all-or-nothing).
 */
export class Keyring {
  readonly vaultId: string;
  #recovery: RecoveryPublicKeys;
  #gidSalt: Uint8Array;
  #entries = new Map<string, KeyEntry>();

  /** Not public API: use `createKeyring` or `Keyring.fromKeys`. */
  constructor(token: typeof INTERNAL, vault: VaultInfo) {
    if (token !== INTERNAL) throw new TypeError("use createKeyring or Keyring.fromKeys");
    assertVaultId(vault.vaultId);
    if (vault.gidSalt.length !== GID_SALT_BYTES) throw new RangeError("gid salt must be 32 bytes");
    this.vaultId = vault.vaultId;
    this.#recovery = checkRecovery(vault.recovery);
    this.#gidSalt = vault.gidSalt.slice();
  }

  /**
   * A ring from raw key material (e.g. fixed test keys); kids are computed here, and the keys
   * must satisfy the same acceptance policy as a merge (start at generation 1, no gap).
   */
  static fromKeys(sodium: Sodium, vault: VaultInfo, keys: readonly KeyMaterial[]): Keyring {
    const ring = new Keyring(INTERNAL, vault);
    const incoming = decodedRing(sodium, vault, keys);
    try {
      ring.merge(incoming);
    } finally {
      incoming.wipe();
    }
    return ring;
  }

  /** The recovery public keys pinned for this vault (never read from a plain vault file). */
  get recovery(): RecoveryPublicKeys {
    return checkRecovery(this.#recovery);
  }

  /**
   * The vault's gid salt (key for HMAC-SHA256 deterministic gids), as a fresh copy the caller may
   * wipe. Generated with the vault, never rotated, never derived from a data key.
   */
  gidSalt(): Secret {
    return new Secret(this.#gidSalt.slice());
  }

  /** The key new frames are encrypted with: highest (generation, epoch, kid). */
  get active(): KeyEntry {
    let best: KeyEntry | undefined;
    for (const e of this.#entries.values()) {
      if (!best || compareEntries(e, best) > 0) best = e;
    }
    if (!best) throw new CryptoError("unknown_key");
    return best;
  }

  get size(): number {
    return this.#entries.size;
  }

  get maxGeneration(): number {
    let max = 0;
    for (const e of this.#entries.values()) max = Math.max(max, e.generation);
    return max;
  }

  get(kid: string): KeyEntry | undefined {
    return this.#entries.get(kid);
  }

  /** Ascending (generation, epoch, kid). */
  entries(): KeyEntry[] {
    return [...this.#entries.values()].sort(compareEntries);
  }

  /** An independent copy (own key bytes) of this ring. */
  clone(sodium: Sodium): Keyring {
    return Keyring.fromKeys(
      sodium,
      { vaultId: this.vaultId, recovery: this.#recovery, gidSalt: this.#gidSalt },
      this.entries().map((e) => ({
        generation: e.generation,
        epoch: e.epoch,
        key: e.key.expose().slice(),
      })),
    );
  }

  /**
   * The acceptance policy for keys from another ring (an unwrapped payload, a stored ring):
   * same vault (`vault_mismatch`), same pinned recovery key (`recovery_key_mismatch`), same gid
   * salt (`gid_salt_mismatch`), and, taking
   * new keys in ascending (generation, epoch, kid), each generation at most one above the highest
   * held so far (`generation_gap`). Any violation rejects the whole merge; nothing is added.
   */
  merge(other: Keyring): void {
    if (other.vaultId !== this.vaultId) throw new CryptoError("vault_mismatch");
    if (!samePublicKeys(other.#recovery, this.#recovery)) {
      throw new CryptoError("recovery_key_mismatch");
    }
    if (!equalBytes(other.#gidSalt, this.#gidSalt)) throw new CryptoError("gid_salt_mismatch");
    let max = this.maxGeneration;
    const fresh: KeyEntry[] = [];
    for (const e of other.entries()) {
      if (!inBounds(e.generation, e.epoch)) throw new CryptoError("bad_payload");
      if (this.#entries.has(e.kid)) continue;
      if (e.generation > max + 1) throw new CryptoError("generation_gap");
      max = Math.max(max, e.generation);
      fresh.push(e);
    }
    for (const e of fresh) {
      this.#entries.set(e.kid, {
        ...e,
        key: new Secret(e.key.expose().slice()),
        frameKey: new Secret(e.frameKey.expose().slice()),
      });
    }
  }

  /**
   * Replaces the pinned recovery public keys. A local, explicit operation only (the owner made a
   * new recovery key on this device); spreading it to other devices is a signed event (S29).
   */
  replaceRecoveryKey(publicKeys: RecoveryPublicKeys): void {
    this.#recovery = checkRecovery(publicKeys);
  }

  /** Not public API: adds an entry this module created. */
  addOwn(token: typeof INTERNAL, entry: KeyEntry): void {
    if (token !== INTERNAL) throw new TypeError("not public API");
    this.#entries.set(entry.kid, entry);
  }

  wipe(): void {
    for (const e of this.#entries.values()) {
      e.key.wipe();
      e.frameKey.wipe();
    }
    this.#entries.clear();
    this.#gidSalt.fill(0);
  }

  toJSON(): { vaultId: string; keys: { kid: string; generation: number; epoch: number }[] } {
    return {
      vaultId: this.vaultId,
      keys: this.entries().map(({ kid, generation, epoch }) => ({ kid, generation, epoch })),
    };
  }

  [INSPECT](): string {
    return `Keyring(${this.vaultId}, ${this.#entries.size} keys)`;
  }
}

/** An unchecked ring of decoded entries; only ever merged into a checked ring. */
function decodedRing(sodium: Sodium, vault: VaultInfo, keys: readonly KeyMaterial[]): Keyring {
  const ring = new Keyring(INTERNAL, vault);
  for (const k of keys) ring.addOwn(INTERNAL, makeEntry(sodium, vault.vaultId, k));
  return ring;
}

/**
 * A new vault for a profile: fresh vault id (unless given), pinned recovery keys, a fresh gid salt,
 * and a generation-1, epoch-0 data key.
 */
export function createKeyring(
  sodium: Sodium,
  recovery: RecoveryPublicKeys,
  vaultId: string = createVaultId(sodium),
): Keyring {
  const gidSalt = sodium.randomBytes(GID_SALT_BYTES);
  const ring = new Keyring(INTERNAL, { vaultId, recovery, gidSalt });
  gidSalt.fill(0);
  ring.addOwn(
    INTERNAL,
    makeEntry(sodium, vaultId, { generation: 1, epoch: 0, key: sodium.randomBytes(KEY_BYTES) }),
  );
  return ring;
}

/**
 * Adds a fresh key one generation above the newest and returns it; it becomes `active`.
 * `epoch` is the number of device revocations the rotating device has applied (default: the
 * active key's epoch); it must not go backwards. Revoking a device is a rotation with the
 * incremented epoch whose new key is wrapped only for the devices that remain (S29), so it beats a
 * concurrent plain rotation at the same generation.
 */
export function rotateKeyring(
  sodium: Sodium,
  ring: Keyring,
  options: { epoch?: number } = {},
): KeyEntry {
  const active = ring.active;
  const epoch = options.epoch ?? active.epoch;
  if (!Number.isInteger(epoch) || epoch < active.epoch || epoch > MAX_EPOCH) {
    throw new RangeError("epoch must be an integer >= the active key's epoch");
  }
  const generation = ring.maxGeneration + 1;
  if (generation > MAX_GENERATION) throw new RangeError("generation limit reached");
  const entry = makeEntry(sodium, ring.vaultId, {
    generation,
    epoch,
    key: sodium.randomBytes(KEY_BYTES),
  });
  ring.addOwn(INTERNAL, entry);
  return entry;
}

/**
 * Binary key payload v2:
 *   "cashu/keys/v2" | lp(vault id) | recovery box pk (32) | recovery sign pk (32) | gid salt (32) | u16 count |
 *   (u32 generation | u32 epoch | 32-byte key)*
 * It is the plaintext of a wrap and the value kept in a KeyStore. Key ids are not on the wire; the
 * reader recomputes them. The caller wipes the returned bytes once sealed or stored.
 */
export function encodeKeyPayload(ring: Keyring, kids?: readonly string[]): Uint8Array {
  const chosen = kids ? kids.map((kid) => ring.get(kid) ?? missing()) : ring.entries();
  if (chosen.length === 0 || chosen.length > MAX_KEYS) throw new CryptoError("bad_payload");
  const count = new Uint8Array(2);
  new DataView(count.buffer).setUint16(0, chosen.length);
  const { boxPublicKey, signPublicKey } = ring.recovery;
  const gidSalt = ring.gidSalt();
  try {
    return concat(
      PAYLOAD_MAGIC,
      lengthPrefixed(utf8(ring.vaultId)),
      boxPublicKey,
      signPublicKey,
      gidSalt.expose(),
      count,
      ...chosen.flatMap((e) => [u32(e.generation), u32(e.epoch), e.key.expose()]),
    );
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
  const count = r.u16();
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

/** Not public API: an empty ring with the same vault info as `other` (vault id, recovery, gid salt). */
export function emptyLike(other: Keyring): Keyring {
  const gidSalt = other.gidSalt();
  try {
    return new Keyring(INTERNAL, {
      vaultId: other.vaultId,
      recovery: other.recovery,
      gidSalt: gidSalt.expose(),
    });
  } finally {
    gidSalt.wipe();
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
