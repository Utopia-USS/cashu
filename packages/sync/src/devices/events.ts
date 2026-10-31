// The device and lease events (events.md 8.11 reserves `device.*` and `lease.*` for S29), their
// strict decoding at the log boundary and their signed construction.
//
// Every statement except `device.keysRotated` carries an Ed25519 signature (statements.ts):
//   body = lp(vault id) | lp(type) | lp(eid) | lp(canonical JSON of data without "sig")
// so a statement cannot be moved to another vault, retyped, re-keyed under another eid or edited.
// `device.keysRotated` carries crypto's signed wraps (`wrapKeys`), which authenticate themselves.
// The HLC is not signed (the engine stamps it after the command built the event).

import type { InboundBatch, SegmentCursor, UnstampedEvent } from "../carrier.js";
import {
  type DeviceIdentity,
  isDeviceId,
  RECOVERY_SIGNER_ID,
  type RecoveryIdentity,
} from "../crypto/index.js";
import { type Hlc, isHlc } from "../hlc.js";
import {
  type CanonicalValue,
  canonicalJson,
  concat,
  isCanonicalValue,
  isHex,
  isRecord,
  lp,
  toHex,
  utf8,
} from "./bytes.js";
import { SIGNATURE_BYTES, type StatementContext, signStatement } from "./statements.js";

export const DEVICE_ADDED = "device.added";
export const DEVICE_REVOKED = "device.revoked";
export const KEYS_ROTATED = "device.keysRotated";
export const LEASE_CLAIMED = "lease.claimed";
export const LEASE_RENEWED = "lease.renewed";
export const LEASE_RELEASED = "lease.released";

/** Every event type this module defines is at schema version 1. */
export const DEVICE_EVENT_VERSION = 1;

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_NAME = 64;
const MAX_LIST = 256;
const CERT_HEX = 2 * (1 + 16 + 16 + 32 + 32 + 64);
const MAX_WRAP_HEX = 2 * 64 * 1024;

/**
 * One event as the store hands it over after applying a batch (`logEventsFromBatch`). `writer` and
 * `position` come from the segment (authenticated as frame AAD): `position` is the cursor after the
 * batch that carried the event, so an event is before a cut `c` exactly when `position <= c`.
 */
export interface LogEvent {
  readonly eid: string;
  readonly hlc: Hlc;
  readonly writer: string;
  readonly position: SegmentCursor;
  readonly type: string;
  readonly v: number;
  readonly data: Readonly<Record<string, unknown>>;
}

export function logEventsFromBatch(batch: InboundBatch): LogEvent[] {
  return batch.events.map((e) => ({
    eid: e.i,
    hlc: e.h,
    writer: batch.device,
    position: batch.cursor,
    type: e.t,
    v: e.v,
    data: e.d,
  }));
}

export function isUlid(value: unknown): value is string {
  return typeof value === "string" && ULID.test(value);
}

export function comparePositions(a: SegmentCursor, b: SegmentCursor): number {
  return a.seg - b.seg || a.offset - b.offset;
}

