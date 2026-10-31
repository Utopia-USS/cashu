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
