// Key rotation and revocation on top of crypto's signed wraps.
//
// - Unwrapping (`applyWrap`): every wrap goes through `unwrapKeys` with the registry's
//   `trustedSigner` (certified, registered, not revoked) and `epochPolicy`, which refuses a key
//   epoch above the registry's revocation count (crypto README: the only guard on `active` under
//   epoch-first order) and enforces a per-sender rotation rate limit (MA1, n2). The sender and its
//   signed recipient list are recorded for every new kid (provenance.ts).
// - Rotating (`prepareRotation`, `prepareRevocation`): the new key is made on a clone of the ring and
//   wrapped (signed) for every trusted device and the recovery recipient, all listed as recipients.
//   The caller writes the returned events in ONE batch first, sealed under the still-active old key
//   (a recipient cannot open a frame under a key it has not unwrapped yet), and calls `commit()`
//   after the batch is written, which adds the key to the live ring.
// - The S29 rule after every merge (`rotationReason`): rotate again when the active key's epoch is
//   below the revocation count (a revocation whose rotation is missing or was refused, two concurrent
//   revocations), when its sender is no longer trusted, or when its signed recipients include a
//   revoked device (M1). A device checks this before writing any frame.

import type { SegmentCursor, UnstampedEvent } from "../carrier.js";
import {
  CryptoError,
  type CryptoErrorCode,
  certifyDevice,
  type DeviceIdentity,
  type KeyEntry,
  type Keyring,
  RECOVERY_SIGNER_ID,
  RecoveryIdentity,
  type RecoveryPublicKeys,
  recoveryRecipient,
  rotateKeyring,
  type Sodium,
  type TrustedDevice,
  type UnwrapOptions,
  wrapKeys,
} from "../crypto/index.js";
import { DEFAULT_MAX_FRAME_BYTES, DEFAULT_MAX_FRAME_EVENTS, frameLoad } from "../segment.js";
import { unwrapFromTrusted } from "./acceptance.js";
import {
  buildDeviceAdded,
  buildDeviceRevoked,
  buildKeysRotated,
  type RevokedEntry,
} from "./events.js";
import type { KeyProvenance, ProvenanceStore } from "./provenance.js";
import type { Registry } from "./registry.js";

const DAY = 24 * 60 * 60 * 1000;

export interface RateLimit {
  /** New generations one sender may introduce per window (default 6). */
  readonly rotationsPerWindow: number;
  readonly windowMs: number;
}

export const DEFAULT_RATE_LIMIT: RateLimit = { rotationsPerWindow: 6, windowMs: DAY };

export interface KeyContext {
  readonly sodium: Sodium;
  readonly identity: DeviceIdentity;
  readonly ring: Keyring;
  readonly registry: Registry;
  readonly provenance: ProvenanceStore;
  /** Local clock, ms. */
  readonly now: number;
  readonly rateLimit?: RateLimit;
  /**
   * n3: a device restored from the recovery words accepts epochs only up to the highest epoch seen
   * in recovery-wrapped keys + 1 (not the log's revocation count) until it has rotated.
   */
  readonly recoveryEpochCap?: number;
  /** Recovery keys this ring pinned before its current ones (n1): wraps still pinning one merge. */
  readonly previousRecoveryKeys?: readonly RecoveryPublicKeys[];
  /**
   * The engine's frame caps (default the engine defaults): a prepared batch must fit ONE frame, so
   * the engine never splits it into a frame group whose tail could be missing (`incomplete_batch`).
   */
  readonly frameLimits?: { readonly events: number; readonly bytes: number };
}

export type EpochRefusal = "epoch_above_revocations" | "rate_limited";

/**
 * The `acceptEpoch` hook for one `unwrapKeys` call. `refusal` tells why the last entry was refused.
 */
