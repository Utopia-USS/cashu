// The event envelope (spec: events.md section 2). Loose: unknown envelope fields are preserved and
// ignored (forward compatibility, events.md section 7).
import { z } from "zod";
import { hlc } from "./hlc-format.js";
import { deviceId, EVENT_TYPE_RE, gid, jsonObject, timestamp, ulid } from "./primitives.js";

export const ORIGINS = ["genesis", "bridge"] as const;

export const envelopeSchema = z
  .looseObject({
    eid: ulid,
    vault: ulid,
    device: deviceId,
    hlc,
    at: timestamp,
    type: z.string().regex(EVENT_TYPE_RE, "expected <entity>.<verb>"),
    v: z.int().min(1),
    gid,
    data: jsonObject,
    cause: ulid.optional(),
    origin: z.enum(ORIGINS).optional(),
  })
  .refine((e) => e.hlc.slice(15) === e.device, {
    message: "the HLC device suffix must equal `device`",
    path: ["hlc"],
  });

export type Envelope = z.infer<typeof envelopeSchema>;

/**
 * Wire form inside an encrypted frame of the own-log carrier (spike-result.md `EventEnvelope`
 * `{t, v, h, d}`, events.md 2.1). The vault and the device are implied by the segment
 * (`<vault>/<device>/<seq>.seg`, authenticated as AAD), so they are not repeated; the extra keys carry
 * what the spike did not need: `i` eid (cause references, rollback tie-break), `g` gid (payloads do not
 * always name their entity), `a` wall time (domain timestamps), `c` cause, `o` origin.
 */
export const wireEventSchema = z.looseObject({
  t: z.string().regex(EVENT_TYPE_RE),
  v: z.int().min(1),
  h: hlc,
  d: jsonObject,
  i: ulid,
  g: gid,
  a: timestamp,
  c: ulid.optional(),
  o: z.enum(ORIGINS).optional(),
});

export type WireEvent = z.infer<typeof wireEventSchema>;

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
const WIRE_KEYS = new Set(["t", "v", "h", "d", "i", "g", "a", "c", "o"]);

/** Envelope -> wire. Unknown envelope fields travel under their own names (forward compatibility). */
export function toWire(e: Envelope): WireEvent {
  const extra = Object.fromEntries(Object.entries(e).filter(([k]) => !ENVELOPE_KEYS.has(k)));
  return {
    ...extra,
    t: e.type,
    v: e.v,
    h: e.hlc,
    d: e.data,
    i: e.eid,
    g: e.gid,
    a: e.at,
    ...(e.cause === undefined ? {} : { c: e.cause }),
    ...(e.origin === undefined ? {} : { o: e.origin }),
  };
}

/**
 * Wire + segment identity -> envelope (not yet validated: pass the result to `parseEvent`). The HLC
 * device suffix must equal the segment's device, which `envelopeSchema` checks.
 */
export function fromWire(w: Record<string, unknown>, segment: { vault: string; device: string }) {
  const extra = Object.fromEntries(Object.entries(w).filter(([k]) => !WIRE_KEYS.has(k)));
  return {
    ...extra,
    eid: w.i,
    vault: segment.vault,
    device: segment.device,
    hlc: w.h,
    at: w.a,
    type: w.t,
    v: w.v,
    gid: w.g,
    data: w.d,
    ...(w.c === undefined ? {} : { cause: w.c }),
    ...(w.o === undefined ? {} : { origin: w.o }),
  };
}
