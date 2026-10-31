// Segment framing and frame payloads (own-log format, spike-result.md, refined).
//
// segment = frame*                         (no header; the codec's sealed bytes carry their own version)
// frame   = u32 big-endian length | sealed (length counts the sealed bytes only)
// plain   = UTF-8 JSON {"f": 1, "e": [wire events], "p": [index, count]?}
//           `f` payload format version; `p` present only in a frame group (a batch too large for one
//           frame): frames index 0..count-1 written back to back, applied together as one batch.
import type { WireEvent } from "./carrier.js";
import { HLC_RE } from "./hlc.js";
import { utf8Decode, utf8Encode } from "./runtime.js";

export const FRAME_FORMAT = 1;
export const LENGTH_BYTES = 4;
/** Readers reject a frame whose length prefix exceeds this (corrupt prefix, not a real frame). */
export const MAX_SEALED_FRAME_BYTES = 64 * 1024 * 1024;

export function frameBytes(sealed: Uint8Array): Uint8Array {
  const out = new Uint8Array(LENGTH_BYTES + sealed.length);
  new DataView(out.buffer).setUint32(0, sealed.length, false);
  out.set(sealed, LENGTH_BYTES);
  return out;
}

export interface ScannedFrame {
  /** Absolute offset of the length prefix in the segment. */
  readonly offset: number;
  /** Absolute offset just after the frame. */
  readonly end: number;
  readonly sealed: Uint8Array;
}

export interface ScanResult {
  readonly frames: readonly ScannedFrame[];
  /** Bytes after the last complete frame (a frame still arriving), or a corrupt length prefix. */
  readonly tail: "none" | "partial" | "too-large";
  /** Absolute offset where the tail starts (= end of the last complete frame). */
  readonly tailOffset: number;
}

/** Split `bytes` (which start at absolute `baseOffset`, on a frame boundary) into complete frames. */
export function scanFrames(bytes: Uint8Array, baseOffset: number): ScanResult {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frames: ScannedFrame[] = [];
  let p = 0;
  while (p < bytes.length) {
    if (p + LENGTH_BYTES > bytes.length) {
      return { frames, tail: "partial", tailOffset: baseOffset + p };
    }
    const len = view.getUint32(p, false);
    if (len > MAX_SEALED_FRAME_BYTES)
      return { frames, tail: "too-large", tailOffset: baseOffset + p };
    const end = p + LENGTH_BYTES + len;
    if (end > bytes.length) return { frames, tail: "partial", tailOffset: baseOffset + p };
    frames.push({
      offset: baseOffset + p,
      end: baseOffset + end,
      sealed: bytes.subarray(p + LENGTH_BYTES, end),
    });
    p = end;
  }
  return { frames, tail: "none", tailOffset: baseOffset + p };
}

export interface FramePayload {
  readonly events: readonly WireEvent[];
  /** `[index, count]` inside a frame group; undefined for a single-frame batch. */
  readonly part?: readonly [number, number];
}

export function encodePayload(payload: FramePayload): Uint8Array {
  const body: Record<string, unknown> = { f: FRAME_FORMAT, e: payload.events };
  if (payload.part) body.p = payload.part;
  return utf8Encode(JSON.stringify(body));
}

export type DecodeResult =
  | { readonly ok: true; readonly payload: FramePayload }
  | { readonly ok: false; readonly code: "malformed" | "frame-format" };

/** Parse and check a frame's plaintext. `device` is the segment's device (HLC suffix must match). */
export function decodePayload(plain: Uint8Array, device: string): DecodeResult {
  let body: unknown;
  try {
    body = JSON.parse(utf8Decode(plain));
  } catch {
    return { ok: false, code: "malformed" };
  }
  if (!isRecord(body) || typeof body.f !== "number") return { ok: false, code: "malformed" };
  if (body.f !== FRAME_FORMAT) return { ok: false, code: "frame-format" };
  const events = body.e;
  if (!Array.isArray(events) || events.length === 0) return { ok: false, code: "malformed" };
  let prev = "";
  for (const e of events) {
    if (!isWireEvent(e) || e.h.slice(15) !== device || e.h <= prev) {
      return { ok: false, code: "malformed" };
    }
    prev = e.h;
  }
  let part: [number, number] | undefined;
  if (body.p !== undefined) {
    const p = body.p;
    if (
      !Array.isArray(p) ||
      p.length !== 2 ||
      !Number.isSafeInteger(p[0]) ||
      !Number.isSafeInteger(p[1]) ||
      p[1] < 2 ||
      p[0] < 0 ||
      p[0] >= p[1]
    ) {
      return { ok: false, code: "malformed" };
    }
    part = [p[0], p[1]];
  }
  return { ok: true, payload: part ? { events, part } : { events } };
}

export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isWireEvent(e: unknown): e is WireEvent {
  return (
    isRecord(e) &&
    typeof e.t === "string" &&
    e.t.length > 0 &&
    Number.isSafeInteger(e.v) &&
    (e.v as number) >= 1 &&
    typeof e.h === "string" &&
    HLC_RE.test(e.h) &&
    typeof e.i === "string" &&
    e.i.length > 0 &&
    isRecord(e.d)
  );
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
