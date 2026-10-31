// Value formats shared by every v1 event schema (spec: packages/store/spec/events.md section 4,
// gid.md section 2). Formats are strict on purpose: a value that does not match is a writer bug,
// and the event is parked, never half applied (events.md section 7 rule 4).
import { z } from "zod";

/** ULID, Crockford base32, upper case, first char 0-7 (fits 48-bit time). */
export const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
/** RFC 9562 UUID version 8 (custom: keyed HMAC-SHA256 gids, gid.md section 3), lower case. */
export const UUID8_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Device id minted at pairing (S29): 16 chars base36 lower case. */
export const DEVICE_RE = /^[0-9a-z]{16}$/;
/** Decimal in plain notation, scale preserved, no exponent, no leading zeros. */
export const DECIMAL_RE = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;
export const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** UTC timestamp, 0-6 fractional digits (TS writers emit 3, genesis keeps Python's 6). */
export const TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?Z$/;
export const CURRENCY_RE = /^[A-Z]{3}$/;
/** Instrument / quote currency codes the importers produce (crypto tickers included). */
export const ASSET_CURRENCY_RE = /^[A-Z0-9]{2,10}$/;
export const EVENT_TYPE_RE = /^[a-z][a-zA-Z]*\.[a-z][a-zA-Z]*$/;
export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
export const SHA1_HEX_RE = /^[0-9a-f]{40}$/;

function isRealDate(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

export const ulid = z.string().regex(ULID_RE, "expected an upper-case ULID");
export const uuid8 = z.string().regex(UUID8_RE, "expected a lower-case keyed UUIDv8");
/** A global id: ULID (minted) or keyed UUIDv8 (deterministic). Never a local integer id. */
export const gid = z.union([ulid, uuid8]);
export const deviceId = z.string().regex(DEVICE_RE, "expected a 16-char base36 device id");
export const decimal = z.string().regex(DECIMAL_RE, "expected a plain-notation decimal string");
export const calendarDate = z
  .string()
  .regex(DATE_RE, "expected YYYY-MM-DD")
  .refine((s) => {
    const m = DATE_RE.exec(s);
    return m !== null && isRealDate(Number(m[1]), Number(m[2]), Number(m[3]));
  }, "not a calendar date");
export const timestamp = z
  .string()
  .regex(TIMESTAMP_RE, "expected a UTC timestamp YYYY-MM-DDTHH:MM:SS[.ffffff]Z")
  .refine((s) => {
    const m = TIMESTAMP_RE.exec(s);
    if (m === null || !isRealDate(Number(m[1]), Number(m[2]), Number(m[3]))) return false;
    return Number(m[4]) < 24 && Number(m[5]) < 60 && Number(m[6]) < 60;
  }, "not a valid UTC time");
export const currency = z.string().regex(CURRENCY_RE, "expected an ISO 4217 code");
export const assetCurrency = z.string().regex(ASSET_CURRENCY_RE, "expected a currency code");
export const sha256Hex = z.string().regex(SHA256_HEX_RE, "expected lower-hex sha256");
export const sha1Hex = z.string().regex(SHA1_HEX_RE, "expected lower-hex sha1");
/** A JSON object blob (params, raw, stats, payload ...). Ids inside are gids (gid.md section 6). */
export const jsonObject = z.record(z.string(), z.unknown());
/** An encrypted content-addressed blob (D9): import archives, staged proposal files. */
export const blobRef = z.looseObject({
  sha256: sha256Hex,
  ext: z.string().regex(/^[a-z0-9]{1,10}$/, "expected a lower-case file extension"),
});
export const nonEmpty = z.string().min(1);
/** A lower-case key: module ids, account types, categories, rule ids parts. */
export const key = z.string().regex(/^[a-z][a-z0-9_]*$/, "expected a lower-case key");
/**
 * Explicit domain timestamps of a row, keyed by view column (events.md 4.4): genesis snapshots carry
 * every timestamp column here so the view stays byte-equal; native writers rarely need it.
 */
export const stamps = z.record(
  z.string().regex(/^[a-z][a-z0-9_]*$/, "expected a view column name"),
  timestamp.nullable(),
);
