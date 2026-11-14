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
} from "../crypto/core.js";
import type { KeySource } from "./acceptance.js";
import { type CertificateSelection, selectCertificates } from "./certificates.js";
import { retiredDevices, unconsentedTargets } from "./consent.js";
import { DecisionKeys } from "./decisionKeys.js";
import {
  type DeviceAddedData,
  type DeviceRevokedData,
  type LogEvent,
  MAX_DEVICES,
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
  /** The key of `source` a registry statement's signature verifies with (acceptance.ts). */
  readonly acceptStatement: (
    event: LogEvent,
    sig: string,
    source: KeySource,
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
): {
  readonly result: RevocationResult;
  readonly ignored: readonly IgnoredStatement[];
  /** Devices retired by the words or by a consented revocation (consent keys avoid them, H5''). */
  readonly retired: ReadonlySet<string>;
} {
  const { root, verify } = ctx;
  const { index, registered } = certs;
  const ignored: IgnoredStatement[] = [];
  // H1: a device signer without a decision key under the recovery-signed revocations alone (they
  // count in every fold step) can never sign a revocation that counts: decision keys only shrink as
  // more devices are revoked (when the closure admitted every id). Skip it before any signature work,
  // so a revoked device's puppets cost nothing once the words revoked it.
  const certain = new Set<string>();
  for (const { event, data } of ctx.revocations) {
    if (data.signer !== RECOVERY_SIGNER_ID) continue;
    const source: KeySource = { kind: "recovery", signKeys: ctx.recoveryKeyFor(event.eid) };
    if (!ctx.acceptStatement(event, data.sig, source)) continue;
    for (const d of data.devices) if (registered.has(d.device)) certain.add(d.device);
  }
  const floor =
    certain.size > 0 && registered.size < MAX_DEVICES
      ? new DecisionKeys(index, certain)
      : undefined;
  // Statement signatures are identified with the decision keys under no revocation (every certified
  // key); eligibility is decided per fold step with the step's decision keys (revocations.ts).
  const identify = new DecisionKeys(index, new Set());
  // Verify first (forged copies never displace genuine ones), then dedupe.
  const signed: { event: LogEvent; data: DeviceRevokedData; key: Uint8Array | undefined }[] = [];
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
    const source: KeySource = isRecovery
      ? { kind: "recovery", signKeys: ctx.recoveryKeyFor(event.eid) }
      : { kind: "device", keys: identify, device: data.signer };
    if (!isRecovery && identify.keysOf(data.signer).length === 0) {
      ignored.push({ eid: event.eid, reason: "untrusted_signer" });
      continue;
    }
    const key = ctx.acceptStatement(event, data.sig, source);
    if (!key) {
      ignored.push({ eid: event.eid, reason: "bad_signature" });
      continue;
    }
    signed.push({ event, data, key: isRecovery ? undefined : key });
  }

  // H2 / H5' / H5'': a device-signed revocation of another device needs that device's consent,
  // verified with its decision keys avoiding the signer (and all it certified) and every retired
  // device (consent.ts). A self-revocation is its own consent (its signer's decision key).
  const consentsOk = (event: LogEvent, data: DeviceRevokedData, keys: DecisionKeys): boolean => {
    const self = data.devices.some((d) => d.device === data.signer);
    const source: KeySource = { kind: "device", keys, device: data.signer };
    return (
      unconsentedTargets(
        verify,
        keys,
        root.vaultId,
        event.eid,
        data.devices,
        data.signer,
        data.consent,
      ).length === 0 &&
      (!self || ctx.acceptStatement(event, data.sig, source) !== undefined)
    );
  };
  const retired = retiredDevices(
    index,
    certain,
    signed
      .filter(({ data }) => data.signer !== RECOVERY_SIGNER_ID)
      .map(({ event, data }) => ({
        targets: data.devices.map((d) => d.device).filter((d) => registered.has(d)),
        ok: (keys: DecisionKeys) => consentsOk(event, data, keys),
      })),
  );
  const consentKeys = new DecisionKeys(index, retired);
  const verified: Rev[] = [];
  for (const { event, data, key } of signed) {
    const isRecovery = data.signer === RECOVERY_SIGNER_ID;
    if (!isRecovery && !consentsOk(event, data, consentKeys)) {
      ignored.push({ eid: event.eid, reason: "no_consent" });
      continue;
    }
    verified.push({
      id: 0,
      event,
      signer: data.signer,
      recovery: isRecovery,
      key,
      // A self-revocation's cut is fixed at its own position: a device retiring itself (or a thief
      // holding it) can never erase its history by stating an earlier cut.
      targets: data.devices.map((d) => ({
        device: d.device,
        cut: d.device === data.signer && !isRecovery ? event.position : d.cut,
      })),
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
  return { result, ignored, retired };
}
