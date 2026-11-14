// Local revocation admission. A signed cut head proves an endpoint this device holds, not that a
// remote carrier has served every later frame. The host presents the warning on every revoke.
// A start/no-head observation additionally needs an explicit statement about this device's view.

import { blake2b } from "@noble/hashes/blake2.js";
import type { SegmentCursor } from "../carrier.js";
import { type Keyring, RecoveryIdentity } from "../crypto/core.js";
import {
  type CanonicalValue,
  canonicalJson,
  equalBytes,
  isCanonicalValue,
  toHex,
  utf8,
} from "./bytes.js";
import type { RevokedEntry } from "./events.js";
import type { Registry } from "./registry.js";

interface RevocationDevices {
  readonly deviceId: string;
  readonly registry: Registry;
  readonly ring: Keyring;
  readonly frozen: ReadonlyMap<string, SegmentCursor>;
  readonly guard: { entries(): Iterable<readonly [string, SegmentCursor]> };
}

/** The admission surface used by the policy, without a gate-to-rotation import cycle. */
export interface RevocationGate {
  readonly devices: RevocationDevices;
  gossipStatus(): { readonly overflow: boolean; readonly historyPending: boolean };
  checkedRevocationEntry(
    target: string,
    applied: SegmentCursor,
  ):
    | { readonly kind: "integrity_error" }
    | {
        readonly kind: "trusted_head" | "local_start_no_head";
        readonly entry: RevokedEntry;
        readonly leaseFloor?: SegmentCursor;
      };
}

export interface RevocationPreviewRequest {
  readonly targets: readonly { readonly device: string; readonly applied: SegmentCursor }[];
  /** Host-generated and kept private. Consent signs this exact revoke eid. */
  readonly revokeEid: string;
  /** Host-generated one-operation nonce, never taken from the renderer. */
  readonly attemptId: string;
  readonly authority:
    | { readonly kind: "recovery" }
    | { readonly kind: "consent"; readonly signatures: Readonly<Record<string, string>> };
  readonly selection: { readonly recertify: readonly string[] };
}

export interface RevocationPreview {
  readonly vaultId: string;
  readonly targets: readonly {
    readonly entry: RevokedEntry;
    readonly status: "trusted_head" | "local_start_no_head";
    readonly leaseFloor: SegmentCursor | undefined;
  }[];
  readonly warning: "revoke_may_exclude_unseen_writes";
  readonly requiresLocalStartConfirmation: boolean;
  readonly fingerprint: string;
}

export type RevocationPreviewResult =
  | { readonly ok: true; readonly preview: RevocationPreview }
  | {
      readonly ok: false;
      readonly reason:
        | "wrong_gate"
        | "invalid_targets"
        | "invalid_selection"
        | "stale_applied_cursor"
        | "integrity_error"
        | "no_effect";
    };

export type RevocationAcknowledgement = {
  readonly warning: "acknowledged";
  readonly localStart?: "local_never_seen";
};

/** Opaque at runtime too: only this module can issue and consume an admitted permit. */
export interface RevocationPermit {
  readonly __revocationPermit: unique symbol;
}

const previews = new WeakMap<RevocationPreview, string>();
const permits = new WeakMap<object, { readonly fingerprint: string; used: boolean }>();

function digest(value: string): string {
  return toHex(blake2b(utf8(value), { dkLen: 32 }));
}

function sameCursor(a: SegmentCursor, b: SegmentCursor): boolean {
  return a.seg === b.seg && a.offset === b.offset;
}

/** Only device/registry statements and target lease floors affect the revision, never business writes. */
function relevantState(devices: RevocationDevices): string {
  const registry = devices.registry;
  const statements = registry.events
    .map((e) => {
      if (!isCanonicalValue(e.data)) throw new RangeError("noncanonical registry statement");
      return canonicalJson({
        eid: e.eid,
        writer: e.writer,
        position: { seg: e.position.seg, offset: e.position.offset },
        type: e.type,
        v: e.v,
        data: e.data,
      });
    })
    .sort();
  const frozen = [...devices.frozen]
    .map(([device, at]) => ({
      device,
      at: { seg: at.seg, offset: at.offset },
    }))
    .sort((a, b) => a.device.localeCompare(b.device));
  const active = devices.ring.active;
  return digest(
    canonicalJson({
      statements,
      frozen,
      recovery: {
        box: toHex(registry.recovery.boxPublicKey),
        sign: toHex(registry.recovery.signPublicKey),
      },
      active: { kid: active.kid, generation: active.generation, epoch: active.epoch },
    }),
  );
}