export function epochPolicy(
  ctx: KeyContext,
): UnwrapOptions & { refusal: EpochRefusal | undefined } {
  const limit = ctx.rateLimit ?? DEFAULT_RATE_LIMIT;
  const cap = ctx.recoveryEpochCap ?? ctx.registry.revocationCount;
  const seen = new Map<string, Set<number>>();
  const policy = {
    refusal: undefined as EpochRefusal | undefined,
    ...(ctx.previousRecoveryKeys ? { previousRecoveryKeys: ctx.previousRecoveryKeys } : {}),
    acceptEpoch: (sender: string, entry: KeyEntry): boolean => {
      if (entry.epoch > cap) {
        policy.refusal = "epoch_above_revocations";
        return false;
      }
      if (sender === RECOVERY_SIGNER_ID) return true;
      let generations = seen.get(sender);
      if (!generations) {
        generations = new Set(
          ctx.provenance
            .list()
            .filter(
              (p) =>
                p.sender === sender &&
                p.source === "wrap" &&
                p.receivedAt > ctx.now - limit.windowMs,
            )
            .map((p) => p.generation),
        );
        seen.set(sender, generations);
      }
      if (!generations.has(entry.generation)) {
        if (generations.size >= limit.rotationsPerWindow) {
          policy.refusal = "rate_limited";
          return false;
        }
        generations.add(entry.generation);
      }
      return true;
    },
  };
  return policy;
}

export type WrapOutcome =
  | { readonly status: "applied"; readonly sender: string; readonly kids: readonly string[] }
  /** Valid, but every key in it was already held. */
  | { readonly status: "known"; readonly sender: string }
  /** Not acceptable yet: unknown sender, epoch above the known revocations, a gap, rate limit. */
  | { readonly status: "retry"; readonly code: CryptoErrorCode; readonly refusal?: EpochRefusal }
  /** Never acceptable: forged, not for this device, wrong vault, flood (`bad_payload`). */
  | { readonly status: "refused"; readonly code: CryptoErrorCode };

// `recovery_key_mismatch`: the sender already applied a recovery-key change this device has not
// seen yet (n1); the wrap merges once this device applies it.
const RETRY_CODES = new Set<CryptoErrorCode>([
  "untrusted_sender",
  "generation_gap",
  "epoch_gap",
  "recovery_key_mismatch",
]);

/** Verifies, opens and merges one signed wrap into `ctx.ring`, recording provenance. */
export function applyWrap(ctx: KeyContext, wire: Uint8Array): WrapOutcome {
  const before = new Set(ctx.ring.entries().map((e) => e.kid));
  const policy = epochPolicy(ctx);
  let sender: string;
  let recipients: string[];
  try {
    const out = unwrapFromTrusted(
      ctx.sodium,
      wire,
      ctx.identity,
      ctx.ring,
      ctx.registry.decisionKeys,
      ctx.registry.recovery.signPublicKey,
      policy,
    );
    sender = out.senderDeviceId;
    recipients = out.recipients;
  } catch (e) {
    if (!(e instanceof CryptoError)) throw e;
    if (RETRY_CODES.has(e.code)) {
      return policy.refusal && e.code === "untrusted_sender"
        ? { status: "retry", code: e.code, refusal: policy.refusal }
        : { status: "retry", code: e.code };
    }
    return { status: "refused", code: e.code };
  }
  const fresh = ctx.ring.entries().filter((e) => !before.has(e.kid));
  for (const e of fresh) {
    ctx.provenance.put({
      kid: e.kid,
      generation: e.generation,
      epoch: e.epoch,
      sender,
      recipients,
      source: "wrap",
      receivedAt: ctx.now,
    });
  }
  return fresh.length === 0
    ? { status: "known", sender }
    : { status: "applied", sender, kids: fresh.map((e) => e.kid) };
}

/** Records the whole ring received at pairing as coming from the inviter (recipients unknown). */
export function recordPairingProvenance(
  provenance: ProvenanceStore,
  ring: Keyring,
  inviter: string,
  now: number,
): void {
  for (const e of ring.entries()) {
    provenance.put({
      kid: e.kid,
      generation: e.generation,
      epoch: e.epoch,
      sender: inviter,
      recipients: null,
      source: "pairing",
      receivedAt: now,
    });
  }
}

export type RotationReason =
  /** A counted revocation the active key predates (its rotation is missing, refused or concurrent). */
  | "revocation_pending"
  /** The active key's sender is revoked or no longer trusted. */
  | "sender_untrusted"
  /** The active key's signed recipients include a revoked device (M1). */
  | "recipient_revoked"
  /** Restored from the recovery words: rotate before writing any frame (n3). */
  | "recovered"
  /**
   * The recovery key changed (n1) and the active key predates it: it was wrapped for the old
   * recovery box key, which a leaked old phrase opens. One rotation wraps only for the new one.
   */
  | "recovery_changed";

