// The per-device manifest stream: segment 0 of every device (the engine's segments start at 1).
//
//   segment 0 = frame*, framed and sealed exactly like event segments (`u32 BE length | sealed`, the
//   codec binds each record to (vault, device, 0, offset)), so storage can neither forge nor move a
//   record. Plaintext = UTF-8 JSON, one record per frame:
//     {"m":1,"k":"closed","s":N,"z":bytes}        segment N is final at `bytes` (written before N + 1)
//     {"m":1,"k":"snapshot","s":N,"o":off,"r":ref} a snapshot covers this stream up to (N, off) (S32)
//     {"m":1,"k":"retired","s":N}                 segments below N may be removed (compaction, S32)
//
// Append-only, like everything in the log, so it works on a synced folder and on the relay. Records
// are facts that never change; a reader keeps every record it verified even if storage later shows an
// older (shorter) stream. Unknown kinds with `m: 1` are skipped (additive); another `m` stops the
// stream (an upgrade is needed).
import type { SegmentCursor } from "../../carrier.js";
import { utf8Decode, utf8Encode } from "../../runtime.js";
import { isRecord } from "../../segment.js";

export const MANIFEST_SEG = 0;
const MANIFEST_FORMAT = 1;
/** Snapshot references are opaque to the carrier (S32 defines them); keep them short and inert. */
export const SNAPSHOT_REF_RE = /^[0-9A-Za-z._:-]{1,128}$/;

export type ManifestRecord =
  | { readonly kind: "closed"; readonly seg: number; readonly size: number }
  | { readonly kind: "snapshot"; readonly at: SegmentCursor; readonly ref: string }
  | { readonly kind: "retired"; readonly before: number };

export function encodeRecord(record: ManifestRecord): Uint8Array {
  switch (record.kind) {
    case "closed":
      return utf8Encode(JSON.stringify({ m: 1, k: "closed", s: record.seg, z: record.size }));
    case "snapshot":
      return utf8Encode(
        JSON.stringify({
          m: 1,
          k: "snapshot",
          s: record.at.seg,
          o: record.at.offset,
          r: record.ref,
        }),
      );
    case "retired":
      return utf8Encode(JSON.stringify({ m: 1, k: "retired", s: record.before }));
  }
}

const isSeg = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 1;
const isSize = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;

export type DecodedRecord =
  | { readonly ok: true; readonly record: ManifestRecord | undefined }
  | { readonly ok: false; readonly code: "malformed" | "frame-format" };

/** `record: undefined` = a well-formed record of a kind this version does not know (skip it). */
export function decodeRecord(plain: Uint8Array): DecodedRecord {
  let body: unknown;
  try {
    body = JSON.parse(utf8Decode(plain));
  } catch {
    return { ok: false, code: "malformed" };
  }
  if (!isRecord(body) || typeof body.m !== "number" || typeof body.k !== "string") {
    return { ok: false, code: "malformed" };
  }
  if (body.m !== MANIFEST_FORMAT) return { ok: false, code: "frame-format" };
  switch (body.k) {
    case "closed":
      return isSeg(body.s) && isSize(body.z)
        ? { ok: true, record: { kind: "closed", seg: body.s, size: body.z } }
        : { ok: false, code: "malformed" };
    case "snapshot":
      return isSeg(body.s) &&
        isSize(body.o) &&
        typeof body.r === "string" &&
        SNAPSHOT_REF_RE.test(body.r)
        ? {
            ok: true,
            record: { kind: "snapshot", at: { seg: body.s, offset: body.o }, ref: body.r },
          }
        : { ok: false, code: "malformed" };
    case "retired":
      return isSeg(body.s)
        ? { ok: true, record: { kind: "retired", before: body.s } }
        : { ok: false, code: "malformed" };
    default:
      return { ok: true, record: undefined };
  }
}
