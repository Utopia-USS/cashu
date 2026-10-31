// Global ids (spec: gid.md). Keyed deterministic gids are UUIDv8 over HMAC-SHA256 with the per-vault
// salt; the salt is passed in by the caller (keyring entry next to the vault data key, S27) and is
// never derived from anything public. ULIDs are minted for created entities.
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import {
  detMessage,
  GID_TABLES,
  type GidTable,
  uuid8FromDigest,
  VAULT_SALT_BYTES,
} from "./events/v1/namespaces.js";

export type { GidTable };

/** A 32-byte per-vault salt. Opaque: never logged, never sent to an agent (gid.md 3). */
export interface VaultSalt {
  readonly bytes: Uint8Array;
}

export function vaultSalt(bytes: Uint8Array): VaultSalt {
  if (bytes.length !== VAULT_SALT_BYTES) {
    throw new RangeError(`the vault salt must be ${VAULT_SALT_BYTES} bytes`);
  }
  return Object.freeze({ bytes: Uint8Array.from(bytes) });
}

/** A fresh salt for a new vault (CSPRNG via `crypto.getRandomValues`). */
export function newVaultSalt(): VaultSalt {
  return vaultSalt(randomBytes(VAULT_SALT_BYTES));
}

/** DET gid (gid.md 3): uuid8(HMAC-SHA256(salt, "cashu.gid.v1/" + table + US + parts...)). */
export function detGid(salt: VaultSalt, table: GidTable, parts: readonly string[]): string {
  if (!(GID_TABLES as readonly string[]).includes(table)) {
    throw new RangeError(`unknown gid domain: ${table}`);
  }
  return uuid8FromDigest(hmac(sha256, salt.bytes, utf8ToBytes(detMessage(table, parts))));
}

/** A DET gid function bound to one vault's salt, as the materializers and commands get it. */
export type DetGid = (table: GidTable, parts: readonly string[]) => string;

export function detGidFor(salt: VaultSalt): DetGid {
  return (table, parts) => detGid(salt, table, parts);
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Mint a ULID (48-bit ms time + 80 random bits, Crockford base32). `random` defaults to the CSPRNG;
 * tests pass a seeded source.
 */
export function mintUlid(nowMs: number, random: (n: number) => Uint8Array = randomBytes): string {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs >= 2 ** 48) {
    throw new RangeError("ULID time out of range");
  }
  let time = "";
  let t = nowMs;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD.charAt(t % 32) + time;
    t = Math.floor(t / 32);
  }
  const bytes = random(10);
  let bits = 0;
  let acc = 0;
  let rand = "";
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      rand += CROCKFORD.charAt((acc >> bits) & 31);
    }
    acc &= (1 << bits) - 1;
  }
  return time + rand;
}
