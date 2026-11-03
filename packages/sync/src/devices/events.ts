// The device and lease events (events.md 8.11 reserves `device.*` and `lease.*` for S29), their
// strict decoding at the log boundary and their signed construction.
//
// Every statement except `device.keysRotated` carries an Ed25519 signature (statements.ts):
//   body = lp(vault id) | lp(type) | lp(eid) | lp(canonical JSON of data without "sig")
// so a statement cannot be moved to another vault, retyped, re-keyed under another eid or edited.
// `device.keysRotated` carries crypto's signed wraps (`wrapKeys`), which authenticate themselves.
// The HLC is not signed (the engine stamps it after the command built the event), so nothing in the
// registry or the lease chain is decided by it: revocations by stream positions (registry.ts), the
// lease by its `prev` links (lease.ts); the HLC only breaks ties between otherwise equal candidates.

import type { InboundBatch, SegmentCursor, UnstampedEvent } from "../carrier.js";
import {
  type DeviceIdentity,
  decodeHead,
  encodeHead,
  isDeviceId,
  RECOVERY_SIGNER_ID,
  type RecoveryIdentity,
  type SignedHead,
} from "../crypto/index.js";
import type { Hlc } from "../hlc.js";
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
import { comparePositions } from "./positions.js";
import { SIGNATURE_BYTES, type StatementContext, signStatement } from "./statements.js";

export { comparePositions };

export const DEVICE_ADDED = "device.added";
export const DEVICE_REVOKED = "device.revoked";
export const KEYS_ROTATED = "device.keysRotated";
export const LEASE_CLAIMED = "lease.claimed";
export const LEASE_RENEWED = "lease.renewed";
export const LEASE_RELEASED = "lease.released";
export const LEASE_PINNED = "lease.pinned";
export const LEASE_FETCHED = "lease.fetched";
export const RECOVERY_CHANGED = "device.recoveryChanged";
export const HEADS_GOSSIPED = "device.headsGossiped";

/** Every event type this module defines is at schema version 1. */
export const DEVICE_EVENT_VERSION = 1;

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_NAME = 64;
const MAX_LIST = 256;
/** Largest number of devices a list in a statement may name (the registry admits at most this many). */
export const MAX_DEVICES = 1024;
/** Devices one claim or renewal may waive from the catch-up requirement (lease.ts, R3a). */
export const MAX_WAIVE = 64;
/** Limit one gossip event to a single small frame, independent of engine frame split settings. */
const MAX_GOSSIP_HEADS = 16;
const CERT_HEX = 2 * (1 + 16 + 16 + 32 + 32 + 64);
const MAX_WRAP_HEX = 2 * 64 * 1024;

/**
 * One event as the store hands it over (`logEventsFromBatch`). `writer` and `position` come from the
 * segment (authenticated as frame AAD): `position` is the cursor after the batch that carried the
 * event, so an event is before a cut `c` exactly when `beforeCut(position, c)` (positions.ts).
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

export interface HeadsGossipedData {
  /** Canonically ordered, unique writer-signed data-stream heads. */
  readonly heads: readonly string[];
  readonly signer: string;
  readonly sig: string;
}

/** The outer frame writer must equal this signer; the heads retain their original signatures. */
export function buildHeadsGossiped(
  signer: DeviceIdentity,
  vaultId: string,
  eid: string,
  heads: readonly SignedHead[],
): UnstampedEvent {
  const encoded = heads.map(encodeHead);
  if (
    encoded.length < 1 ||
    encoded.length > MAX_GOSSIP_HEADS ||
    encoded.some((h) => decodeHead(h)?.stream !== 1) ||
    encoded.some((h, i) => i > 0 && h <= (encoded[i - 1] ?? ""))
  ) {
    throw new RangeError("gossip heads must be 1-16 sorted distinct data-stream heads");
  }
  return signed(signer, "cashu/gossip/v1", vaultId, HEADS_GOSSIPED, eid, {
    heads: encoded,
    signer: signer.deviceId,
  });
}

