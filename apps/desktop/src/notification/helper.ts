import type { Readable, Writable } from "node:stream";
import {
  NOTIFY_FRAME_MAX_BYTES,
  type NotifyAck,
  type NotifyFrame,
  parseNotifyFrame,
  serializeNotifyAck,
} from "@cashu/host-protocol";
import { processFlavor } from "@cashu/node-host/flavor";
import { loadNativeNotificationCenter, type NativeNotificationCenter } from "./native.js";

const INPUT_DEADLINE_MS = 3_000;
const POST_DEADLINE_MS = 8_000;

async function readOneFrame(input: Readable): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > NOTIFY_FRAME_MAX_BYTES) throw new Error("invalid_notify_frame");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

function withDeadline<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("notification_deadline")), milliseconds);
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

/** Returns no ACK if the native add result is ambiguous. The host preserves its claim. */
export async function processNotificationFrame(
  bytes: Uint8Array,
  center: NativeNotificationCenter,
): Promise<NotifyAck | null> {
  const frame: NotifyFrame = parseNotifyFrame(bytes);
  const identity = center.identity();
  if (!identity.verified || identity.bundleIdentifier !== processFlavor().bundleId) return null;
  let permission: Awaited<ReturnType<NativeNotificationCenter["permissionStatus"]>>;
  try {
    permission = await center.permissionStatus();
  } catch {
    permission = "unavailable";
  }
  if (permission !== "allowed") {
    if (!["denied", "pending", "unavailable"].includes(permission)) return null;
    return { version: 1, requestId: frame.requestId, status: permission };
  }
  // A generic native rejection is only legal before add. Native maps every add completion
  // error, timeout, or lost callback to unknown, so no definite ACK can escape here.
  const status = await withDeadline(center.post(frame), POST_DEADLINE_MS);
  if (status === "unknown") return null;
  if (status !== "accepted" && status !== "rejected") return null;
  return { version: 1, requestId: frame.requestId, status };
}

export async function runNotificationHelperWith(
  input: Readable,
  output: Writable,
  center: NativeNotificationCenter | null,
): Promise<number> {
  if (!center) return 2;
  let bytes: Uint8Array;
  try {
    bytes = await withDeadline(readOneFrame(input), INPUT_DEADLINE_MS);
  } catch {
    return 2;
  }
  let ack: NotifyAck | null;
  try {
    ack = await processNotificationFrame(bytes, center);
  } catch {
    return 2;
  }
  if (!ack) return 2;
  try {
    const frame = serializeNotifyAck(ack);
    await new Promise<void>((resolve, reject) => {
      output.write(frame, (error) => (error ? reject(error) : resolve()));
    });
    return 0;
  } catch {
    return 2;
  }
}

/** One-shot early Electron entry. Does not import ordinary desktop startup. */
export async function runNotificationHelper(): Promise<number> {
  return runNotificationHelperWith(process.stdin, process.stdout, loadNativeNotificationCenter());
}
