/** The private notify-v1 helper wire. No visible copy or vault identity crosses this boundary. */
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

const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const tokenPattern = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function validRequestId(value: unknown): value is string {
  return typeof value === "string" && requestIdPattern.test(value);
}

export function serializeNotifyFrame(value: NotifyFrame): Uint8Array {
  if (
    value.version !== 1 ||
    !validRequestId(value.requestId) ||
    (value.locale !== "pl" && value.locale !== "en") ||
    !["signal", "signalsSummary", "reviewDigest", "generic"].includes(value.kind) ||
    typeof value.intentToken !== "string" ||
    !tokenPattern.test(value.intentToken)
  )
    throw new Error("invalid_notify_frame");
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

export function serializeNotifyAck(value: NotifyAck): Uint8Array {
  if (
    value.version !== 1 ||
    !validRequestId(value.requestId) ||
    !["accepted", "denied", "pending", "unavailable", "rejected"].includes(value.status)
  )
    throw new Error("invalid_notify_ack");
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
  serialize: (value: T) => Uint8Array,
  error: string,
): T {
  if (bytes.length === 0 || bytes.length > max || bytes[bytes.length - 1] !== 10)
    throw new Error(error);
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes.subarray(0, -1)));
  } catch {
    throw new Error(error);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(error);
  let canonical: Uint8Array;
  try {
    canonical = serialize(value as T);
  } catch {
    throw new Error(error);
  }
  if (canonical.length !== bytes.length || canonical.some((byte, i) => byte !== bytes[i]))
    throw new Error(error);
  return value as T;
}

export function parseNotifyFrame(bytes: Uint8Array): NotifyFrame {
  return parseCanonical(
    bytes,
    NOTIFY_FRAME_MAX_BYTES,
    serializeNotifyFrame,
    "invalid_notify_frame",
  );
}

export function parseNotifyAck(bytes: Uint8Array): NotifyAck {
  return parseCanonical(bytes, NOTIFY_ACK_MAX_BYTES, serializeNotifyAck, "invalid_notify_ack");
}
