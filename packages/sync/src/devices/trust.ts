// The two steps of the registry fold's trust: the certificates that count with their closure, and the
// revocations decided over that closure. `foldRegistry` decides revocations once, over every logged
// certificate, then recomputes the certificates without those revoked writers logged after their
// cut (S29c R2). Revocations are not re-decided: dropping a revoked writer's certificates can
// unregister the very revoker whose revocation made the drop (a mutual pair revokes both), so a
// second decision would undo the first; deciding over the larger set fails closed.

import {
  type CertificateCache,
  type CertificateClosure,
  CertificateIndex,
  RECOVERY_SIGNER_ID,
  type Sodium,
} from "../crypto/index.js";
import { type CertificateSelection, selectCertificates } from "./certificates.js";
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
  // Verify first (forged copies never displace genuine ones), then dedupe.
  const verified: Rev[] = [];
  for (const { event, data } of ctx.revocations) {
    const isRecovery = data.signer === RECOVERY_SIGNER_ID;
    if (!isRecovery && data.signer !== event.writer) {
      ignored.push({ eid: event.eid, reason: "untrusted_signer" });
      continue;
    }
    if (!data.devices.some((d) => registered.has(d.device))) {
      ignored.push({ eid: event.eid, reason: "no_effect" }); // cheap check first: no signature work
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
    verified.push({
      id: 0,
      event,
      signer: data.signer,
      recovery: isRecovery,
      key: isRecovery ? undefined : key,
      targets: data.devices.map((d) => ({ device: d.device, cut: d.cut })),
    });
  }
  const result = resolveRevocations({
    root,
    events: ctx.events,
    verified: dedupeVerified(verified, ignored),
    registered,
    index,
    all,
    verify,
    ignored,
  });
  return { result, ignored };
}
