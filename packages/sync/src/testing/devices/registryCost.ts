// Registry fold cost scenarios (review M4, A7 / A8), shared by registry.cost.test.ts (a small case in
// the default tier) and registry.cost.exhaustive.test.ts (the large ones). Cost is measured by
// counting work, never by a clock: certificate checks (hits included, the closure's work per fold)
// and statement signature verifications that miss the caches. A return to quadratic folds shows as
// a check count far above linear in the certificates. Test support only (synthetic data).

import type { UnstampedEvent } from "../../carrier.js";
import {
  CertificateCache,
  certifyDevice,
  createDeviceId,
  createDeviceIdentity,
  type DeviceIdentity,
} from "../../crypto/index.js";
import { toHex } from "../../devices/bytes.js";
import {
  buildDeviceAdded,
  buildDeviceRevoked,
  type LogEvent,
  revocationConsentBody,
} from "../../devices/events.js";
import { foldRegistry, type Registry, type TrustRoot } from "../../devices/registry.js";
import {
  memoizedVerifier,
  type StatementVerifier,
  signStatement,
} from "../../devices/statements.js";
import { createSimVault, hlcAt, newEid, START_TIME, sodium } from "./testkit.js";

class Stream {
  #offset = 0;
  readonly events: LogEvent[] = [];
  readonly writer: string;
  constructor(writer: string) {
    this.writer = writer;
  }
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
  override check(key: string, compute: () => boolean): boolean {
    this.checks += 1;
    return super.check(key, () => {
      this.misses += 1;
      return compute();
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

/**
 * Folds of `s` that share one certificate cache and one memoized verifier: the first call is the cold
 * fold, every later one a warm re-fold (what a device does on every change). Each returns its own work.
 */
export function folds(s: Scenario): () => FoldCost {
  const cache = new CountingCache();
  const memo = memoizedVerifier();
  let statements = 0;
  // Counts statement checks (memo hits included): linear in the statements when the fold is.
  const counting: StatementVerifier = (...args) => {
    statements += 1;
    return memo(...args);
  };
  return () => {
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
}

/** A cold fold, then a warm re-fold with the same caches. */
export function foldTwice(s: Scenario): { cold: FoldCost; warm: FoldCost } {
  const fold = folds(s);
  return { cold: fold(), warm: fold() };
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
  const { creator: a, recovery } = createSimVault();
  const vaultId = a.ring.vaultId;
  const stream = new Stream(a.id);
  const puppets = subjects(n);
  for (const p of puppets) {
    const cert = certifyDevice(sodium, a.identity, p, vaultId);
    stream.add(buildDeviceAdded(a.identity, vaultId, newEid(), p, "puppet", cert));
  }
  // The revoker is a second device the words certified: A cannot revoke on the consent of devices
  // it certified itself (H5').
  const s = createDeviceIdentity(sodium);
  const sSubject = {
    deviceId: s.deviceId,
    signPublicKey: s.signPublicKey,
    boxPublicKey: s.box.publicKey,
  };
  stream.add(
    buildDeviceAdded(
      recovery,
      vaultId,
      newEid(),
      sSubject,
      "revoker",
      certifyDevice(sodium, recovery, sSubject, vaultId),
    ),
  );
  const revokes = new Stream(s.deviceId);
  for (const p of puppets) {
    revokes.add(consentedRevocation(s, vaultId, p.deviceId));
  }
  return {
    root: { vaultId, recovery: a.ring.recovery },
    events: [...a.stream.flatMap((x) => x.events), ...stream.events, ...revokes.events],
    certificates: 2 + n,
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
  const streams = issuers.map((i) => new Stream(i.deviceId));
  const children = issuers.map(() => subjects(62));
  issuers.forEach((i, n) => {
    for (const c of children[n] ?? []) {
      const cert = certifyDevice(sodium, i, c, vaultId);
      streams[n]?.add(buildDeviceAdded(i, vaultId, newEid(), c, "leaf", cert));
    }
  });
  // Each issuer revokes 10 children of the NEXT issuer, on their consent (H5': never its own).
  issuers.forEach((i, n) => {
    for (const c of (children[(n + 1) % issuers.length] ?? []).slice(0, 10)) {
      streams[n]?.add(consentedRevocation(i, vaultId, c.deviceId));
    }
  });
  streams.unshift(top);
  return {
    root: { vaultId, recovery: a.ring.recovery },
    events: [...a.stream.flatMap((s) => s.events), ...streams.flatMap((s) => s.events)],
    certificates: 1 + 16 + 16 * 62,
  };
}

/**
 * H1: a still-trusted device M certifies `k` puppets that form a defeat chain (each revokes the next
 * with its consent: the attacker holds them all); then the owner revokes M with the recovery words.
 */
export function puppetDefeatChain(k: number): Scenario {
  const vault = createSimVault();
  const a = vault.creator;
  const vaultId = a.ring.vaultId;
  const m = createDeviceIdentity(sodium);
  const top = new Stream(a.id);
  const mSubject = {
    deviceId: m.deviceId,
    signPublicKey: m.signPublicKey,
    boxPublicKey: m.box.publicKey,
  };
  top.add(
    buildDeviceAdded(
      a.identity,
      vaultId,
      newEid(),
      mSubject,
      "stolen",
      certifyDevice(sodium, a.identity, mSubject, vaultId),
    ),
  );
  const ms = new Stream(m.deviceId);
  const puppets = Array.from({ length: k }, () => createDeviceIdentity(sodium));
  for (const p of puppets) {
    const s = {
      deviceId: p.deviceId,
      signPublicKey: p.signPublicKey,
      boxPublicKey: p.box.publicKey,
    };
    ms.add(
      buildDeviceAdded(m, vaultId, newEid(), s, "puppet", certifyDevice(sodium, m, s, vaultId)),
    );
  }
  const streams = [top, ms];
  for (let i = 0; i + 1 < k; i++) {
    const signer = puppets[i] as DeviceIdentity;
    const target = puppets[i + 1] as DeviceIdentity;
    const st = new Stream(signer.deviceId);
    const eid = newEid();
    const entries = [{ device: target.deviceId, cut: { seg: 1, offset: 0 } }];
    const sig = signStatement(
      target,
      "cashu/registry/v1",
      revocationConsentBody(vaultId, eid, entries, signer.deviceId),
    );
    st.add(
      buildDeviceRevoked(signer, vaultId, eid, entries, {
        consent: { [target.deviceId]: toHex(sig) },
      }),
    );
    streams.push(st);
  }
  top.add(
    buildDeviceRevoked(vault.recovery, vaultId, newEid(), [
      { device: m.deviceId, cut: { seg: 1, offset: 100 * (k + 1) } },
    ]),
  );
  return {
    root: { vaultId, recovery: a.ring.recovery },
    events: [...a.stream.flatMap((s) => s.events), ...streams.flatMap((s) => s.events)],
    certificates: 2 + k,
  };
}
