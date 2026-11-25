// Errors of the sync layer. Messages are fixed strings: they never carry event data, ids of rows,
// keys or payload bytes, so an error that reaches a log or a bug report leaks nothing.

export type SyncErrorCode =
  /** The physical clock is behind the persisted HLC by more than the drift limit (events.md 3.3). */
  | "clock-behind"
  /** A supplied folded high-water mark is too far ahead to merge before a local write. */
  | "remote-far-future"
  /** The persisted clock is behind this device's own events in the log: restored backup or cloned disk. */
  | "rolled-back"
  /** An event handed to `write` does not have the wire shape the engine needs. */
  | "invalid-event"
  /** One event alone is larger than the hard frame limit. */
  | "frame-too-large"
  /** The engine was closed. */
  | "closed"
  /** Options handed to the engine are invalid (bad vault or device id). */
  | "invalid-config"
  /** The own append may have landed; no further own write is safe until local recovery rebases it. */
  | "own-tail-uncertain"
  /** An authenticated historical claim may change the authority prefix after exact lookup. */
  | "authority-unresolved";

export class SyncError extends Error {
  readonly code: SyncErrorCode;
  constructor(code: SyncErrorCode, message: string) {
    super(message);
    this.name = "SyncError";
    this.code = code;
  }
}

export type TransportErrorCode =
  /** `append` at an offset that is not the current size of the segment (somebody else wrote, or a retry). */
  | "offset-conflict"
  /** The transport cannot be reached right now (offline relay, unmounted folder). Retry later. */
  | "unavailable";

/**
 * Why an `unavailable` transport could not be used. Only `outage` is a true outage (network, timeout,
 * 5xx, quota, the host's own back-off after one): the fetch lease may rely on a pass that missed only
 * such remotes (D6). The rest mean the remote answered and will keep answering the same way until
 * something changes: `refused` (this device is no longer a member), `identity-lost` (its relay
 * identity was replaced), `protocol` (an answer that does not decode, a segment with a gap).
 */
export type TransportUnavailableReason = "outage" | "refused" | "identity-lost" | "protocol";

export class TransportError extends Error {
  readonly code: TransportErrorCode;
  /**
   * For `unavailable`: why, always named by the thrower (no default: a site that does not know must
   * not pass for an outage). Always `outage` for `offset-conflict`, which takes no reason.
   */
  readonly reason: TransportUnavailableReason;
  constructor(code: "offset-conflict", message: string);
  constructor(code: "unavailable", message: string, reason: TransportUnavailableReason);
  constructor(code: TransportErrorCode, message: string, reason?: TransportUnavailableReason) {
    super(message);
    this.name = "TransportError";
    this.code = code;
    // Untyped callers only: an unnamed reason fails closed (`protocol`, D6), never as an outage.
    this.reason = code === "unavailable" ? (reason ?? "protocol") : "outage";
  }
}

/**
 * Thrown by a `FrameCodec` when a frame does not open: tampered, truncated, wrong key, wrong position
 * (the AAD binds vault, device, segment and offset). `code` is the codec's own (S27 `CryptoError`
 * codes pass through), the engine only records it.
 */
export class FrameRejectedError extends Error {
  readonly code: string;
  constructor(code: string, message = "frame rejected") {
    super(message);
    this.name = "FrameRejectedError";
    this.code = code;
  }
}

export function isTransportUnavailable(e: unknown): boolean {
  return e instanceof TransportError && e.code === "unavailable";
}

/** A transport `unavailable` because of a true outage (D6), not a refusal or a protocol failure. */
export function isTransportOutage(e: unknown): boolean {
  return e instanceof TransportError && e.code === "unavailable" && e.reason === "outage";
}

/** Codec errors come from plug-ins (S27 crypto); keep their `code` when they have one. */
export function rejectionCode(e: unknown): string {
  if (e instanceof FrameRejectedError) return e.code;
  if (typeof e === "object" && e !== null && "code" in e && typeof e.code === "string") {
    return e.code;
  }
  return "codec-error";
}