export function decodeHeadsGossiped(
  data: Readonly<Record<string, unknown>>,
): HeadsGossipedData | undefined {
  if (!hasExactly(data, ["heads", "signer", "sig"])) return undefined;
  const { heads, signer, sig } = data;
  if (
    !Array.isArray(heads) ||
    heads.length < 1 ||
    heads.length > MAX_GOSSIP_HEADS ||
    !heads.every((h) => decodeHead(h)?.stream === 1) ||
    !heads.every((h, i) => i === 0 || h > heads[i - 1]) ||
    typeof signer !== "string" ||
    !isDeviceId(signer) ||
    !isSig(sig)
  )
    return undefined;
  return { heads: heads as string[], signer, sig };
}

export interface RevokedEntry {
  readonly device: string;
  /** First position of the device's own stream that is no longer accepted (its revocation point). */
  readonly cut: SegmentCursor;
  /**
   * The target's signed head AT the cut (crypto `encodeHead`; S29c phase B2): the cut commits to the
   * target's stream hash as the revoker held it. Absent when the revoker holds no frame ending
   * exactly there (nothing applied, or a cut chosen by the words below what it holds). Readers
   * whose copy of the target's stream has another chain at the cut hold a rewritten stream: the
   * target is frozen at the prefix the attestations agree on (devices/heads.ts).
   */
  readonly head?: string;
}

/** The JSON form of an entry in signed bodies (revocation and consent). */
function entryJson(e: RevokedEntry): { readonly [key: string]: CanonicalValue } {
  return {
    device: e.device,
    cut: { seg: e.cut.seg, offset: e.cut.offset },
    ...(e.head === undefined ? {} : { head: e.head }),
  };
}

/** A head that names `device` and ends exactly at `cut` (data stream), or undefined. */
function headAtCut(value: unknown, device: string, cut: SegmentCursor): string | undefined {
  const head = decodeHead(value);
  if (!head || head.device !== device || head.stream !== 1) return undefined;
  if (head.seg !== cut.seg || head.offset !== cut.offset) return undefined;
  return value as string;
}

export interface DeviceRevokedData {
  readonly devices: readonly RevokedEntry[];
  /**
   * The eids of the `device.added` re-certifications written in the SAME batch (revoke flow,
   * rotation.ts): the revocation counts only once every one of them is held at its position, so a
   * truncated batch never revokes without re-certifying (absent = none).
   */
  readonly recertify?: readonly string[];
  /**
   * H2 (lead decision): a device-signed revocation of ANOTHER device counts only with that device's
   * consent: per target other than the signer, its signature over `revocationConsentBody` (the owner
   * confirms on the device being retired). A device not in the owner's hands is revoked with the
   * recovery words instead (a recovery-signed revocation needs no consent).
   */
  readonly consent?: Readonly<Record<string, string>>;
  readonly signer: string;
  readonly sig: string;
}

/** Signed-body type of a revocation consent; never the type of a log event. */
const REVOCATION_CONSENT_BODY = "device.revoked.consent";

/** What a target signs to consent to its revocation: the vault, the eid, the entries and the signer. */
export function revocationConsentBody(
  vaultId: string,
  eid: string,
  entries: readonly RevokedEntry[],
  signer: string,
): Uint8Array {
  return statementBody(vaultId, REVOCATION_CONSENT_BODY, eid, {
    devices: entries.map(entryJson),
    signer,
  });
}

/** `target` consents to the revocation `eid` of `entries` by `signer` (lowercase hex signature). */
export function consentToRevocation(
  target: DeviceIdentity,
  vaultId: string,
  eid: string,
  entries: readonly RevokedEntry[],
  signer: string,
): string {
  if (!entries.some((e) => e.device === target.deviceId)) {
    throw new RangeError("a device consents only to its own revocation");
  }
  return toHex(
    signStatement(
      target,
      "cashu/registry/v1",
      revocationConsentBody(vaultId, eid, entries, signer),
    ),
  );
}

export interface KeysRotatedData {
  /** Recipient device id (or `RECOVERY_SIGNER_ID`) -> crypto signed wrap, lowercase hex. */
  readonly wraps: Readonly<Record<string, string>>;
}

