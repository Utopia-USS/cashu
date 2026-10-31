// Registry fold cost scenarios (review M4, A7 / A8), shared by registry.cost.test.ts (a small case in
// the default tier) and registry.cost.exhaustive.test.ts (the large ones). Cost is measured by
// counting work, never by a clock: certificate checks (hits included, the closure's work per fold)
// and statement signature verifications that miss the caches. A return to quadratic folds shows as
// a check count far above linear in the certificates. Test support only (synthetic data).

import type { UnstampedEvent } from "../carrier.js";
import {
  CertificateCache,
  certifyDevice,
  createDeviceId,
  createDeviceIdentity,
  type DeviceIdentity,
} from "../crypto/index.js";
import { toHex } from "./bytes.js";
import {
  buildDeviceAdded,
  buildDeviceRevoked,
  type LogEvent,
  revocationConsentBody,
} from "./events.js";
import { foldRegistry, type Registry, type TrustRoot } from "./registry.js";
import { memoizedVerifier, type StatementVerifier, signStatement } from "./statements.js";
import { createSimVault, hlcAt, newEid, START_TIME, sodium } from "./testkit.js";

class Stream {
  #offset = 0;
  readonly events: LogEvent[] = [];
  constructor(readonly writer: string) {}
  add(e: UnstampedEvent): void {
    this.#offset += 100;
    this.events.push({
      eid: e.i,
      hlc: hlcAt(this.writer, START_TIME + this.#offset),
      writer: this.writer,
      position: { seg: 1, offset: this.#offset },
      type: e.t,
      v: e.v,
      data: e.d,
    });
  }
}

/** Counts every certificate check (hits too) and the checks that ran a signature verification. */
class CountingCache extends CertificateCache {
  checks = 0;
  misses = 0;
  override check(key: string, verify: () => boolean): boolean {
    this.checks += 1;
    return super.check(key, () => {
      this.misses += 1;
      return verify();
    });
  }
}

export interface Scenario {
  readonly root: TrustRoot;
  readonly events: readonly LogEvent[];
  /** Certificates logged (the linear bound's unit). */
  readonly certificates: number;
}

export interface FoldCost {
  readonly registry: Registry;
  readonly certificateChecks: number;
  readonly certificateVerifications: number;
  /** Statement signature checks asked of the (memoized) verifier. */
  readonly statementChecks: number;
}

/** A cold fold, then a warm re-fold with the same caches (what a device does on every change). */
export function foldTwice(s: Scenario): { cold: FoldCost; warm: FoldCost } {
  const cache = new CountingCache();
  const memo = memoizedVerifier();
  let statements = 0;
  // Counts statement checks (memo hits included): linear in the statements when the fold is.
  const counting: StatementVerifier = (...args) => {
    statements += 1;
    return memo(...args);
  };
  const run = (): FoldCost => {
    const before = { checks: cache.checks, misses: cache.misses, statements };
    const registry = foldRegistry(sodium, s.root, s.events, {
      verify: counting,
      certificateCache: cache,
    });
    return {
      registry,
      certificateChecks: cache.checks - before.checks,
      certificateVerifications: cache.misses - before.misses,
      statementChecks: statements - before.statements,
    };
  };
  return { cold: run(), warm: run() };
}

const KEYS: DeviceIdentity = createDeviceIdentity(sodium);

/** Synthetic subjects: fresh ids sharing one key pair (key generation is not what is measured). */
function subjects(n: number, keys: DeviceIdentity = KEYS) {
  return Array.from({ length: n }, () => ({
    deviceId: createDeviceId(sodium),
    signPublicKey: keys.signPublicKey,
    boxPublicKey: keys.box.publicKey,
  }));
}

/** `signer` revokes the synthetic subject `device` (cut START) with its consent (shared KEYS, H2). */
function consentedRevocation(
  signer: DeviceIdentity,
  vaultId: string,
  device: string,
): UnstampedEvent {
  const eid = newEid();
  const entries = [{ device, cut: { seg: 1, offset: 0 } }];
  const sig = signStatement(
    KEYS,
    "cashu/registry/v1",
    revocationConsentBody(vaultId, eid, entries, signer.deviceId),
  );
  return buildDeviceRevoked(signer, vaultId, eid, entries, { consent: { [device]: toHex(sig) } });
}

/** A8: one trusted device certifies `n` puppets, then revokes them one by one. */
export function puppetsRevokedOneByOne(n: number): Scenario {
  const { creator: a } = createSimVault();
  const vaultId = a.ring.vaultId;
  const stream = new Stream(a.id);
  const puppets = subjects(n);
  for (const p of puppets) {
    const cert = certifyDevice(sodium, a.identity, p, vaultId);
    stream.add(buildDeviceAdded(a.identity, vaultId, newEid(), p, "puppet", cert));
  }
  for (const p of puppets) {
    stream.add(consentedRevocation(a.identity, vaultId, p.deviceId));
  }
  return {
    root: { vaultId, recovery: a.ring.recovery },
    events: [...a.stream.flatMap((s) => s.events), ...stream.events],
    certificates: 1 + n,
  };
}

/** A7: 1000 trusted devices (16 issuers under the creator, 62 leaves each) and 160 revocations. */
export function twoLevelTree(): Scenario {
  const { creator: a } = createSimVault();
  const vaultId = a.ring.vaultId;
  const top = new Stream(a.id);
  const issuers = Array.from({ length: 16 }, () => createDeviceIdentity(sodium));
  for (const i of issuers) {
    const subject = {
      deviceId: i.deviceId,
      signPublicKey: i.signPublicKey,
      boxPublicKey: i.box.publicKey,
    };
    const cert = certifyDevice(sodium, a.identity, subject, vaultId);
    top.add(buildDeviceAdded(a.identity, vaultId, newEid(), subject, "issuer", cert));
  }
  const streams = [top];
  for (const i of issuers) {
    const s = new Stream(i.deviceId);
    const children = subjects(62);
    for (const c of children) {
      const cert = certifyDevice(sodium, i, c, vaultId);
      s.add(buildDeviceAdded(i, vaultId, newEid(), c, "leaf", cert));
    }
    for (const c of children.slice(0, 10)) {
      s.add(consentedRevocation(i, vaultId, c.deviceId));
    }
    streams.push(s);
  }
  return {
    root: { vaultId, recovery: a.ring.recovery },
    events: [...a.stream.flatMap((s) => s.events), ...streams.flatMap((s) => s.events)],
    certificates: 1 + 16 + 16 * 62,
  };
}
