// Value-free digest of one exact own event batch for private crash recovery journals.
import { blake2b } from "@noble/hashes/blake2.js";
import type { UnstampedEvent, WireEvent } from "./carrier.js";

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (
    typeof value !== "object" ||
    value === null ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new RangeError("batch proof requires canonical JSON");
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

/** HLC is stamped after preparation, so it is excluded; order and entire data are bound. */
export function ownBatchDigest(events: readonly (UnstampedEvent | WireEvent)[]): string {
  if (events.length === 0) throw new RangeError("empty own batch proof");
  const body = canonical(events.map((e) => ({ t: e.t, v: e.v, i: e.i, d: e.d })));
  const bytes = new TextEncoder().encode(`cashu/own-batch-proof/v1\0${body}`);
  const hash = blake2b(bytes, { dkLen: 32 });
  return [...hash].map((b) => b.toString(16).padStart(2, "0")).join("");
}