/**
 * Per writer device: the cursor up to which the lease event's writer had applied that device's
 * stream (positions.ts: the cursor after the last applied batch). Cursors, not HLCs: a stream's
 * cursor order is exact, a writer-chosen HLC is not (review M3).
 */
export type Watermark = Readonly<Record<string, SegmentCursor>>;

/**
 * The owner's confirmation of a waiver (a waived requirement re-allows newest-day duplicates):
 * - `recovery` (the SECURITY path): the recovery identity (the words) signed the waiver: `sig` over
 *   `statementBody(vault, LEASE_WAIVER_BODY, eid, { devices })` in context `cashu/lease/v1`, bound
 *   to the vault, the lease event and the devices.
 * - `typed` (an ACCIDENT GUARD only, not an authorization): the owner typed
 *   `waiveConfirmationText(devices)` (the short ids of the waived devices, shown next to their names)
 *   on a trusted, not revoked device, which then signed the lease event. The text is computable, so
 *   any trusted device's code (a stolen, not yet revoked one, or a bug) can waive this way; it only
 *   stops an accidental waiver. S44 UI contract: `text` is set ONLY from what the owner typed in the
 *   confirmation dialog, never computed by the app (crypto/README.md risk list).
 */
export type WaiveConfirmation =
  | { readonly kind: "typed"; readonly text: string }
  | { readonly kind: "recovery"; readonly sig: string };

export interface LeaseWaiver {
  /** Sorted, unique, 1-64 device ids. */
  readonly devices: readonly string[];
  readonly confirmation: WaiveConfirmation;
}

/** What a writer asks for: the typed text, or the recovery identity to sign the waiver with. */
export interface WaiveRequest {
  readonly devices: readonly string[];
  readonly confirmation:
    | { readonly kind: "typed"; readonly text: string }
    | { readonly kind: "recovery"; readonly recovery: RecoveryIdentity };
}

/** Signed-body type of a recovery-signed waiver; never the type of a log event. */
export const LEASE_WAIVER_BODY = "lease.waiver";

/** The text the owner types to confirm a waiver: the first 8 hex digits of each device id. */
export function waiveConfirmationText(devices: readonly string[]): string {
  return [...new Set(devices)]
    .sort()
    .map((d) => d.slice(0, 8))
    .join(" ");
}

/** What the recovery identity signs for a waiver (bound to the vault and the lease event's eid). */
export function waiverBody(vaultId: string, eid: string, devices: readonly string[]): Uint8Array {
  return statementBody(vaultId, LEASE_WAIVER_BODY, eid, { devices: [...devices] });
}

export interface LeaseClaimData {
  readonly device: string;
  /** The claimer's wall clock (ms) when it wrote the claim. */
  readonly at: number;
  /** Wall-clock ms (the claimer's clock) until which the lease is held; `until - at <= MAX`. */
  readonly until: number;
  readonly watermark: Watermark;
  /** Eid of the last valid lease event the claimer saw (null: none yet). Compare-and-set. */
  readonly prev: string | null;
  /**
   * Devices the owner confirmed lost or withheld: their catch-up requirement restarts at this
   * event's own watermark entry. Counts only with the owner's confirmation (catchUp.ts).
   */
  readonly waive?: LeaseWaiver;
  readonly sig: string;
}

export interface LeaseRenewData {
  readonly device: string;
  readonly at: number;
  readonly until: number;
  readonly watermark: Watermark;
  readonly prev: string;
  /** As in a claim. */
  readonly waive?: LeaseWaiver;
  readonly sig: string;
}

export interface LeaseReleaseData {
  readonly device: string;
  readonly at: number;
  readonly watermark: Watermark;
  readonly prev: string;
  readonly sig: string;
}

