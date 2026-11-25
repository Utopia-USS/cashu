/** The private notify-v1 helper wire. No visible copy or vault identity crosses this boundary. */
import { z } from "zod";

export const NOTIFY_VERSION = 1 as const;
export const NOTIFY_FRAME_MAX_BYTES = 4096;
export const NOTIFY_ACK_MAX_BYTES = 256;

export type NotifyLocale = "pl" | "en";
export type NotifyKind = "signal" | "signalsSummary" | "reviewDigest" | "generic";
export type NotifyAckStatus = "accepted" | "denied" | "pending" | "unavailable" | "rejected";
export interface NotifyFrame {
  readonly version: 1;
  readonly requestId: string;
  readonly locale: NotifyLocale;
  readonly kind: NotifyKind;
  readonly intentToken: string;
}
export interface NotifyAck {
  readonly version: 1;
  readonly requestId: string;
  readonly status: NotifyAckStatus;
}

const requestId = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
// Plain (stripping) objects: serialization writes only the known fields, and a parsed frame must
// re-serialize to exactly its own bytes, which refuses extra keys, reordering and whitespace.
const notifyFrameSchema = z.object({
  version: z.literal(NOTIFY_VERSION),
  requestId,
  locale: z.enum(["pl", "en"]),
  kind: z.enum(["signal", "signalsSummary", "reviewDigest", "generic"]),
  intentToken: z.string().regex(/^[0-9a-f]{64}$/),
});
const notifyAckSchema = z.object({
  version: z.literal(NOTIFY_VERSION),
  requestId,
  status: z.enum(["accepted", "denied", "pending", "unavailable", "rejected"]),
});
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function serializeNotifyFrame(input: NotifyFrame): Uint8Array {
  const parsed = notifyFrameSchema.safeParse(input);
  if (!parsed.success) throw new Error("invalid_notify_frame");
  const value = parsed.data;
  const bytes = encoder.encode(
    JSON.stringify({
      version: 1,
      requestId: value.requestId,
      locale: value.locale,
      kind: value.kind,
      intentToken: value.intentToken,
    }) + "\n",
  );
  if (bytes.length > NOTIFY_FRAME_MAX_BYTES) throw new Error("invalid_notify_frame");
  return bytes;
}

export function serializeNotifyAck(input: NotifyAck): Uint8Array {
  const parsed = notifyAckSchema.safeParse(input);
  if (!parsed.success) throw new Error("invalid_notify_ack");
  const value = parsed.data;
  const bytes = encoder.encode(
    JSON.stringify({
      version: 1,
      requestId: value.requestId,
      status: value.status,
    }) + "\n",
  );
  if (bytes.length > NOTIFY_ACK_MAX_BYTES) throw new Error("invalid_notify_ack");
  return bytes;
}

function parseCanonical<T>(
  bytes: Uint8Array,
  max: number,
  schema: z.ZodType<T>,
  serialize: (value: T) => Uint8Array,
  error: string,
): T {
  if (bytes.length === 0 || bytes.length > max || bytes[bytes.length - 1] !== 10)
    throw new Error(error);
  let raw: unknown;
  try {
    raw = JSON.parse(decoder.decode(bytes.subarray(0, -1)));
  } catch {
    throw new Error(error);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error(error);
  const canonical = serialize(parsed.data);
  if (canonical.length !== bytes.length || canonical.some((byte, i) => byte !== bytes[i]))
    throw new Error(error);
  return parsed.data;
}

export function parseNotifyFrame(bytes: Uint8Array): NotifyFrame {
  return parseCanonical(
    bytes,
    NOTIFY_FRAME_MAX_BYTES,
    notifyFrameSchema,
    serializeNotifyFrame,
    "invalid_notify_frame",
  );
}

export function parseNotifyAck(bytes: Uint8Array): NotifyAck {
  return parseCanonical(
    bytes,
    NOTIFY_ACK_MAX_BYTES,
    notifyAckSchema,
    serializeNotifyAck,
    "invalid_notify_ack",
  );
}
