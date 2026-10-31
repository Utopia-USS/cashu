// The two steps of the registry fold's trust: the certificates that count with their closure, and the
// revocations decided over that closure. `foldRegistry` decides revocations once, over every logged
// certificate (registration and signer eligibility), then recomputes the certificates without those
// revoked writers logged after their cut (S29c R2). Revocations are not re-decided over the smaller
// set: dropping a revoked writer's certificates can unregister the very revoker whose revocation
// made the drop (a mutual pair revokes both). What a device attested before its cut and a revoked
// device's keys, however, never come from a certificate logged after its issuer's cut (review P2):
// `decideRevocations` explains the two-step cut.

import type { SegmentCursor } from "../carrier.js";
import {
  type CertificateCache,
  type CertificateClosure,
  CertificateIndex,
  RECOVERY_SIGNER_ID,
  type Sodium,
} from "../crypto/index.js";
import {
  type CertificateSelection,
  type IssuedCertificate,
  selectCertificates,
} from "./certificates.js";
import {
  type DeviceAddedData,
  type DeviceRevokedData,
  type LogEvent,
  MAX_DEVICES,
} from "./events.js";
import { beforeCut, minPosition } from "./positions.js";
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
  const deduped = dedupeVerified(verified, ignored);

  // P2: keys certified by a device after its cut never back an attestation or a revoked device's
  // keys. The cuts are what is being decided, so: first exclude every device-issued certificate
  // logged after the LOWEST cut any verified revocation states for its issuer (conservative: a cut
  // is then raised less, never more), decide; then exclude exactly the certificates logged after
  // the decided cuts and decide again. A certificate that survives the second step lies before its
  // issuer's cut as decided without any post-cut key, so it is legitimate.
  const stated = new Map<string, SegmentCursor>();
  for (const r of deduped) {
    for (const t of r.targets) {
      const known = stated.get(t.device);
      stated.set(t.device, known ? minPosition(known, t.cut) : t.cut);
    }
  }
  const decide = (cuts: ReadonlyMap<string, SegmentCursor>) => {
    const late = new Set<IssuedCertificate>();
    for (const c of certs.selection.deviceIssued) {
      const cut = cuts.get(c.issuer);
      if (cut && !beforeCut(c.position, cut)) late.add(c);
    }
    const attest = late.size === 0 ? all : closureWithout(ctx, certs.selection, late);
    const passIgnored: IgnoredStatement[] = [];
    const result = resolveRevocations({
      root,
      events: ctx.events,
      verified: deduped.map((r) => ({ ...r, targets: r.targets.map((t) => ({ ...t })) })),
      registered,
      index,
      attest,
      verify,
      ignored: passIgnored,
    });
    return { result, ignored: passIgnored, late };
  };
  const first = decide(stated);
  const decided = new Map([...first.result.revoked].map(([d, r]) => [d, r.cut]));
  const second = decide(decided);
  const final = sameMembers(first.late, second.late) ? first : second;
  ignored.push(...final.ignored);
  return { result: final.result, ignored };
}

/** The closure over the selected certificates minus `late` (ignoring revocations). */
function closureWithout(
  ctx: TrustContext,
  selection: CertificateSelection,
  late: ReadonlySet<IssuedCertificate>,
): CertificateClosure {
  const drop = new Set([...late].map((c) => c.certificate));
  const kept = selection.certificates.filter((c) => !drop.has(c));
  return new CertificateIndex(ctx.sodium, ctx.root.vaultId, ctx.root.recovery.signPublicKey, kept, {
    cache: ctx.cache,
    maxDevices: MAX_DEVICES,
  }).closure(new Set());
}

function sameMembers<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}