/** Fold order of the log (events.md 2): HLC, then eid. */
export function byHlc(a: LogEvent, b: LogEvent): number {
  if (a.hlc !== b.hlc) return a.hlc < b.hlc ? -1 : 1;
  return a.eid < b.eid ? -1 : a.eid > b.eid ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------
// Payloads

export interface DeviceAddedData {
  readonly device: string;
  readonly signPublicKey: string;
  readonly boxPublicKey: string;
  readonly name: string;
  /** The device certificate (crypto `certifyDevice`), lowercase hex. */
  readonly certificate: string;
  /** Who signed this statement: the writer, or `RECOVERY_SIGNER_ID` at vault creation. */
  readonly signer: string;
  readonly sig: string;
}

export interface RevokedEntry {
  readonly device: string;
  /** First position of the device's own stream that is no longer accepted (its revocation point). */
  readonly cut: SegmentCursor;
}

export interface DeviceRevokedData {
  readonly devices: readonly RevokedEntry[];
  readonly signer: string;
  readonly sig: string;
}

export interface KeysRotatedData {
  /** Recipient device id (or `RECOVERY_SIGNER_ID`) -> crypto signed wrap, lowercase hex. */
  readonly wraps: Readonly<Record<string, string>>;
}

/** Per writer device: the highest HLC of that device's stream the lease holder had applied. */
export type Watermark = Readonly<Record<string, Hlc>>;

export interface LeaseClaimData {
  readonly device: string;
  /** Wall-clock ms (the claimer's clock) until which the lease is held. */
  readonly until: number;
  readonly watermark: Watermark;
  /** Eid of the last valid lease event the claimer saw (null: none yet). Compare-and-set. */
  readonly prev: string | null;
  readonly sig: string;
}

export interface LeaseRenewData {
  readonly device: string;
  readonly until: number;
  readonly watermark: Watermark;
  readonly prev: string;
  readonly sig: string;
}

export interface LeaseReleaseData {
  readonly device: string;
  readonly watermark: Watermark;
  readonly prev: string;
  readonly sig: string;
}

// ---------------------------------------------------------------------------------------------
// Signed bodies

export function statementBody(
  vaultId: string,
  type: string,
  eid: string,
  data: Readonly<Record<string, unknown>>,
): Uint8Array {
  const { sig: _sig, ...unsigned } = data;
  if (!isCanonicalValue(unsigned)) throw new RangeError("statement data is not canonical JSON");
  return concat(
    lp(utf8(vaultId)),
    lp(utf8(type)),
    lp(utf8(eid)),
    lp(utf8(canonicalJson(unsigned))),
  );
}

function signed(
  signer: DeviceIdentity | RecoveryIdentity,
  context: StatementContext,
  vaultId: string,
  type: string,
  eid: string,
  data: { readonly [key: string]: CanonicalValue },
): UnstampedEvent {
  if (!isUlid(eid)) throw new RangeError("eid must be a ULID");
  const sig = toHex(signStatement(signer, context, statementBody(vaultId, type, eid, data)));
  return { t: type, v: DEVICE_EVENT_VERSION, i: eid, d: { ...data, sig } };
}

export function buildDeviceAdded(
  signer: DeviceIdentity | RecoveryIdentity,
  vaultId: string,
  eid: string,
  subject: { deviceId: string; signPublicKey: Uint8Array; boxPublicKey: Uint8Array },
  name: string,
  certificate: Uint8Array,
): UnstampedEvent {
  if (!isDeviceName(name)) throw new RangeError("device name must be 1-64 printable characters");
  return signed(signer, "cashu/registry/v1", vaultId, DEVICE_ADDED, eid, {
    device: subject.deviceId,
    signPublicKey: toHex(subject.signPublicKey),
    boxPublicKey: toHex(subject.boxPublicKey),
    name,
    certificate: toHex(certificate),
    signer: signer.deviceId,
  });
}

export function buildDeviceRevoked(
  signer: DeviceIdentity | RecoveryIdentity,
  vaultId: string,
  eid: string,
  entries: readonly RevokedEntry[],
): UnstampedEvent {
  if (entries.length === 0 || entries.length > MAX_LIST)
    throw new RangeError("revoke 1-256 devices");
  return signed(signer, "cashu/registry/v1", vaultId, DEVICE_REVOKED, eid, {
    devices: entries.map((e) => ({
      device: e.device,
      cut: { seg: e.cut.seg, offset: e.cut.offset },
    })),
    signer: signer.deviceId,
  });
}

export function buildKeysRotated(
  eid: string,
  wraps: ReadonlyMap<string, Uint8Array>,
): UnstampedEvent {
  if (!isUlid(eid)) throw new RangeError("eid must be a ULID");
  const record: Record<string, string> = {};
  for (const [recipient, wire] of wraps) record[recipient] = toHex(wire);
  return { t: KEYS_ROTATED, v: DEVICE_EVENT_VERSION, i: eid, d: { wraps: record } };
}

export function buildLeaseClaim(
  identity: DeviceIdentity,
  vaultId: string,
  eid: string,
  fields: { until: number; watermark: Watermark; prev: string | null },
): UnstampedEvent {
  return signed(identity, "cashu/lease/v1", vaultId, LEASE_CLAIMED, eid, {
    device: identity.deviceId,
    until: fields.until,
    watermark: { ...fields.watermark },
    prev: fields.prev,
  });
}

export function buildLeaseRenewal(
  identity: DeviceIdentity,
  vaultId: string,
  eid: string,
  fields: { until: number; watermark: Watermark; prev: string },
): UnstampedEvent {
  return signed(identity, "cashu/lease/v1", vaultId, LEASE_RENEWED, eid, {
    device: identity.deviceId,
    until: fields.until,
    watermark: { ...fields.watermark },
    prev: fields.prev,
  });
}

export function buildLeaseRelease(
  identity: DeviceIdentity,
  vaultId: string,
  eid: string,
  fields: { watermark: Watermark; prev: string },
): UnstampedEvent {
  return signed(identity, "cashu/lease/v1", vaultId, LEASE_RELEASED, eid, {
    device: identity.deviceId,
    watermark: { ...fields.watermark },
    prev: fields.prev,
  });
}

// ---------------------------------------------------------------------------------------------
// Decoding (the log is a trust boundary: anything malformed is ignored and reported, never thrown)

/** A device display name: 1-64 characters, not blank, no control characters. */
export function isDeviceName(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_NAME) {
    return false;
  }
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false;
  }
  return true;
}

function isSignerId(value: unknown): value is string {
  return typeof value === "string" && (isDeviceId(value) || value === RECOVERY_SIGNER_ID);
}

