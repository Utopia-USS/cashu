// The store channel's value codec, v2: JSON-safe, because store messages now cross a socket as JSON
// frames instead of a MessagePort's structured clone. Everything structured clone carried for a query
// result or command value still arrives as the same value:
//   Decimal  {"~cashu":"decimal","v":"<exact string>"}       Money  {"~cashu":"money","amount","currency"}
//   Date     {"~cashu":"date","v":<ms> | null (invalid)}       bytes  {"~cashu":"bytes","v":"<base64>"}
//   bigint   {"~cashu":"bigint","v":"<digits>"}               undefined (top level, array item) {"~cashu":"undefined"}
//   -0, NaN, +-Infinity  {"~cashu":"number","v":"-0" | "NaN" | "Infinity" | "-Infinity"}
// Object fields holding undefined are dropped (reading them gives undefined either way). Class
// instances, Maps, Sets, functions and symbols are bugs in a query or command and are refused loudly;
// so is a plain object using the reserved "~cashu" key. Bytes are Uint8Array (a Node Buffer arrives as
// a plain Uint8Array); other typed arrays are refused.
import { Decimal, Money } from "@cashu/domain";
import { z } from "zod";

const TAG = "~cashu";

const json = z.json();
export type JsonValue = z.infer<typeof json>;

export class StoreCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreCodecError";
  }
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]));

function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63);
    out += b === undefined ? "=" : B64.charAt((n >> 6) & 63);
    out += c === undefined ? "=" : B64.charAt(n & 63);
  }
  return out;
}

function fromBase64(text: string): Uint8Array {
  if (text.length % 4 !== 0) throw new StoreCodecError("bytes: invalid base64");
  const pad = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < text.length; i += 4) {
    let n = 0;
    for (let k = 0; k < 4; k++) {
      const ch = text.charAt(i + k);
      const v = ch === "=" && i + k >= text.length - pad ? 0 : B64_INDEX.get(ch);
      if (v === undefined) throw new StoreCodecError("bytes: invalid base64");
      n = (n << 6) | v;
    }
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

function encodeNumber(n: number): JsonValue {
  if (Number.isFinite(n) && !Object.is(n, -0)) return n;
  return { [TAG]: "number", v: Object.is(n, -0) ? "-0" : String(n) };
}

/** A query result or command value as JSON for the store channel. */
export function encodeValue(value: unknown): JsonValue {
  switch (typeof value) {
    case "undefined":
      return { [TAG]: "undefined" };
    case "boolean":
    case "string":
      return value;
    case "number":
      return encodeNumber(value);
    case "bigint":
      return { [TAG]: "bigint", v: value.toString() };
    case "function":
    case "symbol":
      throw new StoreCodecError(`a ${typeof value} cannot cross the store channel`);
  }
  if (value === null) return null;
  const object = value as object;
  if (Array.isArray(object)) return object.map(encodeValue);
  if (object instanceof Decimal) return { [TAG]: "decimal", v: object.toString() };
  if (object instanceof Money) {
    return { [TAG]: "money", amount: object.amount.toString(), currency: object.currency };
  }
  if (object instanceof Date) {
    const ms = object.getTime();
    return { [TAG]: "date", v: Number.isNaN(ms) ? null : ms };
  }
  if (object instanceof Uint8Array) return { [TAG]: "bytes", v: toBase64(object) };
  if (!isPlainObject(object)) {
    throw new StoreCodecError(
      `a ${object.constructor?.name ?? "class"} instance cannot cross the store channel`,
    );
  }
  if (TAG in object) throw new StoreCodecError(`"${TAG}" is a reserved key`);
  const out: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(object)) {
    if (item !== undefined) out[key] = encodeValue(item);
  }
  return out;
}

const str = (record: Record<string, unknown>, key: string): string => {
  const v = record[key];
  if (typeof v !== "string") throw new StoreCodecError(`tagged value without a string "${key}"`);
  return v;
};

const NUMBERS: Readonly<Record<string, number>> = {
  "-0": -0,
  NaN: Number.NaN,
  Infinity: Number.POSITIVE_INFINITY,
  "-Infinity": Number.NEGATIVE_INFINITY,
};

function decodeTagged(tag: unknown, record: Record<string, unknown>): unknown {
  switch (tag) {
    case "decimal":
      return Decimal.parse(str(record, "v"));
    case "money":
      return new Money(Decimal.parse(str(record, "amount")), str(record, "currency"));
    case "date": {
      const v = record.v;
      if (v === null) return new Date(Number.NaN);
      if (typeof v !== "number") throw new StoreCodecError("date without a time");
      return new Date(v);
    }
    case "bytes":
      return fromBase64(str(record, "v"));
    case "bigint": {
      const v = str(record, "v");
      if (!/^-?\d+$/.test(v)) throw new StoreCodecError("bigint: not an integer");
      return BigInt(v);
    }
    case "undefined":
      return undefined;
    case "number": {
      const v = NUMBERS[str(record, "v")];
      if (v === undefined) throw new StoreCodecError("number: unknown special value");
      return v;
    }
    default:
      throw new StoreCodecError("unknown tagged value on the store channel");
  }
}

/** The inverse of `encodeValue`, on the receiving side. */
export function decodeValue(value: JsonValue): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(decodeValue);
  const record = value as Record<string, JsonValue>;
  if (TAG in record) return decodeTagged(record[TAG], record);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) out[key] = decodeValue(item);
  return out;
}

/** Command input / query arguments: JSON only (undefined fields dropped), as a fresh copy. */
export function toJson(value: unknown): JsonValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new StoreCodecError("NaN / Infinity are not JSON");
    return value;
  }
  if (Array.isArray(value)) return value.map(toJson);
  if (typeof value === "object" && isPlainObject(value)) {
    const out: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) out[key] = toJson(item);
    }
    return out;
  }
  throw new StoreCodecError("command input and query arguments must be JSON");
}
