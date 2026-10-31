// The two steps of the registry fold's trust: the certificates that count with their closure, and the
// revocations decided over that closure. `foldRegistry` decides revocations once, over every logged
// certificate, then recomputes the certificates without those revoked writers logged after their
// cut (S29c R2). Revocations are not re-decided over the smaller set: dropping a revoked writer's
// certificates can unregister the very revoker whose revocation made the drop (a mutual pair revokes
// both). Which keys may back a decision is decided by ONE rule, under each step's revocations
// (decisionKeys.ts): no key certified through a revoked or conflicted device ever counts.

import {
  type CertificateCache,
  type CertificateClosure,
  CertificateIndex,
  RECOVERY_SIGNER_ID,
  type Sodium,
} from "../crypto/index.js";
import { fromHex } from "./bytes.js";
import { type CertificateSelection, selectCertificates } from "./certificates.js";
import { DecisionKeys } from "./decisionKeys.js";
import {
  type DeviceAddedData,
  type DeviceRevokedData,
  type LogEvent,
  MAX_DEVICES,
  revocationConsentBody,
} from "./events.js";
import type { Decoded, IgnoredStatement, TrustRoot } from "./registryTypes.js";
import {
  dedupeVerified,
  type Rev,
  type RevocationResult,
  resolveRevocations,
} from "./revocations.js";
import type { StatementVerifier } from "./statements.js";

export interface TrustContext {
  readonly sodium: Sodium;
  readonly root: TrustRoot;
  readonly cache: CertificateCache;
  readonly verify: StatementVerifier;
  readonly bootstrap: readonly Uint8Array[];
  /** Every event of the fold (lease statements are revokers' attested knowledge). */
  readonly events: readonly LogEvent[];
  readonly revocations: readonly Decoded<DeviceRevokedData>[];
  /** Every decoded `device.added` as `writer|seg:offset|eid` (a revocation's batch must be whole). */
  readonly heldAdds: ReadonlySet<string>;
  readonly recoveryKeyFor: (eid: string) => Uint8Array[];
  /** The key among `keys` a registry statement's signature verifies with. */
  readonly verifies: (
    event: LogEvent,
    sig: string,
    keys: readonly Uint8Array[],
  ) => Uint8Array | undefined;
}

export interface CertificateTrust {
  readonly selection: CertificateSelection;
  readonly index: CertificateIndex;
  /** The certificate closure ignoring revocations. */
  readonly all: CertificateClosure;
  /** Certified through a valid chain ignoring revocations (conflicted ids included). */
  readonly registered: ReadonlySet<string>;
}

export function certificateTrust(
  ctx: TrustContext,
  added: readonly Decoded<DeviceAddedData>[],
): CertificateTrust {
  const { sodium, root, cache, verify } = ctx;
  const selection = selectCertificates({
    sodium,
    root,
    cache,
    bootstrap: ctx.bootstrap,
    added,
    verify,
    recoveryKeysFor: ctx.recoveryKeyFor,
  });
  const index = new CertificateIndex(
    sodium,
    root.vaultId,
    root.recovery.signPublicKey,
    selection.certificates,
    { cache, maxDevices: MAX_DEVICES },
  );
  const all = index.closure(new Set());
  return { selection, index, all, registered: new Set(all.ids()) };
}

/** Revocation statements verified, deduplicated and resolved over one certificate closure. */
export function decideRevocations(
  ctx: TrustContext,
  certs: CertificateTrust,
): { readonly result: RevocationResult; readonly ignored: readonly IgnoredStatement[] } {
  const { root, verify } = ctx;
  const { index, all, registered } = certs;
  const ignored: IgnoredStatement[] = [];
  // H1: a device signer without a decision key under the recovery-signed revocations alone (they
  // count in every fold step) can never sign a revocation that counts: decision keys only shrink as
  // more devices are revoked (when the closure admitted every id). Skip it before any signature work,
  // so a revoked device's puppets cost nothing once the words revoked it.
  const certain = new Set<string>();
  for (const { event, data } of ctx.revocations) {
    if (data.signer !== RECOVERY_SIGNER_ID) continue;
    if (!ctx.verifies(event, data.sig, ctx.recoveryKeyFor(event.eid))) continue;
    for (const d of data.devices) if (registered.has(d.device)) certain.add(d.device);
  }
  const floor =
    certain.size > 0 && registered.size < MAX_DEVICES
      ? new DecisionKeys(index, certain)
      : undefined;
  // Verify first (forged copies never displace genuine ones), then dedupe.
  const verified: Rev[] = [];
  for (const { event, data } of ctx.revocations) {
    const isRecovery = data.signer === RECOVERY_SIGNER_ID;
    if (!isRecovery && data.signer !== event.writer) {
      ignored.push({ eid: event.eid, reason: "untrusted_signer" });
      continue;
    }
    if (!isRecovery && floor && floor.keysOf(data.signer).length === 0) {
      ignored.push({ eid: event.eid, reason: "untrusted_signer" });
      continue;
    }
    if (!data.devices.some((d) => registered.has(d.device))) {
      ignored.push({ eid: event.eid, reason: "no_effect" }); // cheap check first: no signature work
      continue;
    }
    // Revoke flow: the re-certifications of the same batch must all be held (truncation safety).
    const at = `${event.writer}|${event.position.seg}:${event.position.offset}|`;
    if (data.recertify?.some((eid) => !ctx.heldAdds.has(at + eid))) {
      ignored.push({ eid: event.eid, reason: "incomplete_batch" });
      continue;
    }
    const keys = isRecovery
      ? ctx.recoveryKeyFor(event.eid)
      : all.keysOf(data.signer).map((k) => k.signPublicKey);
    if (keys.length === 0) {
      ignored.push({ eid: event.eid, reason: "untrusted_signer" });
      continue;
    }
    const key = ctx.verifies(event, data.sig, keys);
    if (!key) {
      ignored.push({ eid: event.eid, reason: "bad_signature" });
      continue;
    }
    // H2: a device-signed revocation of another device needs that device's consent: a signature by
    // one of its certified keys (any chain, ignoring revocations: the consent was given before the
    // revocations being decided and must not depend on them, so a key minted later can never void a
    // genuine consent). Forging one needs a key certified for the target, which only a trusted
    // device can mint, making the target conflicted (untrusted) anyway; residual in the README.
    if (!isRecovery) {
      const body = revocationConsentBody(root.vaultId, event.eid, data.devices, data.signer);
      const consented = data.devices.every(({ device }) => {
        if (device === data.signer) return true;
        const sig = data.consent?.[device];
        return (
          sig !== undefined &&
          all
            .keysOf(device)
            .some((k) => verify("cashu/registry/v1", body, fromHex(sig), k.signPublicKey))
        );
      });
      if (!consented) {
        ignored.push({ eid: event.eid, reason: "no_consent" });
        continue;
      }
    }
    verified.push({
      id: 0,
      event,
      signer: data.signer,
      recovery: isRecovery,
      key: isRecovery ? undefined : key,
      targets: data.devices.map((d) => ({ device: d.device, cut: d.cut })),
    });
  }
  const deduped = dedupeVerified(verified, ignored);

  const result = resolveRevocations({
    root,
    events: ctx.events,
    verified: deduped,
    registered,
    index,
    verify,
    ignored,
  });
  return { result, ignored };
}
