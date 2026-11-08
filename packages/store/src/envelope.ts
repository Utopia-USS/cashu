// Envelope decoding (events.md 2, 7): wire or logical form -> a validated envelope whose payload is
// upcast to the reader's current version, or a parked / rejected outcome. The v1 catalog's
// `parseEvent` is the normative parser for every type still at v1; types a module evolved go through
// the registry's schemas and upcasters.
import { canonicalJson } from "./canonical.js";
import { isEventType, parseEvent } from "./events/v1/catalog.js";
import { type Envelope, envelopeSchema } from "./events/v1/envelope.js";
import type { EventRegistry } from "./registry.js";
import { type Payload, upcast } from "./upcast.js";

export type ParkReason = "unknown-type" | "newer-version" | "invalid-payload";

export type Decoded =
  | { readonly status: "known"; readonly envelope: Envelope; readonly data: Payload }
  | { readonly status: "parked"; readonly envelope: Envelope; readonly reason: ParkReason }
  | { readonly status: "rejected"; readonly error: string };

const ENVELOPE_KEYS = new Set([
  "eid",
  "vault",
  "device",
  "hlc",
  "at",
  "type",
  "v",
  "gid",
  "data",
  "cause",
  "origin",
]);

/** Decode a logical-form envelope. */
export function decodeEnvelope(raw: unknown, registry: EventRegistry): Decoded {
  const rawType = (raw as { type?: unknown } | null)?.type;
  if (typeof rawType === "string" && isEventType(rawType) && registry.get(rawType)?.current === 1) {
    // A catalog type still at v1: the catalog's parser (envelope, payload, cross-field rules) decides.
    const parsed = parseEvent(raw);
    if (parsed.status === "known") {
      return { status: "known", envelope: parsed.event, data: parsed.event.data as Payload };
    }
    if (parsed.status === "parked") {
      return { status: "parked", envelope: parsed.envelope, reason: parsed.reason };
    }
    return { status: "rejected", error: parsed.error };
  }
  const env = envelopeSchema.safeParse(raw);
  if (!env.success) return { status: "rejected", error: env.error.message };
  const envelope = env.data;
  const def = registry.get(envelope.type);
  if (!def) return { status: "parked", envelope, reason: "unknown-type" };
  if (envelope.v > def.current) return { status: "parked", envelope, reason: "newer-version" };
  const own = def.schemas.get(envelope.v);
  if (own && !own.safeParse(envelope.data).success) {
    return { status: "parked", envelope, reason: "invalid-payload" };
  }
  let data: Payload;
  try {
    data = upcast(envelope.type, envelope.data, envelope.v, def.current, def.upcasters);
  } catch {
    return { status: "parked", envelope, reason: "invalid-payload" };
  }
  const schema = def.schemas.get(def.current);
  const out = schema?.safeParse(data);
  if (!out?.success) return { status: "parked", envelope, reason: "invalid-payload" };
  const parsed = out.data as Payload;
  if (def.check && !def.check(envelope.gid, parsed)) {
    return { status: "parked", envelope, reason: "invalid-payload" };
  }
  return { status: "known", envelope, data: parsed };
}

/** Unknown envelope fields (preserved and ignored, events.md 2), canonical JSON or null. */
export function envelopeExtra(envelope: Envelope): string | null {
  const extra = Object.fromEntries(Object.entries(envelope).filter(([k]) => !ENVELOPE_KEYS.has(k)));
  return Object.keys(extra).length === 0 ? null : canonicalJson(extra);
}
