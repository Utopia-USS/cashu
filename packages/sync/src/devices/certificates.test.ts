// S29c R2 (S29-review.md "S29b re-check"): junk certificates must never erase trust. Certificates are
// windowed per WRITER stream, signatures are checked before a certificate can use a window's quota,
// certificates outside their issuer's stream are ignored (D2) and the certificates a revoked writer
// logged after its cut are dropped. One fold per rule over a shared four-device vault.

import { beforeAll, describe, expect, it } from "vitest";
import type { UnstampedEvent } from "../carrier.js";
import {
  CertificateCache,
  certifyDevice,
  createDeviceIdentity,
  createRecoveryKey,
  type DeviceIdentity,
  RECOVERY_SIGNER_ID,
  recoveryIdentity,
} from "../crypto/index.js";
import {
  createSimVault,
  hlcAt,
  newEid,
  pairDevice,
  type SimDevice,
  START_TIME,
  sodium,
} from "../testing/devices/testkit.js";
import { concat, fromHex, toHex } from "./bytes.js";
import { buildDeviceAdded, buildDeviceRevoked, DEVICE_ADDED, type LogEvent } from "./events.js";
import { foldRegistry, type Registry, type RegistryOptions } from "./registry.js";
import { CERT_CHECK_BUDGET, MAX_CERTS_PER_ISSUER } from "./registryTypes.js";
import { type StatementVerifier, verifyStatement } from "./statements.js";

const KEYS = createDeviceIdentity(sodium); // one key pair for every junk subject (only ids differ)
/** Junk past an issuer's quota: enough to evict a genuine certificate if junk could take a slot. */
const OVER_QUOTA = MAX_CERTS_PER_ISSUER + 1;

/** A device id starting with `00` (sorts before every real id by hex). */
function lowId(i: number): string {
  return `00${i.toString(16).padStart(6, "0")}${toHex(sodium.randomBytes(12))}`;
}

/** A certificate claiming `issuer` for `subject` with a junk signature. */
function junkCertificate(issuer: string, subject: string): Uint8Array {
  return concat(
    Uint8Array.of(1),
    fromHex(issuer),
    fromHex(subject),
    KEYS.signPublicKey,
    KEYS.box.publicKey,
    new Uint8Array(64).fill(7),
  );
}

/** An unsigned `device.added` (statement signer `signer`, junk statement signature). */
function junkAdded(issuer: string, signer: string, subject = lowId(0)): UnstampedEvent {
  return {
    t: DEVICE_ADDED,
    v: 1,
    i: newEid(),
    d: {
      device: subject,
      signPublicKey: toHex(KEYS.signPublicKey),
      boxPublicKey: toHex(KEYS.box.publicKey),
      name: "junk",
      certificate: toHex(junkCertificate(issuer, subject)),
      signer,
      sig: "11".repeat(64),
    },
  };
}

function subjectOf(d: DeviceIdentity) {
  return { deviceId: d.deviceId, signPublicKey: d.signPublicKey, boxPublicKey: d.box.publicKey };
}

/** A genuine `device.added`: `issuer` certifies a fresh device and signs the statement. */
function genuineAdd(
  issuer: DeviceIdentity,
  vaultId: string,
  subject = createDeviceIdentity(sodium),
) {
  const cert = certifyDevice(sodium, issuer, subjectOf(subject), vaultId);
  const event = buildDeviceAdded(issuer, vaultId, newEid(), subjectOf(subject), "added", cert);
  return { id: subject.deviceId, event };
}

function stamp(e: UnstampedEvent, writer: string, offset: number): LogEvent {
  return {
    eid: e.i,
    hlc: hlcAt(writer, START_TIME + offset),
    writer,
    position: { seg: 1, offset },
    type: e.t,
    v: e.v,
    data: e.d,
  };
}

/** `events` in `writer`'s stream from `offset` on, in order (after every genuine event of the vault). */
function inStream(writer: string, offset: number, events: readonly UnstampedEvent[]): LogEvent[] {
  return events.map((e, i) => stamp(e, writer, offset + i));
}

function summary(reg: Registry) {
  return {
    trusted: [...reg.trusted.keys()].sort(),
    conflicts: [...reg.conflicts],
    revoked: [...reg.revoked.keys()].sort(),
  };
}

const reasons = (reg: Registry, reason: string) =>
  reg.ignored.filter((x) => x.reason === reason).length;