/**
 * The owner designates the fetch leader (`mode: "pinned"`, `leader` = a device id) or opts into
 * automatic handover (`mode: "auto"`, `leader: null`; lease.ts uses it only over a transport that
 * declares bounded propagation). Written ONLY from an explicit owner action; the vault's first lease
 * event (`prev: null`) is the creator's pin, signed with the recovery words at vault creation.
 * Signed by the writer device after the owner TYPED `pinConfirmationText` (`text`; an accident guard
 * like the waiver's typed path, not an authorization: S44 sets it only from what the owner typed),
 * or by the recovery identity (`signer` = RECOVERY_SIGNER_ID, no `text`; any device may carry it).
 * `force`: the owner confirmed the previous leader is gone, so the new leader does not wait for its
 * hand-over (lease.ts; the UI warns that a still-running old leader may fetch once more).
 */
export interface LeasePinnedData {
  readonly mode: "pinned" | "auto";
  readonly leader: string | null;
  readonly force: boolean;
  /** The writer's wall clock (ms), within 5 minutes of the event's own HLC wall. */
  readonly at: number;
  readonly watermark: Watermark;
  /** Eid of the last valid lease event the writer saw; null only for the creator's pin. */
  readonly prev: string | null;
  /** The writer device, or RECOVERY_SIGNER_ID. */
  readonly signer: string;
  /** What the owner typed (device-signed pins only). */
  readonly text?: string;
  readonly sig: string;
}

/** The fetch leader reports a completed fetch (liveness, lease.ts `leaderLiveness`). */
export interface LeaseFetchedData {
  readonly device: string;
  readonly at: number;
  readonly watermark: Watermark;
  readonly prev: string;
  readonly sig: string;
}

/** What a writer asks for when it pins: the owner's typed text, or the recovery identity. */
export interface PinRequest {
  readonly mode: "pinned" | "auto";
  readonly leader: string | null;
  readonly force: boolean;
  readonly confirmation:
    | { readonly kind: "typed"; readonly text: string }
    | { readonly kind: "recovery"; readonly recovery: RecoveryIdentity };
}

/**
 * The text the owner types to confirm a pin: the first 8 hex digits of the new leader (or `auto`),
 * plus ` force` when the previous leader's hand-over is skipped.
 */
export function pinConfirmationText(
  mode: "pinned" | "auto",
  leader: string | null,
  force: boolean,
): string {
  const what = mode === "auto" ? "auto" : (leader ?? "").slice(0, 8);
  return force ? `${what} force` : what;
}

/** Recovery public keys as a statement carries them (lowercase hex). */
export interface RecoveryKeysHex {
  readonly box: string;
  readonly sign: string;
}

/**
 * The owner replaced the recovery words (crypto README n1). Signed by a trusted device (writer =
 * signer) AND authorized by the recovery identity it replaces (`authorization`: the old words sign
 * the statement without `sig` / `authorization`), so neither a stolen device alone nor leaked old
 * words alone can move the trust root. Carries the replaced keys (`from`), the new keys (`to`), the new base
 * wrap (the whole ring as of the change, signed by the NEW recovery identity, sealed for its box
 * key), certificates by the new recovery identity for every device trusted at the change (trust is
 * rooted at the recovery key, so the old chains end with it), and the eids of the old-key-signed
 * registry statements the changer had accepted (they keep counting; any other statement signed with
 * the old words is ignored from then on, so a leaked old phrase is worthless).
 */
