// Document layout of the Firestore relay (M4-A section 3). Firebase sees only opaque ids (32-hex vault
// and device ids, anonymous uids), sizes, timestamps and ciphertext:
//
//   {root}/{vault}                                  { createdAt, admins }          (the Mac, not the transport)
//   {root}/{vault}/members/{uid}                    { device, role, addedAt }      (the Mac, not the transport)
//   {root}/{vault}/segments/{device}_{seg:010d}     { device, seg, size, updatedAt, writer, rev }
//   {root}/{vault}/segments/{device}_{seg}/chunks/{start:012d}   { start, end, bytes }
//
// Every id is validated before a path is built: a bad one is a programming error (`firestore_invalid_id`),
// never a request.
import type { DeviceId, VaultId } from "../../carrier.js";
import { DEVICE_RE } from "../../hlc.js";
import {
  bytes,
  type FsDocument,
  type FsValue,
  int,
  readBytes,
  readInt,
  readStr,
  str,
  ts,
} from "./rest.js";

/** A vault id as the S27 crypto layer makes it: 16 random bytes in lower hex. */
const VAULT_ID_RE = /^[0-9a-f]{32}$/;
/** A collection prefix: tests use a random one per medium, production "vaults". */
const ROOT_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const MAX_SEG = 9_999_999_999;
const MAX_START = 999_999_999_999;

export const SEGMENTS = "segments";
export const CHUNKS = "chunks";

function invalid(): Error {
  return new Error("firestore_invalid_id");
}

export function checkRoot(root: string): string {
  if (!ROOT_RE.test(root)) throw invalid();
  return root;
}

function checkVault(vault: VaultId): void {
  if (!VAULT_ID_RE.test(vault)) throw invalid();
}

function checkSegment(device: DeviceId, seg: number): void {
  if (!DEVICE_RE.test(device)) throw invalid();
  if (!Number.isSafeInteger(seg) || seg < 0 || seg > MAX_SEG) throw invalid();
}

/** `{root}/{vault}`: the parent of the `segments` collection. */
export function vaultPath(root: string, vault: VaultId): string {
  checkVault(vault);
  return `${root}/${vault}`;
}

export function segmentId(device: DeviceId, seg: number): string {
  checkSegment(device, seg);
  return `${device}_${String(seg).padStart(10, "0")}`;
}

/** `{root}/{vault}/segments/{device}_{seg:010d}`: the segment's meta document, parent of its chunks. */
export function segmentPath(root: string, vault: VaultId, device: DeviceId, seg: number): string {
  return `${vaultPath(root, vault)}/${SEGMENTS}/${segmentId(device, seg)}`;
}

export function chunkPath(segment: string, start: number): string {
  if (!Number.isSafeInteger(start) || start < 0 || start > MAX_START) throw invalid();
  return `${segment}/${CHUNKS}/${String(start).padStart(12, "0")}`;
}

/** The last path segment of a document name (full or relative). */
function documentId(name: string): string {
  return name.slice(name.lastIndexOf("/") + 1);
}

// Segment meta.

export interface SegmentMeta {
  readonly device: DeviceId;
  readonly seg: number;
  /** Committed size: readers never see bytes beyond it. */
  readonly size: number;
  /** Commits so far (+1 per commit, so every meta write changes the document); 0 on a projection. */
  readonly rev: number;
  /** The document's updateTime (the precondition of the next append), absent on a projection. */
  readonly updateTime?: string;
}

export function metaFields(input: {
  device: DeviceId;
  seg: number;
  size: number;
  writer: string;
  at: number;
  rev: number;
}): Record<string, FsValue> {
  return {
    device: str(input.device),
    seg: int(input.seg),
    size: int(input.size),
    updatedAt: ts(new Date(input.at).toISOString()),
    writer: str(input.writer),
    rev: int(input.rev),
  };
}

/** The meta of a segment document, or undefined when it does not have the layout's shape. */
export function parseMeta(doc: FsDocument): SegmentMeta | undefined {
  try {
    const device = readStr(doc.fields.device);
    const seg = readInt(doc.fields.seg);
    const size = readInt(doc.fields.size);
    // `list` projects without `rev`; a full read always has it.
    const rev = doc.fields.rev === undefined ? 0 : readInt(doc.fields.rev);
    if (!DEVICE_RE.test(device) || seg < 0 || seg > MAX_SEG || size < 0 || rev < 0) {
      return undefined;
    }
    if (documentId(doc.name) !== segmentId(device, seg)) return undefined;
    return { device, seg, size, rev, ...(doc.updateTime ? { updateTime: doc.updateTime } : {}) };
  } catch {
    return undefined;
  }
}

// Chunks.

export interface Chunk {
  readonly start: number;
  readonly end: number;
  readonly bytes: Uint8Array;
  /** When the chunk was last written; orders an orphan of an interrupted append before the committed chunk. */
  readonly written: string;
}

export function chunkFields(start: number, data: Uint8Array): Record<string, FsValue> {
  return { start: int(start), end: int(start + data.length), bytes: bytes(data) };
}

/** A chunk document, or undefined when its shape does not hold (`end - start` must match the bytes). */
export function parseChunk(doc: FsDocument): Chunk | undefined {
  try {
    const start = readInt(doc.fields.start);
    const end = readInt(doc.fields.end);
    const data = readBytes(doc.fields.bytes);
    if (start < 0 || end - start !== data.length) return undefined;
    if (documentId(doc.name) !== String(start).padStart(12, "0")) return undefined;
    return { start, end, bytes: data, written: timeKey(doc.updateTime ?? "") };
  } catch {
    return undefined;
  }
}

/**
 * An RFC 3339 UTC time that sorts as a string: the API emits 0, 3, 6 or 9 fraction digits, so the
 * fraction is padded to nanoseconds.
 */
export function timeKey(iso: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(iso);
  if (!match) return "";
  return `${match[1]}.${(match[2] ?? "").padEnd(9, "0")}`;
}
