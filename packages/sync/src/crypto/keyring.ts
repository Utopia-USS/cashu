// Per-profile data keys. A profile is a vault: one random vault id (opaque, never the profile slug,
// so a relay or a synced folder learns nothing from it), the pinned recovery public keys and a
// keyring of data keys. Each key has a generation (1, 2, ...), an epoch (how many device
// revocations its creator had applied) and a key id computed from the key and that metadata.
// The highest (epoch, generation, kid) encrypts; every held key still decrypts older frames.
// Rotation adds a generation; it never drops one.

import { toHex } from "./encoding.js";
import { CryptoError } from "./errors.js";
import type { RecoveryPublicKeys } from "./identity.js";
import { equalBytes, samePublicKeys, selectAcceptedKeys } from "./keyAcceptance.js";
import {
  type KeyEntry,
  type KeyMaterial,
  MAX_EPOCH,
  MAX_GENERATION,
  makeEntry,
} from "./keyEntry.js";
import { Secret } from "./secret.js";
import { KEY_BYTES, PUBLIC_KEY_BYTES, type Sodium } from "./sodium.js";

export const GID_SALT_BYTES = 32;
const VAULT_ID = /^[0-9a-f]{32}$/;
const INSPECT = Symbol.for("nodejs.util.inspect.custom");
const INTERNAL = Symbol("keyring-internal");

/** What identifies a vault across devices; carried in every key payload. */
export interface VaultInfo {
  vaultId: string;
  recovery: RecoveryPublicKeys;
  /** Per-vault salt for deterministic gids (HMAC-SHA256 key); never rotated. */
  gidSalt: Uint8Array;
}

export function createVaultId(sodium: Sodium): string {
  return toHex(sodium.randomBytes(16));
}

export function assertVaultId(vaultId: string): void {
  if (!VAULT_ID.test(vaultId)) throw new RangeError("vault id must be 32 lowercase hex characters");
}

/** Storage order (`entries()`): generation, then epoch, then kid. */
function byGeneration(a: KeyEntry, b: KeyEntry): number {
  return (
    a.generation - b.generation || a.epoch - b.epoch || (a.kid < b.kid ? -1 : a.kid > b.kid ? 1 : 0)
  );
}

/**
 * Order of `active`: epoch first, so a key from a device that never saw a revocation (a lower
 * epoch) never overrides the revocation key, however many generations it rotated; then generation,
 * then kid.
 */
function byEpoch(a: KeyEntry, b: KeyEntry): number {
  return a.epoch - b.epoch || byGeneration(a, b);
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
 * A vault's keys on one device. Built only by `createKeyring`, `rotateKeyring`, `keyringFromKeys` (tests)
 * and the payload decoder; every key that arrives from outside goes through `merge`, the one
 * acceptance policy (same vault, same recovery key, no generation gap, all-or-nothing).
 */
export class Keyring {
  readonly vaultId: string;
  #recovery: RecoveryPublicKeys;
  #gidSalt: Secret;
  #entries = new Map<string, KeyEntry>();

  /** Not public API: use `createKeyring`. */
  constructor(token: typeof INTERNAL, vault: VaultInfo) {
    if (token !== INTERNAL) throw new TypeError("use createKeyring");
    assertVaultId(vault.vaultId);
    if (vault.gidSalt.length !== GID_SALT_BYTES) throw new RangeError("gid salt must be 32 bytes");
    this.vaultId = vault.vaultId;
    this.#recovery = checkRecovery(vault.recovery);
    this.#gidSalt = new Secret(vault.gidSalt.slice());
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
    // expose() throws `wiped` after `wipe()`: never derive gids under a zeroed salt.
    return new Secret(this.#gidSalt.expose().slice());
  }

  /** The key new frames are encrypted with: highest (epoch, generation, kid). */
  get active(): KeyEntry {
    let best: KeyEntry | undefined;
    for (const e of this.#entries.values()) {
      if (!best || byEpoch(e, best) > 0) best = e;
    }
    if (!best) throw new CryptoError("unknown_key");
    return best;
  }

  get size(): number {
    return this.#entries.size;
  }

  get maxEpoch(): number {
    let max = 0;
    for (const e of this.#entries.values()) max = Math.max(max, e.epoch);
    return max;
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
    return [...this.#entries.values()].sort(byGeneration);
  }

  /** An independent copy (own key bytes) of this ring. */
  clone(sodium: Sodium): Keyring {
    return keyringFromKeys(
      sodium,
      { vaultId: this.vaultId, recovery: this.#recovery, gidSalt: this.#gidSalt.expose() },
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
    if (!equalBytes(other.#gidSalt.expose(), this.#gidSalt.expose())) {
      throw new CryptoError("gid_salt_mismatch");
    }
    const fresh = selectAcceptedKeys([...this.#entries.values()], other.entries());
    for (const e of fresh) {
      this.#entries.set(e.kid, {
        ...e,
        key: new Secret(e.key.expose().slice()),
        frameKey: new Secret(e.frameKey.expose().slice()),
      });
    }
  }

  /**
   * Replaces the pinned recovery public keys. Only for applying a verified, signed S29 "recovery key
   * changed" event (or the owner creating a new recovery key on this device); never with keys read
   * from storage, which would reintroduce B2.
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
    this.#gidSalt.wipe();
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

/**
 * A ring from raw key material and caller-chosen vault info (recovery keys, gid salt): for tests and
 * golden vectors only, exported from `@cashu/sync/testing`, never from the main entry, because a
 * ring built from storage data this way would skip the pinning that payloads give (B2, D9). Kids are
 * computed here and the keys pass the same acceptance policy as a merge.
 * @package
 */
export function keyringFromKeys(
  sodium: Sodium,
  vault: VaultInfo,
  keys: readonly KeyMaterial[],
): Keyring {
  const ring = new Keyring(INTERNAL, vault);
  const incoming = decodedRing(sodium, vault, keys);
  try {
    ring.merge(incoming);
  } finally {
    incoming.wipe();
  }
  return ring;
}

/** Not public API: an unchecked ring of decoded entries; only ever merged into a checked ring. */
export function decodedRing(
  sodium: Sodium,
  vault: VaultInfo,
  keys: readonly KeyMaterial[],
): Keyring {
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
  if (
    !Number.isInteger(epoch) ||
    epoch < active.epoch ||
    epoch > ring.maxEpoch + 1 ||
    epoch > MAX_EPOCH
  ) {
    throw new RangeError("epoch must be an integer from the active key's epoch to the highest + 1");
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