/** Why this device must rotate before writing, or undefined. */
export function rotationReason(
  ring: Keyring,
  registry: Registry,
  provenance: ProvenanceStore,
  me: string,
): RotationReason | undefined {
  const active = ring.active;
  if (active.epoch < registry.revocationCount) return "revocation_pending";
  const p = provenance.get(active.kid);
  if (!p) return undefined;
  if (p.sender !== me && p.sender !== RECOVERY_SIGNER_ID && !registry.isTrusted(p.sender)) {
    return "sender_untrusted";
  }
  if (p.recipients?.some((r) => registry.revoked.has(r))) return "recipient_revoked";
  return undefined;
}

/**
 * The epoch of the next rotation: the revocation count (the number of revocation events applied),
 * kept within what `rotateKeyring` allows (from the active key's epoch to the highest held + 1).
 */
export function rotationEpoch(ring: Keyring, revocationCount: number): number {
  return Math.max(ring.active.epoch, Math.min(revocationCount, ring.maxEpoch + 1));
}

/** A remaining device whose only valid certificate chain ran through a device being revoked. */
export interface AffectedDevice {
  readonly device: string;
  /** Its display name from the registry (undefined when none was announced). */
  readonly name: string | undefined;
  /** Who paired it (`RECOVERY_SIGNER_ID` for the words) and when (registry `DeviceRecord`). */
  readonly pairedBy: string | undefined;
  readonly pairedAt: { readonly position: SegmentCursor; readonly hlc: string } | undefined;
  /**
   * A UI hint for the owner's per-device choice: true on the consent path (the target is in the
   * owner's hands), never on the words path (lost or stolen: the thief may have paired anything).
   */
  readonly suggested: boolean;
  /** Re-certified in the revocation's own batch (the owner chose it): it stays trusted. */
  readonly recertified: boolean;
  /**
   * Why not: `not_selected` (the owner did not choose it: it stays untrusted and nothing is sealed
   * for it), `recovery_required` (only the words can re-certify here), `capacity` (the writer's
   * certificate window is full; the owner re-pairs the device).
   */
  readonly reason?: "not_selected" | "recovery_required" | "capacity";
}

export interface PreparedChange {
  /** Write these in ONE batch, before `commit()`. */
  readonly events: readonly UnstampedEvent[];
  /** Devices that lose their chain with this revocation, re-certified or not (S44 shows them). */
  readonly affected: readonly AffectedDevice[];
  /** The new data key, when this change rotates. */
  readonly key:
    | { readonly kid: string; readonly generation: number; readonly epoch: number }
    | undefined;
  /** The signed recipient list of the rotation (empty when none). */
  readonly recipients: readonly string[];
  /** After the batch is written: add the new key to the live ring and record its provenance. */
  commit(): void;
  /** The batch was not written: forget the new key. */
  discard(): void;
}

export type PrepareResult =
  | { readonly ok: true; readonly change: PreparedChange }
  | { readonly ok: false; readonly reason: "not_trusted" | "no_effect" }
  /**
   * The batch would not fit one frame (`KeyContext.frameLimits`): nothing is written (a revocation
   * split over a frame group could sit in `incomplete_batch`). Fewer targets or re-certifications.
   */
  | {
      readonly ok: false;
      readonly reason: "batch_too_large";
      readonly events: number;
      readonly bytes: number;
    }
  /**
   * H2: revoking another device needs the recovery words, or that device's consent (it is in the
   * owner's hands: `consentToRevocation` on it). `unconsented` lists the targets lacking both.
   */
  | {
      readonly ok: false;
      readonly reason: "authority_required";
      readonly unconsented: readonly string[];
    }
  /** Re-certifying `affected` needs the recovery words: call again with the recovery identity. */
  | {
      readonly ok: false;
      readonly reason: "recovery_required";
      readonly affected: readonly AffectedDevice[];
    };