class CountingCache extends CertificateCache {
  misses = 0;
  override check(key: string, verify: () => boolean): boolean {
    return super.check(key, () => {
      this.misses += 1;
      return verify();
    });
  }
}

describe("R2 junk certificates", () => {
  let a: SimDevice;
  let b: SimDevice;
  let r: SimDevice;
  let c: SimDevice;
  let recovery: DeviceIdentity;
  let vaultId: string;
  let honest: LogEvent[];
  let before: ReturnType<typeof summary>;
  const START = 1_000_000; // stream offset after every genuine event of the vault

  const fold = (extra: readonly LogEvent[], options: RegistryOptions = {}) =>
    foldRegistry(sodium, { vaultId, recovery: a.ring.recovery }, [...honest, ...extra], options);

  beforeAll(async () => {
    const vault = createSimVault();
    a = vault.creator;
    recovery = vault.recovery;
    b = await pairDevice(a, "phone");
    r = await pairDevice(a, "laptop");
    c = await pairDevice(a, "tablet");
    for (let i = 0; i < 2; i++) for (const d of [a, b, r, c]) d.sync();
    vaultId = a.ring.vaultId;
    honest = [a, b, r, c].flatMap((d) => d.stream.flatMap((s) => s.events));
    before = summary(fold([]));
  });

  it("certificates outside their issuer's stream never count and never crowd that issuer (R2 exact)", () => {
    // R signs statements carrying forged recovery-issued certificates of `00...` subjects (the
    // review's attack), and unsigned junk claiming B as issuer, each past the issuer's quota.
    const forgedRecovery = Array.from({ length: OVER_QUOTA }, (_, i) => {
      const subject = { ...subjectOf(r.identity), deviceId: lowId(i) };
      const cert = junkCertificate(RECOVERY_SIGNER_ID, subject.deviceId);
      return buildDeviceAdded(r.identity, vaultId, newEid(), subject, "junk", cert);
    });
    const claimingB = Array.from({ length: OVER_QUOTA }, (_, i) => junkAdded(b.id, r.id, lowId(i)));
    // Afterwards the words re-certify a device (from B's stream) and B certifies one.
    const restored = genuineAdd(recovery, vaultId);
    const byB = genuineAdd(b.identity, vaultId);
    const reg = fold([
      ...inStream(r.id, START, [...forgedRecovery, ...claimingB]),
      ...inStream(b.id, START, [restored.event, byB.event]),
    ]);
    expect(summary(reg)).toEqual({
      ...before,
      trusted: [...before.trusted, restored.id, byB.id].sort(),
    });
    expect(reg.certificatesIssuedBy(b.id)).toBe(1);
    expect(reasons(reg, "foreign_certificate")).toBe(2 * OVER_QUOTA);
  });

  it("junk statements in one stream use only that stream's check budget, and never a statement check", () => {
    const junk = Array.from({ length: CERT_CHECK_BUDGET + 44 }, (_, i) =>
      junkAdded(RECOVERY_SIGNER_ID, RECOVERY_SIGNER_ID, lowId(i)),
    );
    let statementChecks = 0;
    const verify: StatementVerifier = (...args) => {
      statementChecks += 1;
      return verifyStatement(...args);
    };
    const cache = new CountingCache();
    const reg = fold(inStream(r.id, START, junk), { verify, certificateCache: cache });
    expect(summary(reg)).toEqual(before);
    expect(reasons(reg, "bad_signature")).toBe(CERT_CHECK_BUDGET);
    expect(reasons(reg, "capped")).toBe(44);
    // Every junk certificate failed its recovery signature; the genuine ones were checked too.
    expect(cache.misses).toBeLessThanOrEqual(CERT_CHECK_BUDGET + 2 * 16);
    // The junk fails at its certificate, so no junk statement signature is ever checked.
    const honestStatements = honest.filter((e) => e.type === DEVICE_ADDED).length;
    expect(statementChecks).toBeLessThanOrEqual(2 * honestStatements);
  });

  it("junk claiming a writer as issuer in its own stream never takes its quota; past the budget it hurts only that writer", () => {
    // Over the quota but within the check budget: junk costs checks, never quota.
    const x = genuineAdd(r.identity, vaultId);
    const selfJunk = (n: number, from: number) =>
      Array.from({ length: n }, (_, i) => junkAdded(r.id, r.id, lowId(from + i)));
    const withinBudget = [...selfJunk(OVER_QUOTA, 0), x.event];
    const first = fold(inStream(r.id, START, withinBudget));
    expect(first.isTrusted(x.id)).toBe(true);
    expect(first.certificatesIssuedBy(r.id)).toBe(1);
    // Past the budget R's later certificates stop counting; X and another writer's stay trusted.
    const w = genuineAdd(r.identity, vaultId);
    const y = genuineAdd(b.identity, vaultId);
    const reg = fold([
      ...inStream(r.id, START, [...withinBudget, ...selfJunk(CERT_CHECK_BUDGET, 1000), w.event]),
      ...inStream(b.id, START, [y.event]),
    ]);
    expect(reg.isTrusted(x.id)).toBe(true);
    expect(reg.isTrusted(w.id)).toBe(false);
    expect(reg.isTrusted(y.id)).toBe(true);
  });

  it("a revoked writer's certificates after its cut never register a device", () => {
    const cut = { seg: 1, offset: START };
    const revokeR = buildDeviceRevoked(recovery, vaultId, newEid(), [{ device: r.id, cut }]);
    // After its cut R certifies puppets with valid signatures, then logs junk.
    const puppets = [genuineAdd(r.identity, vaultId), genuineAdd(r.identity, vaultId)];
    const junk = [junkAdded(r.id, r.id, lowId(0)), junkAdded(r.id, r.id, lowId(1))];
    const reg = fold([
      ...inStream(a.id, START, [revokeR]),
      ...inStream(r.id, START + 1, [...puppets.map((p) => p.event), ...junk]),
    ]);
    expect(summary(reg)).toEqual({
      ...before,
      trusted: before.trusted.filter((id) => id !== r.id),
      revoked: [r.id],
    });
    for (const p of puppets) expect(reg.isRegistered(p.id)).toBe(false);
    expect(reasons(reg, "after_revocation")).toBe(4);
  });

  it("a recovery-signed re-certification in any stream counts; a copy with a broken statement signature does not", () => {
    const z = genuineAdd(recovery, vaultId);
    const z2 = genuineAdd(recovery, vaultId);
    const broken = { ...z2.event, d: { ...z2.event.d, sig: "22".repeat(64) } };
    const reg = fold(inStream(b.id, START, [z.event, broken]));
    expect(reg.isTrusted(z.id)).toBe(true);
    expect(reg.isTrusted(z2.id)).toBe(false);
    expect(reg.ignored).toContainEqual({ eid: broken.i, reason: "bad_signature" });
  });

  it("a recovery-issued certificate under words that are not the vault's never counts", () => {
    const other = recoveryIdentity(sodium, createRecoveryKey(sodium).phrase);
    const forged = genuineAdd(other, vaultId);
    expect(fold(inStream(b.id, START, [forged.event])).isTrusted(forged.id)).toBe(false);
  });

  it("property: the registry is a function of the event set, junk writers and revocations included", () => {
    const revokeR = stamp(
      buildDeviceRevoked(recovery, vaultId, newEid(), [
        { device: r.id, cut: { seg: 1, offset: START } },
      ]),
      a.id,
      START,
    );
    const fresh = createDeviceIdentity(sodium).deviceId;
    const events = [
      ...honest,
      revokeR,
      ...Array.from({ length: 40 }, (_, i) =>
        stamp(junkAdded(r.id, r.id, lowId(i)), r.id, START + 1 + i),
      ),
      ...Array.from({ length: 40 }, (_, i) =>
        stamp(junkAdded(RECOVERY_SIGNER_ID, RECOVERY_SIGNER_ID, lowId(i)), fresh, 1 + i),
      ),
      ...Array.from({ length: 40 }, (_, i) =>
        stamp(junkAdded(b.id, c.id, lowId(i)), c.id, START + i),
      ),
    ];
    const root = { vaultId, recovery: a.ring.recovery };
    const cache = new CertificateCache();
    const shape = (reg: Registry) => ({
      ...summary(reg),
      issued: [a, b, r, c].map((d) => reg.certificatesIssuedBy(d.id)),
      ignored: reg.ignored.map((x) => `${x.eid}:${x.reason}`).sort(),
    });
    const reference = shape(foldRegistry(sodium, root, events, { certificateCache: cache }));
    expect(reference.revoked).toEqual([r.id]);
    for (let seed = 1; seed <= 8; seed++) {
      const shuffled = shuffle(events, seed);
      expect(
        shape(foldRegistry(sodium, root, shuffled, { certificateCache: cache })),
        `seed ${seed}`,
      ).toEqual(reference);
    }
  });
});

function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}
