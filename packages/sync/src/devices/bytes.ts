// Byte and canonical-JSON helpers for device statements and pairing messages. Kept local to devices/
// (crypto's encoding helpers are not part of its public API). Every variable-length field that is
// signed or hashed is length-prefixed, so two different statements never encode to the same bytes.

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const HEX = /^(?:[0-9a-f]{2})*$/;

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

/** Throws on invalid UTF-8 (callers turn that into a malformed message). */
export function fromUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function concat(...parts: readonly Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** u32 big-endian length followed by the bytes. */
export function lp(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length);
  out.set(bytes, 4);
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function isHex(value: unknown, bytes?: number): value is string {
  return (
    typeof value === "string" &&
    HEX.test(value) &&
    (bytes === undefined || value.length === bytes * 2)
  );
}

export function fromHex(hex: string): Uint8Array {
  if (!HEX.test(hex)) throw new RangeError("invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The JSON values statements are made of: no floats, no undefined, no NaN. */
export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

/**
 * Canonical JSON: object keys sorted by code unit, no whitespace, integers only. Two devices that
 * hold the same statement compute the same bytes, so a signature survives a JSON round trip through
 * the log (key order is irrelevant on the wire, events.md 4.1).
 */
export function canonicalJson(value: CanonicalValue): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new RangeError("canonical JSON holds integers only");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as { readonly [key: string]: CanonicalValue };
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k] ?? null)}`).join(",")}}`;
}

/** Narrows unknown JSON to a canonical value (rejects floats, undefined and non-plain objects). */
export function isCanonicalValue(value: unknown, depth = 0): value is CanonicalValue {
  if (depth > 8) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isSafeInteger(value);
  if (Array.isArray(value)) return value.every((v) => isCanonicalValue(v, depth + 1));
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.values(value).every((v) => isCanonicalValue(v, depth + 1));
}
