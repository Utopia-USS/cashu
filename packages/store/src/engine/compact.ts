// The log copy's payload encoding (`event_log.data`, events.md 4.5): a payload whose top-level keys
// all have a position in its type's field table is stored positionally, `[presence mask, ...present
// values in table order]`, so the field names are not repeated in every row (about 40% of a
// transaction import's payload). Anything else (a field outside the table, a type without a table, a
// field past position 51) stays a JSON object. Lossless both ways: decoding gives back the same keys
// and values (key order is not significant, events.md 4.1).
//
// Positions come from the append-only field table (`field-table.ts`), never from a zod schema, so
// reordering a schema or adding a field anywhere in it cannot change how a stored payload decodes.
// The table names fields, not meanings, so one table per type serves every version of it: decoding
// needs no version (the `data` column holds the payload as upcast at write time, a version the row
// does not record).
import type { Payload } from "../upcast.js";
import { FIELD_TABLE } from "./field-table.js";

/** Bits of a presence mask: a JSON number is exact up to 2^53. */
const MASK_BITS = 52;

export class PayloadCodec {
  readonly #fields: ReadonlyMap<string, readonly string[]>;

  constructor(table: Readonly<Record<string, readonly string[]>>) {
    this.#fields = new Map(Object.entries(table));
  }

  encode(type: string, data: Payload): string {
    const fields = this.#fields.get(type);
    if (fields === undefined) return JSON.stringify(data);
    const values: unknown[] = [0];
    let mask = 0;
    let present = 0;
    const n = Math.min(fields.length, MASK_BITS);
    for (let i = 0; i < n; i++) {
      const v = data[fields[i] as string];
      if (v === undefined) continue;
      mask += 2 ** i;
      present += 1;
      values.push(v);
    }
    let defined = 0;
    for (const k in data) if (data[k] !== undefined) defined += 1;
    if (defined !== present) return JSON.stringify(data); // a field without a position: keep names
    values[0] = mask;
    return JSON.stringify(values);
  }

  decode(type: string, text: string): Payload {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) return parsed as Payload;
    const fields = this.#fields.get(type);
    if (fields === undefined)
      throw new Error(`positional payload of a type without a table: ${type}`);
    const mask = parsed[0] as number;
    const out: Record<string, unknown> = {};
    let j = 1;
    const n = Math.min(fields.length, MASK_BITS);
    for (let i = 0; i < n; i++) {
      if (Math.floor(mask / 2 ** i) % 2 === 1) out[fields[i] as string] = parsed[j++];
    }
    if (j !== parsed.length)
      throw new Error(`positional payload does not match its table: ${type}`);
    return out;
  }
}

/** The store's codec: the checked-in field table. */
const LOG_CODEC = new PayloadCodec(FIELD_TABLE);

export function encodePayload(type: string, data: Payload): string {
  return LOG_CODEC.encode(type, data);
}

export function decodePayload(type: string, text: string): Payload {
  return LOG_CODEC.decode(type, text);
}