/** Builds the same immutable observation before display and immediately before the final batch. */
export function previewRevocation(
  devices: RevocationDevices,
  gate: RevocationGate,
  request: RevocationPreviewRequest,
): RevocationPreviewResult {
  if (gate.devices !== devices) return { ok: false, reason: "wrong_gate" };
  const gossip = gate.gossipStatus();
  if (request.authority.kind !== "recovery" && (gossip.overflow || gossip.historyPending)) {
    return { ok: false, reason: "integrity_error" };
  }
  const targets = [...request.targets].sort((a, b) => a.device.localeCompare(b.device));
  if (
    targets.length === 0 ||
    new Set(targets.map((t) => t.device)).size !== targets.length ||
    targets.some((t) => !devices.registry.isTrusted(t.device))
  ) {
    return { ok: false, reason: "invalid_targets" };
  }
  const consequence = devices.registry.previewRevocation(targets.map((t) => t.device));
  const losing = [...devices.registry.trusted.keys()].filter(
    (d) => !targets.some((t) => t.device === d) && !consequence.trusted.has(d),
  );
  if (
    new Set(request.selection.recertify).size !== request.selection.recertify.length ||
    request.selection.recertify.some((d) => !losing.includes(d))
  ) {
    return { ok: false, reason: "invalid_selection" };
  }
  if (consequence.revocationCount === devices.registry.revocationCount) {
    return { ok: false, reason: "no_effect" };
  }
  const checked: RevocationPreview["targets"][number][] = [];
  const appliedNow = new Map(devices.guard.entries());
  for (const target of targets) {
    const current = appliedNow.get(target.device) ?? { seg: 1, offset: 0 };
    if (!sameCursor(target.applied, current)) {
      return { ok: false, reason: "stale_applied_cursor" };
    }
    const result = gate.checkedRevocationEntry(target.device, current);
    if (result.kind === "integrity_error") return { ok: false, reason: "integrity_error" };
    if (result.entry.device !== target.device) return { ok: false, reason: "integrity_error" };
    if (result.kind === "trusted_head" && result.entry.head === undefined) {
      return { ok: false, reason: "integrity_error" };
    }
    if (
      result.kind === "local_start_no_head" &&
      (result.entry.head !== undefined || !sameCursor(result.entry.cut, { seg: 1, offset: 0 }))
    ) {
      return { ok: false, reason: "integrity_error" };
    }
    checked.push({ entry: result.entry, status: result.kind, leaseFloor: result.leaseFloor });
  }
  const authority: CanonicalValue =
    request.authority.kind === "recovery"
      ? { kind: "recovery", publicSign: toHex(devices.registry.recovery.signPublicKey) }
      : {
          kind: "consent",
          signatures: Object.entries(request.authority.signatures).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        };
  const fingerprint = digest(
    canonicalJson({
      vaultId: devices.ring.vaultId,
      targets: checked.map((t) => ({
        device: t.entry.device,
        cut: { seg: t.entry.cut.seg, offset: t.entry.cut.offset },
        head: t.entry.head ?? null,
        status: t.status,
        leaseFloor: t.leaseFloor ? { seg: t.leaseFloor.seg, offset: t.leaseFloor.offset } : null,
      })),
      authority,
      selection: [...request.selection.recertify].sort(),
      revokeEid: request.revokeEid,
      attemptId: request.attemptId,
      state: relevantState(devices),
    }),
  );
  const preview: RevocationPreview = Object.freeze({
    vaultId: devices.ring.vaultId,
    targets: Object.freeze(
      checked.map((t) =>
        Object.freeze({
          entry: Object.freeze({ ...t.entry, cut: Object.freeze({ ...t.entry.cut }) }),
          status: t.status,
          leaseFloor: t.leaseFloor && Object.freeze({ ...t.leaseFloor }),
        }),
      ),
    ),
    warning: "revoke_may_exclude_unseen_writes",
    requiresLocalStartConfirmation: checked.some((t) => t.status === "local_start_no_head"),
    fingerprint,
  });
  previews.set(preview, fingerprint);
  return { ok: true, preview };
}

/** Called only after the host has checked its private, expiring confirmation challenge. */
export function acknowledgeRevocationPreview(
  preview: RevocationPreview,
  acknowledgement: RevocationAcknowledgement,
): RevocationPermit | undefined {
  if (previews.get(preview) !== preview.fingerprint) return undefined;
  if (acknowledgement.warning !== "acknowledged") return undefined;
  if (
    preview.requiresLocalStartConfirmation !==
    (acknowledgement.localStart === "local_never_seen")
  )
    return undefined;
  const permit = Object.freeze({}) as RevocationPermit;
  permits.set(permit, { fingerprint: preview.fingerprint, used: false });
  return permit;
}

/** Consumes once. A stale or forged permit never reaches event/key construction. */
export function consumeRevocationPermit(
  devices: RevocationDevices,
  gate: RevocationGate,
  request: RevocationPreviewRequest,
  permit: RevocationPermit,
  revokeEid: string,
  authority: RecoveryIdentity | { readonly consent: Readonly<Record<string, string>> },
  selection: { readonly recertify?: readonly string[] },
): readonly RevokedEntry[] | undefined {
  const issued = permits.get(permit);
  if (!issued || issued.used) return undefined;
  issued.used = true;
  if (revokeEid !== request.revokeEid) return undefined;
  if (
    canonicalJson([...(selection.recertify ?? [])].sort()) !==
    canonicalJson([...request.selection.recertify].sort())
  )
    return undefined;
  if (request.authority.kind === "recovery") {
    if (!(authority instanceof RecoveryIdentity)) return undefined;
    if (
      !equalBytes(authority.publicKeys.boxPublicKey, devices.registry.recovery.boxPublicKey) ||
      !equalBytes(authority.publicKeys.signPublicKey, devices.registry.recovery.signPublicKey)
    )
      return undefined;
  } else {
    if (authority instanceof RecoveryIdentity) return undefined;
    if (
      canonicalJson(Object.entries(authority.consent).sort(([a], [b]) => a.localeCompare(b))) !==
      canonicalJson(
        Object.entries(request.authority.signatures).sort(([a], [b]) => a.localeCompare(b)),
      )
    )
      return undefined;
  }
  const fresh = previewRevocation(devices, gate, request);
  if (!fresh.ok || fresh.preview.fingerprint !== issued.fingerprint) return undefined;
  return fresh.preview.targets.map((t) => t.entry);
}