function rotateOnClone(
  ctx: KeyContext,
  trusted: ReadonlyMap<string, TrustedDevice>,
  revocationCount: number,
  eid: string,
  leading: readonly UnstampedEvent[],
  affected: readonly AffectedDevice[] = [],
): PreparedChange {
  const me = ctx.identity.deviceId;
  const clone = ctx.ring.clone(ctx.sodium);
  let open = true;
  try {
    const entry = rotateKeyring(ctx.sodium, clone, {
      epoch: rotationEpoch(ctx.ring, revocationCount),
    });
    const devices = [...trusted.values()]
      .filter((d) => d.deviceId !== me)
      .sort((a, b) => (a.deviceId < b.deviceId ? -1 : 1));
    const recipients = [...devices.map((d) => d.deviceId), RECOVERY_SIGNER_ID];
    const wraps = new Map<string, Uint8Array>();
    for (const d of devices) {
      wraps.set(d.deviceId, wrapKeys(ctx.sodium, clone, ctx.identity, d, [entry.kid], recipients));
    }
    wraps.set(
      RECOVERY_SIGNER_ID,
      wrapKeys(ctx.sodium, clone, ctx.identity, recoveryRecipient(clone), [entry.kid], recipients),
    );
    const key = { kid: entry.kid, generation: entry.generation, epoch: entry.epoch };
    const record: KeyProvenance = {
      ...key,
      sender: me,
      recipients: [...recipients, me],
      source: "own",
      receivedAt: ctx.now,
    };
    const close = () => {
      if (open) {
        open = false;
        clone.wipe();
      }
    };
    return {
      events: [...leading, buildKeysRotated(eid, wraps)],
      affected,
      key,
      recipients,
      commit: () => {
        if (!open) throw new RangeError("change already committed or discarded");
        ctx.ring.merge(clone);
        ctx.provenance.put(record);
        close();
      },
      discard: close,
    };
  } catch (e) {
    clone.wipe();
    throw e;
  }
}

/** The change, or `batch_too_large` (the change discarded) when its events do not fit one frame. */
function oneFrame(ctx: KeyContext, change: PreparedChange): PrepareResult {
  const load = frameLoad(change.events);
  const limits = ctx.frameLimits ?? {
    events: DEFAULT_MAX_FRAME_EVENTS,
    bytes: DEFAULT_MAX_FRAME_BYTES,
  };
  if (load.events <= limits.events && load.bytes <= limits.bytes) return { ok: true, change };
  change.discard();
  return { ok: false, reason: "batch_too_large", events: load.events, bytes: load.bytes };
}

/** A plain rotation (the S29 rule, or recovery): wraps the new key for every trusted device. */
export function prepareRotation(ctx: KeyContext, eid: string): PrepareResult {
  if (!ctx.registry.isTrusted(ctx.identity.deviceId)) return { ok: false, reason: "not_trusted" };
  const change = rotateOnClone(ctx, ctx.registry.trusted, ctx.registry.revocationCount, eid, []);
  return oneFrame(ctx, change);
}

/**
 * Revokes `targets` (each with its cut: the revoker's applied cursor of that device's stream) and
 * rotates with the incremented epoch, wrapping only for the devices that remain trusted.
 *
 * Re-certification (S29c): every remaining device whose only valid chain ran through a target is
 * re-certified IN THE SAME BATCH, by this device, or by the recovery identity when it is given. The
 * revocation names those `device.added` eids (`recertify`), and the registry counts it only once all
 * of them are held at its position, so no delivery (a truncated or partial batch) can revoke without
 * re-certifying. When this device's own chain runs through a target, or it revokes itself, while
 * others would lose their chain, only the recovery words can re-certify: without them the result is
 * `recovery_required` with the affected devices, and nothing is written. Devices that do not fit
 * the writer's certificate window are listed with `capacity`. `affected` always lists every device
 * that loses its chain (S44 contract, crypto README).
 */
