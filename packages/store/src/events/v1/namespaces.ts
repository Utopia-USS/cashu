// Keyed deterministic gids (spec: gid.md section 3, lead decision M8):
//
//   gid = uuid8(HMAC-SHA256(key = vault salt, msg = UTF-8(GID_DOMAIN_PREFIX + table + US + part1 + US + ...)))
//
// The vault salt is 32 random bytes generated with the vault, kept in the device keyring next to the
// vault data key and handed over at pairing; it is never derived from the slug or any other public
// value. Without the salt nobody can confirm a guess ("is this IBAN / payment theirs") from a gid.
// The HMAC itself runs in the runtime (node:crypto, WebCrypto, noble on Hermes) in S23's gid.ts; this
// file fixes the domain strings, the message layout and the UUIDv8 formatting.

/** Domain-separation prefix of every DET message. */
export const GID_DOMAIN_PREFIX = "cashu.gid.v1/";
/** Separator between the parts of a DET message (U+001F). */
export const UNIT_SEPARATOR = "\u001f";
/** Salt length in bytes. */
export const VAULT_SALT_BYTES = 32;

/** Tables (domains) with deterministic gids. Never rename or reuse an entry. */
export const GID_TABLES = [
  "profile_modules",
  "accounts",
  "balances",
  "transactions",
  "category_rules",
  "loans",
  "depreciations",
  "asset_details",
  "budget_settings",
  "inv_account_settings",
  "inv_transactions",
  "inv_position_snapshots",
  "inv_instrument_renames",
  "inv_manual_valuations",
  "inv_instruments",
  "inv_instrument_aliases",
  "inv_profile_instruments",
  "inv_topic_theses",
  "watchlist_items",
  "connector_bindings",
  /** Genesis gids of ULID tables: parts [table, localId] (gid.md section 7). */
  "genesis",
] as const;

export type GidTable = (typeof GID_TABLES)[number];

/**
 * The DET message (gid.md section 3): domain prefix + table, then the parts, joined by U+001F.
 * Throws on a part containing the separator (a writer bug, never real data).
 */
export function detMessage(table: GidTable, parts: readonly string[]): string {
  for (const part of parts) {
    if (part.includes(UNIT_SEPARATOR)) throw new RangeError("a DET input part contains U+001F");
  }
  return [GID_DOMAIN_PREFIX + table, ...parts].join(UNIT_SEPARATOR);
}

/** Format the first 16 bytes of an HMAC-SHA256 digest as an RFC 9562 UUIDv8 (lower case). */
export function uuid8FromDigest(digest: Uint8Array): string {
  if (digest.length < 16) throw new RangeError("digest too short for a UUID");
  const b = Array.from(digest.subarray(0, 16));
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x80;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = b.map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