function isCursor(value: unknown): value is SegmentCursor {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    Number.isSafeInteger(value.seg) &&
    (value.seg as number) >= 1 &&
    Number.isSafeInteger(value.offset) &&
    (value.offset as number) >= 0
  );
}

function isWatermark(value: unknown): value is Watermark {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length <= MAX_LIST && entries.every(([device, hlc]) => isDeviceId(device) && isHlc(hlc))
  );
}

function hasExactly(data: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const present = Object.keys(data);
  return present.length === keys.length && keys.every((k) => k in data);
}

function isSig(value: unknown): value is string {
  return isHex(value, SIGNATURE_BYTES);
}

function isUntil(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export function decodeDeviceAdded(
  data: Readonly<Record<string, unknown>>,
): DeviceAddedData | undefined {
  if (
    !hasExactly(data, [
      "device",
      "signPublicKey",
      "boxPublicKey",
      "name",
      "certificate",
      "signer",
      "sig",
    ])
  ) {
    return undefined;
  }
  const { device, signPublicKey, boxPublicKey, name, certificate, signer, sig } = data;
  if (
    typeof device !== "string" ||
    !isDeviceId(device) ||
    !isHex(signPublicKey, 32) ||
    !isHex(boxPublicKey, 32) ||
    !isDeviceName(name) ||
    typeof certificate !== "string" ||
    certificate.length !== CERT_HEX ||
    !isHex(certificate) ||
    !isSignerId(signer) ||
    !isSig(sig)
  ) {
    return undefined;
  }
  return { device, signPublicKey, boxPublicKey, name, certificate, signer, sig };
}

export function decodeDeviceRevoked(
  data: Readonly<Record<string, unknown>>,
): DeviceRevokedData | undefined {
  if (!hasExactly(data, ["devices", "signer", "sig"])) return undefined;
  const { devices, signer, sig } = data;
  if (!Array.isArray(devices) || devices.length === 0 || devices.length > MAX_LIST)
    return undefined;
  if (!isSignerId(signer) || !isSig(sig)) return undefined;
  const entries: RevokedEntry[] = [];
  const seen = new Set<string>();
  for (const e of devices) {
    if (!isRecord(e) || !hasExactly(e, ["device", "cut"])) return undefined;
    const { device, cut } = e;
    if (typeof device !== "string" || !isDeviceId(device) || seen.has(device) || !isCursor(cut)) {
      return undefined;
    }
    seen.add(device);
    entries.push({ device, cut: { seg: cut.seg, offset: cut.offset } });
  }
  return { devices: entries, signer, sig };
}

export function decodeKeysRotated(
  data: Readonly<Record<string, unknown>>,
): KeysRotatedData | undefined {
  if (!hasExactly(data, ["wraps"]) || !isRecord(data.wraps)) return undefined;
  const entries = Object.entries(data.wraps);
  if (entries.length === 0 || entries.length > MAX_LIST) return undefined;
  const wraps: Record<string, string> = {};
  for (const [recipient, wire] of entries) {
    if (!isSignerId(recipient) || !isHex(wire) || wire.length > MAX_WRAP_HEX) return undefined;
    wraps[recipient] = wire;
  }
  return { wraps };
}

export function decodeLeaseClaim(
  data: Readonly<Record<string, unknown>>,
): LeaseClaimData | undefined {
  if (!hasExactly(data, ["device", "until", "watermark", "prev", "sig"])) return undefined;
  const { device, until, watermark, prev, sig } = data;
  if (
    typeof device !== "string" ||
    !isDeviceId(device) ||
    !isUntil(until) ||
    !isWatermark(watermark) ||
    !(prev === null || isUlid(prev)) ||
    !isSig(sig)
  ) {
    return undefined;
  }
  return { device, until, watermark, prev, sig };
}

export function decodeLeaseRenewal(
  data: Readonly<Record<string, unknown>>,
): LeaseRenewData | undefined {
  if (!hasExactly(data, ["device", "until", "watermark", "prev", "sig"])) return undefined;
  const { device, until, watermark, prev, sig } = data;
  if (
    typeof device !== "string" ||
    !isDeviceId(device) ||
    !isUntil(until) ||
    !isWatermark(watermark) ||
    !isUlid(prev) ||
    !isSig(sig)
  ) {
    return undefined;
  }
  return { device, until, watermark, prev, sig };
}

export function decodeLeaseRelease(
  data: Readonly<Record<string, unknown>>,
): LeaseReleaseData | undefined {
  if (!hasExactly(data, ["device", "watermark", "prev", "sig"])) return undefined;
  const { device, watermark, prev, sig } = data;
  if (
    typeof device !== "string" ||
    !isDeviceId(device) ||
    !isWatermark(watermark) ||
    !isUlid(prev) ||
    !isSig(sig)
  ) {
    return undefined;
  }
  return { device, watermark, prev, sig };
}