export function prepareRevocation(
  ctx: KeyContext,
  targets: readonly RevokedEntry[],
  eids: {
    readonly revoke: string;
    readonly rotate: string;
    /** A fresh eid per re-certification (required when some device loses its chain). */
    readonly recertify?: () => string;
  },
  /**
   * The recovery identity (sign the revocation and the re-certifications with the words: a lost or
   * stolen device, a revoker whose chain runs through a target, restoring from the words), or the
   * targets' consents (devices in the owner's hands, signed on each target for `eids.revoke`).
   */
  authority?: RecoveryIdentity | { readonly consent: Readonly<Record<string, string>> },
  /**
   * The orphans the owner chose to re-certify (W1): default none. The S44 UI shows every orphan
   * (`affected`) unchecked on the words path; the consent path may pre-check them (`suggested`).
   */
  selection: { readonly recertify?: readonly string[] } = {},
): PrepareResult {
  const { registry } = ctx;
  const me = ctx.identity.deviceId;
  if (!registry.isTrusted(me)) return { ok: false, reason: "not_trusted" };
  const recovery = authority instanceof RecoveryIdentity ? authority : undefined;
  const consent = authority && !(authority instanceof RecoveryIdentity) ? authority.consent : {};
  if (!recovery) {
    // The same check every device's fold makes (consent.ts): a consent counts only with the
    // target's own key, never one this device (or a device it certified) vouches for.
    const unconsented = registry.consentAccepted(eids.revoke, targets, me, consent);
    if (unconsented.length > 0) return { ok: false, reason: "authority_required", unconsented };
  }
  const targetIds = new Set(targets.map((t) => t.device));
  const preview = registry.previewRevocation([...targetIds]);
  if (preview.revocationCount === registry.revocationCount) {
    return { ok: false, reason: "no_effect" };
  }
  const losing = [...registry.trusted.keys()]
    .filter((d) => !targetIds.has(d) && !preview.trusted.has(d))
    .sort();
  // W1 (lead decision): re-certification is the owner's explicit choice per orphan, never automatic.
  const chosen = new Set(selection.recertify ?? []);
  for (const d of chosen) {
    if (!losing.includes(d)) throw new RangeError("recertify names a device that is not an orphan");
  }
  const describe = (device: string, recertified: boolean, reason?: AffectedDevice["reason"]) => {
    const record = registry.devices.get(device);
    return {
      device,
      name: record?.name,
      pairedBy: record?.pairedBy,
      pairedAt: record?.pairedAt,
      suggested: !recovery,
      recertified,
      ...(reason ? { reason } : {}),
    };
  };
  const meStays = preview.trusted.has(me);
  const meLosing = losing.includes(me);
  // The revoker must stay trusted (H4), and only a device that stays can re-certify; otherwise the
  // words are needed (and must re-certify this device when its own chain is cut).
  if (
    (!recovery && (meLosing || (!meStays && chosen.size > 0))) ||
    (recovery && meLosing && !chosen.has(me))
  ) {
    return {
      ok: false,
      reason: "recovery_required",
      affected: losing.map((device) => describe(device, false, "recovery_required")),
    };
  }
  const signer = recovery ?? ctx.identity;
  const room = registry.certificateRoom(me, signer.deviceId);
  const recertified = losing.filter((d) => chosen.has(d)).slice(0, room);
  if (recertified.length > 0 && !eids.recertify) {
    throw new RangeError("eids.recertify is required when devices are re-certified");
  }
  const adds = recertified.map((device) => {
    const k = registry.trusted.get(device) as TrustedDevice;
    const subject = {
      deviceId: device,
      signPublicKey: k.signPublicKey,
      boxPublicKey: k.boxPublicKey,
    };
    const certificate = certifyDevice(ctx.sodium, signer, subject, registry.vaultId);
    const eid = (eids.recertify as () => string)();
    const name = registry.devices.get(device)?.name ?? "device";
    return buildDeviceAdded(signer, registry.vaultId, eid, subject, name, certificate);
  });
  const affected: AffectedDevice[] = losing.map((device) =>
    recertified.includes(device)
      ? describe(device, true)
      : describe(device, false, chosen.has(device) ? "capacity" : "not_selected"),
  );
  const revoked = buildDeviceRevoked(signer, registry.vaultId, eids.revoke, targets, {
    recertify: adds.map((a) => a.i),
    ...(recovery ? {} : { consent }),
  });
  const after = new Map(preview.trusted);
  for (const device of recertified)
    after.set(device, registry.trusted.get(device) as TrustedDevice);
  if (!after.has(me)) {
    // Retiring this device itself: the revocation (and re-certifications) only; the remaining
    // devices rotate (revocation_pending). Its cut is fixed at the statement's own position by every
    // fold. After the batch is written, this device wipes its vault keys and identity: a retired
    // device that is later sold or stolen holds nothing (the app also deletes them from its KeyStore).
    const retiring = targetIds.has(me);
    const change: PreparedChange = {
      events: [revoked, ...adds],
      affected,
      key: undefined,
      recipients: [],
      commit: () => {
        if (retiring) {
          ctx.ring.wipe();
          ctx.identity.wipe();
        }
      },
      discard: () => undefined,
    };
    return oneFrame(ctx, change);
  }
  return oneFrame(
    ctx,
    rotateOnClone(ctx, after, preview.revocationCount, eids.rotate, [revoked, ...adds], affected),
  );
}
