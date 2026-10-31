// The log copy's payload encoding (`event_log.data`): a catalog payload whose keys all belong to its
// type's schema is stored positionally, `[presence mask, ...present values in schema order]`, so the
// field names are not repeated in every row (about 40% of a transaction import's payload). Anything
// else (unknown fields, a type outside the catalog) stays a JSON object. Lossless both ways: decoding
// gives back the same keys and values (key order is not significant, events.md 4.1).
import { isEventType, PAYLOADS } from "../events/v1/catalog.js";
import type { Payload } from "../upcast.js";

const keysByType = new Map<string, readonly string[] | null>();

function keysOf(type: string): readonly string[] | null {
  let keys = keysByType.get(type);
  if (keys === undefined) {
    const shape = isEventType(type)
      ? (PAYLOADS[type] as { shape?: Record<string, unknown> }).shape
      : undefined;
    keys = shape !== undefined && Object.keys(shape).length <= 52 ? Object.keys(shape) : null;
    keysByType.set(type, keys);
  }
  return keys;
}

export function encodePayload(type: string, data: Payload): string {
  const keys = keysOf(type);
  if (keys === null) return JSON.stringify(data);
  const values: unknown[] = [0];
  let mask = 0;
  let present = 0;
  for (let i = 0; i < keys.length; i++) {
    const v = data[keys[i] as string];
    if (v === undefined) continue;
    mask += 2 ** i;
    present += 1;
    values.push(v);
  }
  let defined = 0;
  for (const k in data) if (data[k] !== undefined) defined += 1;
  if (defined !== present) return JSON.stringify(data); // a field outside the schema: keep names
  values[0] = mask;
  return JSON.stringify(values);
}

export function decodePayload(type: string, text: string): Payload {
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) return parsed as Payload;
  const keys = keysOf(type);
  if (keys === null) throw new Error(`positional payload of a type without a schema: ${type}`);
  const mask = parsed[0] as number;
  const out: Record<string, unknown> = {};
  let j = 1;
  for (let i = 0; i < keys.length; i++) {
    if (Math.floor(mask / 2 ** i) % 2 === 1) out[keys[i] as string] = parsed[j++];
  }
  return out;
}
