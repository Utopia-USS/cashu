// Value formats shared by every v1 event schema (spec: packages/store/spec/events.md section 4,
// gid.md section 2). Formats are strict on purpose: a value that does not match is a writer bug,
// and the event is parked, never half applied (events.md section 7 rule 4).
import { Decimal, floatRepr } from "@cashu/domain";
import { z } from "zod";

/** ULID, Crockford base32, upper case, first char 0-7 (fits 48-bit time). */
export const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
/** RFC 9562 UUID version 8 (custom: keyed HMAC-SHA256 gids, gid.md section 3), lower case. */
export const UUID8_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Vault id (= profile gid, S27 `createVaultId`): 16 random bytes as 32 lower-case hex. */
export const VAULT_ID_RE = /^[0-9a-f]{32}$/;
/** Device id (S27 `DeviceIdentity`, minted at pairing, S29): 32 lower-case hex, never all zero. */
export const DEVICE_RE = /^[0-9a-f]{32}$/;
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
export const vaultId = z.string().regex(VAULT_ID_RE, "expected a 32-char lower-hex vault id");
export const deviceId = z
  .string()
  .regex(DEVICE_RE, "expected a 32-char lower-hex device id")
  .refine((s) => /[1-9a-f]/.test(s), "the all-zero device id is the recovery signer's");
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

/**
 * A number as event data carries it (events.md 4.3): a safe integer stays a JSON number, any other
 * finite number becomes Decimal text the way Python floats are rendered (`repr` digits, then
 * `format(Decimal(repr(x)), "f")`: `0.5` -> `"0.5"`, `1e-7` -> `"0.0000001"`). Event data, its batch
 * proof and every hash over it hold integers only, so they stay byte-identical across devices.
 */
export function eventNumber(value: number): number | string {
  if (Number.isSafeInteger(value)) return value;
  if (!Number.isFinite(value)) throw new RangeError("NaN / Infinity are not JSON (events.md 4.1)");
  return Decimal.parse(floatRepr(value)).format("f");
}

/** The paths (key / array-index segments) of the numbers a blob holds as Decimal text (4.3). */
export const floatPaths = z.array(z.array(z.string()).min(1)).min(1);
export type FloatPaths = z.infer<typeof floatPaths>;

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const defineEntry = (target: Record<string, unknown>, key: string, value: unknown) =>
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });

/**
 * A free JSON blob (agent parameters, signal payloads, stats, a bank's raw JSON) as event data
 * carries it, under its field name: every number `eventNumber` rewrites becomes Decimal text, and
 * their paths go to `<field>Floats` (absent when there are none), so the fold puts the same JSON
 * numbers back into the view (`restoreFloats`) and no reader sees a difference. Arrays and plain
 * objects are copied; any other value is left for the emit checks to reject.
 */
export function eventBlob<F extends string>(
  field: F,
  value: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const paths: string[][] = [];
  const visit = (item: unknown, path: readonly string[]): unknown => {
    if (typeof item === "number") {
      const stored = eventNumber(item);
      if (typeof stored === "string") paths.push([...path]);
      return stored;
    }
    if (Array.isArray(item)) return item.map((entry, i) => visit(entry, [...path, String(i)]));
    if (!isPlainRecord(item)) return item;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(item))
      defineEntry(out, key, visit(entry, [...path, key]));
    return out;
  };
  const out: Record<string, unknown> = {};
  defineEntry(out, field, visit(value, []));
  if (paths.length > 0) defineEntry(out, `${field}Floats`, paths);
  return out;
}

/**
 * The fold side of `eventBlob`: the Decimal text at each listed path becomes its JSON number again
 * (the same IEEE double: the text is the number's shortest round-trip digits). Anything else at a
 * path is left as is; no paths (every event written before this rule) returns the blob unchanged.
 */
export function restoreFloats<T>(value: T, paths: unknown): T {
  if (!Array.isArray(paths) || paths.length === 0) return value;
  const copy = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(copy)
      : isPlainRecord(item)
        ? Object.entries(item).reduce<Record<string, unknown>>(
            (out, [key, entry]) => defineEntry(out, key, copy(entry)),
            {},
          )
        : item;
  const root = copy(value);
  for (const path of paths) {
    if (!Array.isArray(path) || path.length === 0) continue;
    let parent: unknown = root;
    for (const segment of path.slice(0, -1)) {
      parent =
        Array.isArray(parent) || isPlainRecord(parent)
          ? (parent as Record<string, unknown>)[String(segment)]
          : undefined;
    }
    const last = String(path[path.length - 1]);
    if (!Array.isArray(parent) && !isPlainRecord(parent)) continue;
    const container = parent as Record<string, unknown>;
    const text = Object.hasOwn(container, last) ? container[last] : undefined;
    if (typeof text === "string" && DECIMAL_RE.test(text)) container[last] = Number(text);
  }
  return root as T;
}

/** Path of the first number event data may not carry (a non-integer or unsafe integer), or null. */
export function nonIntegerNumberPath(value: unknown, path = "data"): string | null {
  if (typeof value === "number") return Number.isSafeInteger(value) ? null : path;
  if (value === null || typeof value !== "object") return null;
  for (const [key, item] of Object.entries(value)) {
    const found = nonIntegerNumberPath(
      item,
      Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`,
    );
    if (found !== null) return found;
  }
  return null;
}

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