export interface RecoveryChangedData {
  readonly from: RecoveryKeysHex;
  readonly to: RecoveryKeysHex;
  readonly baseWrap: string;
  readonly certificates: readonly string[];
  readonly ratified: readonly string[];
  readonly signer: string;
  /** Signature of the replaced recovery identity over `recoveryChangeAuthorizationBody`. */
  readonly authorization: string;
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
  options: {
    readonly recertify?: readonly string[];
    readonly consent?: Readonly<Record<string, string>>;
  } = {},
): UnstampedEvent {
  const recertify = options.recertify ?? [];
  const consent = options.consent ?? {};
  if (entries.length === 0 || entries.length > MAX_LIST)
    throw new RangeError("revoke 1-256 devices");
  if (
    recertify.length > MAX_LIST ||
    !recertify.every(isUlid) ||
    new Set(recertify).size !== recertify.length
  ) {
    throw new RangeError("recertify 0-256 distinct eids");
  }
  for (const e of entries) {
    if (e.head !== undefined && headAtCut(e.head, e.device, e.cut) === undefined) {
      throw new RangeError("a cut head must be the target's head at the cut");
    }
  }
  return signed(signer, "cashu/registry/v1", vaultId, DEVICE_REVOKED, eid, {
    devices: entries.map(entryJson),
    ...(recertify.length > 0 ? { recertify: [...recertify] } : {}),
    ...(Object.keys(consent).length > 0 ? { consent: { ...consent } } : {}),
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

function watermarkJson(w: Watermark): { [device: string]: CanonicalValue } {
  const out: { [device: string]: CanonicalValue } = {};
  for (const [device, c] of Object.entries(w)) out[device] = { seg: c.seg, offset: c.offset };
  return out;
}

/** The `waive` field as written (devices sorted and unique); omitted when there is no waiver. */
function waiveJson(
  vaultId: string,
  eid: string,
  waive: WaiveRequest | undefined,
): { waive?: { [key: string]: CanonicalValue } } {
  if (waive === undefined) return {};
  const devices = [...new Set(waive.devices)].sort();
  if (devices.length === 0 || devices.length > MAX_WAIVE || !devices.every(isDeviceId)) {
    throw new RangeError("waive 1-64 device ids");
  }
  const c = waive.confirmation;
  if (c.kind === "typed") return { waive: { devices, by: "typed", text: c.text } };
  const sig = c.recovery.sign("cashu/lease/v1", waiverBody(vaultId, eid, devices));
  return { waive: { devices, by: "recovery", sig: toHex(sig) } };
}

export function buildLeaseClaim(
  identity: DeviceIdentity,
  vaultId: string,
  eid: string,
  fields: {
    at: number;
    until: number;
    watermark: Watermark;
    prev: string | null;
    waive?: WaiveRequest;
  },
): UnstampedEvent {
  return signed(identity, "cashu/lease/v1", vaultId, LEASE_CLAIMED, eid, {
    device: identity.deviceId,
    at: fields.at,
    until: fields.until,
    watermark: watermarkJson(fields.watermark),
    prev: fields.prev,
    ...waiveJson(vaultId, eid, fields.waive),
  });
}

export function buildLeaseRenewal(
  identity: DeviceIdentity,
  vaultId: string,
  eid: string,
  fields: {
    at: number;
    until: number;
    watermark: Watermark;
    prev: string;
    waive?: WaiveRequest;
  },
): UnstampedEvent {
  return signed(identity, "cashu/lease/v1", vaultId, LEASE_RENEWED, eid, {
    device: identity.deviceId,
    at: fields.at,
    until: fields.until,
    watermark: watermarkJson(fields.watermark),
    prev: fields.prev,
    ...waiveJson(vaultId, eid, fields.waive),
  });
}

export function buildLeaseRelease(
  identity: DeviceIdentity,
  vaultId: string,
  eid: string,
  fields: { at: number; watermark: Watermark; prev: string },
): UnstampedEvent {
  return signed(identity, "cashu/lease/v1", vaultId, LEASE_RELEASED, eid, {
    device: identity.deviceId,
    at: fields.at,
    watermark: watermarkJson(fields.watermark),
    prev: fields.prev,
  });
}

/**
 * A `lease.pinned` statement written by `writer` (the device whose stream carries it), signed by
 * the writer after the owner typed the confirmation, or by the recovery identity.
 */
export function buildLeasePin(
  writer: DeviceIdentity,
  vaultId: string,
  eid: string,
  fields: { at: number; watermark: Watermark; prev: string | null },
  pin: PinRequest,
): UnstampedEvent {
  if (
    pin.mode === "pinned" ? pin.leader === null || !isDeviceId(pin.leader) : pin.leader !== null
  ) {
    throw new RangeError("a pin names a device id in mode pinned and null in mode auto");
  }
  const base = {
    mode: pin.mode,
    leader: pin.leader,
    force: pin.force,
    at: fields.at,
    watermark: watermarkJson(fields.watermark),
    prev: fields.prev,
  };
  const c = pin.confirmation;
  if (c.kind === "recovery") {
    return signed(c.recovery, "cashu/lease/v1", vaultId, LEASE_PINNED, eid, {
      ...base,
      signer: RECOVERY_SIGNER_ID,
    });
  }
  return signed(writer, "cashu/lease/v1", vaultId, LEASE_PINNED, eid, {
    ...base,
    signer: writer.deviceId,
    text: c.text,
  });
}

export function buildLeaseFetched(
  identity: DeviceIdentity,
  vaultId: string,
  eid: string,
  fields: { at: number; watermark: Watermark; prev: string },
): UnstampedEvent {
  return signed(identity, "cashu/lease/v1", vaultId, LEASE_FETCHED, eid, {
    device: identity.deviceId,
    at: fields.at,
    watermark: watermarkJson(fields.watermark),
    prev: fields.prev,
  });
}

/** What the replaced recovery identity signs: the change without `sig` and `authorization`. */
export function recoveryChangeAuthorizationBody(
  vaultId: string,
  eid: string,
  data: Readonly<Record<string, unknown>>,
): Uint8Array {
  const { authorization: _a, ...rest } = data;
  return concat(
    lp(utf8("recovery-change-authorization")),
    statementBody(vaultId, RECOVERY_CHANGED, eid, rest),
  );
}

export function buildRecoveryChanged(
  signer: DeviceIdentity,
  current: RecoveryIdentity,
  vaultId: string,
  eid: string,
  fields: {
    from: { boxPublicKey: Uint8Array; signPublicKey: Uint8Array };
    to: { boxPublicKey: Uint8Array; signPublicKey: Uint8Array };
    baseWrap: Uint8Array;
    certificates: readonly Uint8Array[];
    ratified: readonly string[];
  },
): UnstampedEvent {
  if (fields.certificates.length === 0 || fields.certificates.length > MAX_DEVICES) {
    throw new RangeError("certify 1-1024 devices");
  }
  const unsigned = {
    from: { box: toHex(fields.from.boxPublicKey), sign: toHex(fields.from.signPublicKey) },
    to: { box: toHex(fields.to.boxPublicKey), sign: toHex(fields.to.signPublicKey) },
    baseWrap: toHex(fields.baseWrap),
    certificates: fields.certificates.map(toHex),
    ratified: [...new Set(fields.ratified)].sort(),
    signer: signer.deviceId,
  };
  const authorization = toHex(
    signStatement(
      current,
      "cashu/registry/v1",
      recoveryChangeAuthorizationBody(vaultId, eid, unsigned),
    ),
  );
  return signed(signer, "cashu/registry/v1", vaultId, RECOVERY_CHANGED, eid, {
    ...unsigned,
    authorization,
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
    entries.length <= MAX_DEVICES &&
    entries.every(([device, cursor]) => isDeviceId(device) && isCursor(cursor))
  );
}

/** Strict: 1-64 device ids in ascending order without repeats. */
function isWaivedDevices(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_WAIVE &&
    value.every(
      (d, i) => typeof d === "string" && isDeviceId(d) && (i === 0 || (value[i - 1] as string) < d),
    )
  );
}

/** Strict decode of a `waive` object: devices plus exactly one form of owner confirmation. */
function decodeWaiver(value: unknown): LeaseWaiver | undefined {
  if (!isRecord(value) || !isWaivedDevices(value.devices)) return undefined;
  const devices = [...value.devices];
  if (hasExactly(value, ["devices", "by", "text"]) && value.by === "typed") {
    const text = value.text;
    if (typeof text !== "string" || text.length > MAX_WAIVE * 9) return undefined;
    return { devices, confirmation: { kind: "typed", text } };
  }
  if (hasExactly(value, ["devices", "by", "sig"]) && value.by === "recovery" && isSig(value.sig)) {
    return { devices, confirmation: { kind: "recovery", sig: value.sig } };
  }
  return undefined;
}

/** The fields of a claim or renewal, with the optional `waive`. */
function hasLeaseTermFields(data: Readonly<Record<string, unknown>>): boolean {
  const keys = ["device", "at", "until", "watermark", "prev", "sig"];
  return (
    hasExactly(data, keys) ||
    (hasExactly(data, [...keys, "waive"]) && decodeWaiver(data.waive) !== undefined)
  );
}

function decodeWatermark(value: Watermark): Watermark {
  const out: Record<string, SegmentCursor> = {};
  for (const [device, c] of Object.entries(value)) out[device] = { seg: c.seg, offset: c.offset };
  return out;
}

function isRecoveryKeys(value: unknown): value is RecoveryKeysHex {
  return (
    isRecord(value) &&
    hasExactly(value, ["box", "sign"]) &&
    isHex(value.box, 32) &&
    isHex(value.sign, 32)
  );
}

function hasExactly(data: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const present = Object.keys(data);
  return present.length === keys.length && keys.every((k) => k in data);
}

function isSig(value: unknown): value is string {
  return isHex(value, SIGNATURE_BYTES);
}

function isTime(value: unknown): value is number {
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
  const keys = Object.keys(data);
  const optional = new Set(["recertify", "consent"]);
  const required = ["devices", "signer", "sig"];
  if (
    !required.every((k) => k in data) ||
    !keys.every((k) => required.includes(k) || optional.has(k))
  ) {
    return undefined;
  }
  const withRecertify = "recertify" in data;
  const { devices, recertify, consent, signer, sig } = data;
  if (
    withRecertify &&
    !(
      Array.isArray(recertify) &&
      recertify.length > 0 &&
      recertify.length <= MAX_LIST &&
      recertify.every((e) => typeof e === "string" && isUlid(e)) &&
      new Set(recertify).size === recertify.length
    )
  ) {
    return undefined;
  }
  if (!Array.isArray(devices) || devices.length === 0 || devices.length > MAX_LIST)
    return undefined;
  if (!isSignerId(signer) || !isSig(sig)) return undefined;
  const entries: RevokedEntry[] = [];
  const seen = new Set<string>();
  for (const e of devices) {
    if (
      !isRecord(e) ||
      !(hasExactly(e, ["device", "cut"]) || hasExactly(e, ["device", "cut", "head"]))
    )
      return undefined;
    const { device, cut } = e;
    if (typeof device !== "string" || !isDeviceId(device) || seen.has(device) || !isCursor(cut)) {
      return undefined;
    }
    const at = { seg: cut.seg, offset: cut.offset };
    const head = "head" in e ? headAtCut(e.head, device, at) : undefined;
    if ("head" in e && head === undefined) return undefined;
    seen.add(device);
    entries.push({ device, cut: at, ...(head === undefined ? {} : { head }) });
  }
  let consents: Record<string, string> | undefined;
  if ("consent" in data) {
    if (!isRecord(consent)) return undefined;
    const pairs = Object.entries(consent);
    if (pairs.length === 0 || !pairs.every(([d, s]) => seen.has(d) && d !== signer && isSig(s))) {
      return undefined;
    }
    consents = Object.fromEntries(pairs as [string, string][]);
  }
  return {
    devices: entries,
    ...(withRecertify ? { recertify: [...(recertify as string[])] } : {}),
    ...(consents ? { consent: consents } : {}),
    signer,
    sig,
  };
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
  if (!hasLeaseTermFields(data)) return undefined;
  const { device, at, until, watermark, prev, sig } = data;
  if (
    typeof device !== "string" ||
    !isDeviceId(device) ||
    !isTime(at) ||
    !isTime(until) ||
    !isWatermark(watermark) ||
    !(prev === null || isUlid(prev)) ||
    !isSig(sig)
  ) {
    return undefined;
  }
  const waiver = data.waive === undefined ? undefined : decodeWaiver(data.waive);
  const waive = waiver ? { waive: waiver } : {};
  return { device, at, until, watermark: decodeWatermark(watermark), prev, ...waive, sig };
}

export function decodeLeaseRenewal(
  data: Readonly<Record<string, unknown>>,
): LeaseRenewData | undefined {
  if (!hasLeaseTermFields(data)) return undefined;
  const { device, at, until, watermark, prev, sig } = data;
  if (
    typeof device !== "string" ||
    !isDeviceId(device) ||
    !isTime(at) ||
    !isTime(until) ||
    !isWatermark(watermark) ||
    !isUlid(prev) ||
    !isSig(sig)
  ) {
    return undefined;
  }
  const waiver = data.waive === undefined ? undefined : decodeWaiver(data.waive);
  const waive = waiver ? { waive: waiver } : {};
  return { device, at, until, watermark: decodeWatermark(watermark), prev, ...waive, sig };
}

export function decodeLeaseRelease(
  data: Readonly<Record<string, unknown>>,
): LeaseReleaseData | undefined {
  if (!hasExactly(data, ["device", "at", "watermark", "prev", "sig"])) return undefined;
  const { device, at, watermark, prev, sig } = data;
  if (
    typeof device !== "string" ||
    !isDeviceId(device) ||
    !isTime(at) ||
    !isWatermark(watermark) ||
    !isUlid(prev) ||
    !isSig(sig)
  ) {
    return undefined;
  }
  return { device, at, watermark: decodeWatermark(watermark), prev, sig };
}

export function decodeLeasePin(
  data: Readonly<Record<string, unknown>>,
): LeasePinnedData | undefined {
  const keys = ["mode", "leader", "force", "at", "watermark", "prev", "signer", "sig"];
  const typed = hasExactly(data, [...keys, "text"]);
  if (!typed && !hasExactly(data, keys)) return undefined;
  const { mode, leader, force, at, watermark, prev, signer, text, sig } = data;
  if (
    !(mode === "pinned" || mode === "auto") ||
    !(mode === "pinned" ? typeof leader === "string" && isDeviceId(leader) : leader === null) ||
    typeof force !== "boolean" ||
    !isTime(at) ||
    !isWatermark(watermark) ||
    !(prev === null || isUlid(prev)) ||
    !isSignerId(signer) ||
    // A device signs with the owner's typed text; the recovery identity signs without one.
    typed !== (signer !== RECOVERY_SIGNER_ID) ||
    (typed && (typeof text !== "string" || text.length > 64)) ||
    !isSig(sig)
  ) {
    return undefined;
  }
  return {
    mode,
    leader: leader as string | null,
    force,
    at,
    watermark: decodeWatermark(watermark),
    prev,
    signer,
    ...(typed ? { text: text as string } : {}),
    sig,
  };
}

export function decodeLeaseFetched(
  data: Readonly<Record<string, unknown>>,
): LeaseFetchedData | undefined {
  return decodeLeaseRelease(data);
}

export function decodeRecoveryChanged(
  data: Readonly<Record<string, unknown>>,
): RecoveryChangedData | undefined {
  const keys = [
    "from",
    "to",
    "baseWrap",
    "certificates",
    "ratified",
    "signer",
    "authorization",
    "sig",
  ];
  if (!hasExactly(data, keys)) return undefined;
  const { from, to, baseWrap, certificates, ratified, signer, authorization, sig } = data;
  if (
    !isRecoveryKeys(from) ||
    !isRecoveryKeys(to) ||
    !isHex(baseWrap) ||
    baseWrap.length > MAX_WRAP_HEX ||
    !Array.isArray(certificates) ||
    certificates.length === 0 ||
    certificates.length > MAX_DEVICES ||
    !certificates.every((c) => typeof c === "string" && c.length === CERT_HEX && isHex(c)) ||
    !Array.isArray(ratified) ||
    ratified.length > MAX_DEVICES * 4 ||
    !ratified.every(isUlid) ||
    typeof signer !== "string" ||
    !isDeviceId(signer) ||
    !isSig(authorization) ||
    !isSig(sig)
  ) {
    return undefined;
  }
  return {
    authorization,
    from: { box: from.box, sign: from.sign },
    to: { box: to.box, sign: to.sign },
    baseWrap,
    certificates: [...certificates] as string[],
    ratified: [...ratified] as string[],
    signer,
    sig,
  };
}
