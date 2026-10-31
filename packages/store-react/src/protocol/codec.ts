// Values crossing the store port. Structured clone keeps plain data, bigint, Date and bytes, but drops
// class prototypes, so the domain's value classes travel tagged and are rebuilt on the other side:
// a `Decimal` keeps its exact digits and exponent (its string form round-trips), `Money` its currency.
// Anything else that is not plain data is a bug in a query or command and is refused loudly.
import { Decimal, Money } from "@cashu/domain";
import type { JsonValue } from "./messages.js";

const TAG = "~cashu";

type Tagged =
  | { readonly [TAG]: "decimal"; readonly v: string }
  | { readonly [TAG]: "money"; readonly amount: string; readonly currency: string };

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export class PortCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortCodecError";
  }
}

/** A query result or command value made ready for `postMessage`. */
export function encodeValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "function" || typeof value === "symbol") {
      throw new PortCodecError(`a ${typeof value} cannot cross the store port`);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(encodeValue);
  if (value instanceof Decimal) return { [TAG]: "decimal", v: value.toString() } satisfies Tagged;
  if (value instanceof Money) {
    return {
      [TAG]: "money",
      amount: value.amount.toString(),
      currency: value.currency,
    } satisfies Tagged;
  }
  if (value instanceof Date || ArrayBuffer.isView(value)) return value;
  if (!isPlainObject(value)) {
    throw new PortCodecError(
      `a ${value.constructor?.name ?? "class"} instance cannot cross the store port`,
    );
  }
  if (TAG in value) throw new PortCodecError(`"${TAG}" is a reserved key`);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = encodeValue(item);
  return out;
}

/** The inverse of `encodeValue`, on the receiving side. */
export function decodeValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(decodeValue);
  if (value instanceof Date || ArrayBuffer.isView(value)) return value;
  const record = value as Record<string, unknown>;
  const tag = record[TAG];
  if (tag === "decimal" && typeof record.v === "string") return Decimal.parse(record.v);
  if (tag === "money" && typeof record.amount === "string" && typeof record.currency === "string") {
    return new Money(Decimal.parse(record.amount), record.currency);
  }
  if (tag !== undefined) throw new PortCodecError("unknown tagged value on the store port");
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) out[key] = decodeValue(item);
  return out;
}

/** Command input / query arguments: JSON only (undefined fields dropped), as a fresh copy. */
export function toJson(value: unknown): JsonValue {
  if (value === undefined) return null;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new PortCodecError("NaN / Infinity are not JSON");
    return value;
  }
  if (Array.isArray(value)) return value.map(toJson);
  if (typeof value === "object" && isPlainObject(value)) {
    const out: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value))
      if (item !== undefined) out[key] = toJson(item);
    return out;
  }
  throw new PortCodecError("command input and query arguments must be JSON");
}
