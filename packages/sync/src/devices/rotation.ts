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

import type { UnstampedEvent } from "../carrier.js";
import {
  CryptoError,
  type CryptoErrorCode,
  type DeviceIdentity,
  type KeyEntry,
  type Keyring,
  RECOVERY_SIGNER_ID,
  type RecoveryIdentity,
  type RecoveryPublicKeys,
  recoveryRecipient,
  rotateKeyring,
  type Sodium,
  type TrustedDevice,
  type UnwrapOptions,
  unwrapKeys,
  wrapKeys,
} from "../crypto/index.js";
import { buildDeviceRevoked, buildKeysRotated, type RevokedEntry } from "./events.js";
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
    const out = unwrapKeys(
      ctx.sodium,
      wire,
      ctx.identity,
      ctx.ring,
      ctx.registry.trustedSigner,
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

export interface PreparedChange {
  /** Write these in ONE batch, before `commit()`. */
  readonly events: readonly UnstampedEvent[];
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
  | { readonly ok: false; readonly reason: "not_trusted" | "no_effect" };

function rotateOnClone(
  ctx: KeyContext,
  trusted: ReadonlyMap<string, TrustedDevice>,
  revocationCount: number,
  eid: string,
  leading: readonly UnstampedEvent[],
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

/** A plain rotation (the S29 rule, or recovery): wraps the new key for every trusted device. */
export function prepareRotation(ctx: KeyContext, eid: string): PrepareResult {
  if (!ctx.registry.isTrusted(ctx.identity.deviceId)) return { ok: false, reason: "not_trusted" };
  return {
    ok: true,
    change: rotateOnClone(ctx, ctx.registry.trusted, ctx.registry.revocationCount, eid, []),
  };
}

/**
 * Revokes `targets` (each with its cut: the revoker's applied cursor of that device's stream) and
 * rotates with the incremented epoch, wrapping only for the devices that remain trusted. Revoking
 * this device itself writes the revocation only; the remaining devices rotate (revocation_pending).
 */
export function prepareRevocation(
  ctx: KeyContext,
  targets: readonly RevokedEntry[],
  eids: { readonly revoke: string; readonly rotate: string },
  /**
   * Sign the revocation with the recovery identity (restoring from the words: every pre-recovery
   * device is revoked, and a recovery-signed revocation stays valid whatever a stolen device signs).
   */
  recovery?: RecoveryIdentity,
): PrepareResult {
  const me = ctx.identity.deviceId;
  if (!ctx.registry.isTrusted(me)) return { ok: false, reason: "not_trusted" };
  const preview = ctx.registry.previewRevocation(targets.map((t) => t.device));
  if (preview.revocationCount === ctx.registry.revocationCount) {
    return { ok: false, reason: "no_effect" };
  }
  const signer = recovery ?? ctx.identity;
  const revoked = buildDeviceRevoked(signer, ctx.registry.vaultId, eids.revoke, targets);
  if (!preview.trusted.has(me)) {
    const change: PreparedChange = {
      events: [revoked],
      key: undefined,
      recipients: [],
      commit: () => undefined,
      discard: () => undefined,
    };
    return { ok: true, change };
  }
  return {
    ok: true,
    change: rotateOnClone(ctx, preview.trusted, preview.revocationCount, eids.rotate, [revoked]),
  };
}
