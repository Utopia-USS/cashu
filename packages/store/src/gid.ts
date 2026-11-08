// Global ids (spec: gid.md). Keyed deterministic gids are UUIDv8 over HMAC-SHA256 with the per-vault
// salt; the salt is passed in by the caller (keyring entry next to the vault data key, S27) and is
// never derived from anything public. ULIDs are minted for created entities.
import { randomBytes } from "@noble/hashes/utils.js";
import { type HmacSha256, nobleHmacSha256 } from "./crypto/hmac.js";
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

/** A DET gid function bound to one vault's salt, as the materializers and commands get it. */
export type DetGid = (table: GidTable, parts: readonly string[]) => string;

const utf8 = new TextEncoder();
const GID_TABLE_SET: ReadonlySet<string> = new Set(GID_TABLES);

/**
 * DET gids of one vault (gid.md 3): uuid8(HMAC-SHA256(salt, "cashu.gid.v1/" + table + US + parts)).
 * The salt is keyed once; `impl` is the HMAC implementation (crypto/hmac.ts: noble by default, a
 * native one injected by the app; both give byte-identical gids).
 */
export function detGidFor(salt: VaultSalt, impl: HmacSha256 = nobleHmacSha256): DetGid {
  const mac = impl.keyed(salt.bytes);
  return (table, parts) => {
    if (!GID_TABLE_SET.has(table)) throw new RangeError(`unknown gid domain: ${table}`);
    return uuid8FromDigest(mac(utf8.encode(detMessage(table, parts))));
  };
}

/** One DET gid (a one-off caller; folds and commands hold a `detGidFor` function). */
export function detGid(
  salt: VaultSalt,
  table: GidTable,
  parts: readonly string[],
  impl?: HmacSha256,
): string {
  return detGidFor(salt, impl)(table, parts);
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
