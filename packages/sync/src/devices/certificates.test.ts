// S29c R2 (S29-review.md "S29b re-check"): junk certificates must never erase trust. Certificates are
// windowed per WRITER stream, signatures are checked before a certificate can use a window's quota,
// certificates outside their issuer's stream are ignored (D2) and the certificates a revoked writer
// logged after its cut are dropped. Permanent tests of the review's attack and its variants.

import { describe, expect, it } from "vitest";
import type { UnstampedEvent } from "../carrier.js";
import {
  CertificateCache,
  certifyDevice,
  createDeviceIdentity,
  createRecoveryKey,
  RECOVERY_SIGNER_ID,
  recoveryIdentity,
} from "../crypto/index.js";
import { concat, fromHex, toHex } from "./bytes.js";
import { buildDeviceAdded, buildDeviceRevoked, DEVICE_ADDED, type LogEvent } from "./events.js";
import { foldRegistry, type Registry } from "./registry.js";
import { CERT_CHECK_BUDGET } from "./registryTypes.js";
import { type StatementVerifier, verifyStatement } from "./statements.js";
import {
  createSimVault,
  hlcAt,
  newEid,
  pairDevice,
  type SimDevice,
  START_CURSOR,
  START_TIME,
  sodium,
} from "./testkit.js";

const KEYS = createDeviceIdentity(sodium); // one key pair for every junk subject (only ids differ)

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

function subjectOf(d: SimDevice) {
  return {
    deviceId: d.id,
    signPublicKey: d.identity.signPublicKey,
    boxPublicKey: d.identity.box.publicKey,
  };
}

function summary(reg: Registry) {
  return {
    trusted: [...reg.trusted.keys()].sort(),
    conflicts: [...reg.conflicts],
    revoked: [...reg.revoked.keys()].sort(),
  };
}

function syncAll(devices: readonly SimDevice[], rounds = 2): void {
  for (let i = 0; i < rounds; i++) for (const d of devices) d.sync();
}

async function fourDevices() {
  const vault = createSimVault();
  const a = vault.creator;
  const b = await pairDevice(a, "phone");
  const r = await pairDevice(a, "laptop");
  const c = await pairDevice(a, "tablet");
  syncAll([a, b, r, c]);
  return { ...vault, a, b, r, c };
}

function allEvents(...devices: SimDevice[]): LogEvent[] {
  return devices.flatMap((d) => d.stream.flatMap((s) => s.events));
}

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
  it("R2 exact: 300 forged recovery-issued certificates in a trusted writer's stream change no device's trust", async () => {
    const { a, b, r, c } = await fourDevices();
    const before = summary(a.devices.registry);
    // R signs 300 statements carrying forged recovery-issued certificates of `00...` subjects.
    r.write(
      Array.from({ length: 300 }, (_, i) => {
        const subject = { ...subjectOf(r), deviceId: lowId(i) };
        return buildDeviceAdded(
          r.identity,
          r.ring.vaultId,
          newEid(),
          subject,
          "junk",
          junkCertificate(RECOVERY_SIGNER_ID, subject.deviceId),
        );
      }),
    );
    syncAll([a, b, r, c]);
    const j = await pairDevice(a, "new phone");
    c.rebuild();
    syncAll([a, b, r, c, j]);
    const expected = { ...before, trusted: [...before.trusted, j.id].sort() };
    for (const d of [a, b, c, j]) {
      const reg = d.devices.registry;
      expect(summary(reg), d.name).toEqual(expected);
      expect(reg.ignored.filter((x) => x.reason === "foreign_certificate")).toHaveLength(300);
    }
  });

  it("recovery-claiming junk statements in one stream use only that stream's check budget", async () => {
    const { a, r } = await fourDevices();
    const before = summary(a.devices.registry);
    const junk = Array.from({ length: 300 }, (_, i) =>
      junkAdded(RECOVERY_SIGNER_ID, RECOVERY_SIGNER_ID, lowId(i)),
    );
    const events = [...allEvents(a, r), ...junk.map((e, i) => stamp(e, r.id, 100_000 + i))];
    const cache = new CountingCache();
    const reg = foldRegistry(
      sodium,
      { vaultId: a.ring.vaultId, recovery: a.ring.recovery },
      events,
      {
        certificateCache: cache,
      },
    );
    expect(summary(reg)).toEqual(before);
    const reasons = reg.ignored.map((x) => x.reason);
    expect(reasons.filter((x) => x === "bad_signature")).toHaveLength(CERT_CHECK_BUDGET);
    expect(reasons.filter((x) => x === "capped")).toHaveLength(300 - CERT_CHECK_BUDGET);
    // Every junk certificate failed its recovery signature; the genuine ones were checked too.
    expect(cache.misses).toBeLessThanOrEqual(CERT_CHECK_BUDGET + 2 * 16);
  });

  it("junk spread over fresh writer ids: trust unchanged, work bounded by writers x budget", async () => {
    const { a, b, r, c } = await fourDevices();
    const before = summary(a.devices.registry);
    const writers = Array.from({ length: 3 }, () => createDeviceIdentity(sodium).deviceId);
    const junk: LogEvent[] = [];
    for (const [w, writer] of writers.entries()) {
      for (let i = 0; i < 300; i++) {
        // Half claim the recovery signer, half are self announcements under the writer's id.
        const e =
          i % 2 === 0
            ? junkAdded(RECOVERY_SIGNER_ID, RECOVERY_SIGNER_ID, lowId(w * 1000 + i))
            : junkAdded(RECOVERY_SIGNER_ID, writer, writer);
        junk.push(stamp(e, writer, 1000 + i));
      }
    }
    let statementChecks = 0;
    const counting: StatementVerifier = (...args) => {
      statementChecks += 1;
      return verifyStatement(...args);
    };
    const cache = new CountingCache();
    const honest = allEvents(a, b, r, c);
    const reg = foldRegistry(
      sodium,
      { vaultId: a.ring.vaultId, recovery: a.ring.recovery },
      [...junk, ...honest],
      { verify: counting, certificateCache: cache },
    );
    expect(summary(reg)).toEqual(before);
    const honestStatements = honest.filter((e) => e.type === DEVICE_ADDED).length;
    // Per junk writer at most CERT_CHECK_BUDGET certificate checks; the junk fails there, so no
    // junk statement signature is ever checked (the honest ones are checked for names).
    expect(cache.misses).toBeLessThanOrEqual(writers.length * CERT_CHECK_BUDGET + 2 * 16);
    expect(statementChecks).toBeLessThanOrEqual(2 * honestStatements);
  });

  it("junk claiming another issuer in a writer's stream never crowds that issuer (foreign certificates)", async () => {
    const { a, b, r, c } = await fourDevices();
    r.write(Array.from({ length: 300 }, (_, i) => junkAdded(b.id, r.id, lowId(i))));
    syncAll([a, b, r, c]);
    const x = await pairDevice(b, "watch"); // certified by B after the junk
    syncAll([a, b, r, c, x]);
    for (const d of [a, c, x]) {
      expect(d.devices.registry.isTrusted(x.id), d.name).toBe(true);
      expect(d.devices.registry.certificatesIssuedBy(b.id)).toBe(1);
    }
  });

  it("junk claiming a writer as issuer in its own stream never consumes its quota (and only its own window)", async () => {
    const { a, b, r, c } = await fourDevices();
    // Below the check budget: junk costs checks, never quota.
    r.write(Array.from({ length: 200 }, (_, i) => junkAdded(r.id, r.id, lowId(i))));
    syncAll([a, b, r, c]);
    const x = await pairDevice(r, "watch");
    syncAll([a, b, r, c, x]);
    for (const d of [a, b, c, x]) {
      expect(d.devices.registry.isTrusted(x.id), d.name).toBe(true);
      expect(d.devices.registry.certificatesIssuedBy(r.id)).toBe(1);
    }
    // Past the budget the writer only hurts its own later certificates, never another writer's.
    r.write(Array.from({ length: CERT_CHECK_BUDGET }, (_, i) => junkAdded(r.id, r.id, lowId(i))));
    syncAll([a, b, r, c, x]);
    const y = await pairDevice(b, "ring");
    syncAll([a, b, r, c, x, y]);
    for (const d of [a, c, y]) {
      expect(d.devices.registry.isTrusted(y.id), d.name).toBe(true);
      expect(d.devices.registry.isTrusted(x.id), d.name).toBe(true);
    }
  });

  it("a revoked writer's certificates after its cut never register a device (second pass)", async () => {
    const { a, b, r, c } = await fourDevices();
    const result = a.devices.prepareRevocation(
      [{ device: r.id, cut: a.cursors.get(r.id) ?? START_CURSOR }],
      { revoke: newEid(), rotate: newEid() },
    );
    if (!result.ok) throw new Error(result.reason);
    a.write(result.change.events);
    result.change.commit();
    syncAll([a, b, c]);
    r.pull();
    const before = summary(a.devices.registry);
    // After its cut R certifies 64 puppets (valid signatures), then 300 junk certificates.
    const puppets = Array.from({ length: 64 }, () => createDeviceIdentity(sodium));
    r.write(
      puppets.map((p) => {
        const subject = {
          deviceId: p.deviceId,
          signPublicKey: p.signPublicKey,
          boxPublicKey: p.box.publicKey,
        };
        const cert = certifyDevice(sodium, r.identity, subject, r.ring.vaultId);
        return buildDeviceAdded(r.identity, r.ring.vaultId, newEid(), subject, "puppet", cert);
      }),
    );
    r.write(Array.from({ length: 300 }, (_, i) => junkAdded(r.id, r.id, lowId(i))));
    r.push();
    const j = await pairDevice(a, "new phone");
    syncAll([a, b, c, j]);
    const expected = { ...before, trusted: [...before.trusted, j.id].sort() };
    for (const d of [a, b, c, j]) {
      const reg = d.devices.registry;
      expect(summary(reg), d.name).toEqual(expected);
      for (const p of puppets) expect(reg.isRegistered(p.deviceId)).toBe(false);
      expect(reg.ignored.filter((x) => x.reason === "after_revocation").length).toBeGreaterThan(
        300,
      );
    }
  });

  it("a recovery-signed re-certification in any stream counts; a copy with a broken statement signature does not", async () => {
    const { a, b, recovery } = await fourDevices();
    const z = createDeviceIdentity(sodium);
    const z2 = createDeviceIdentity(sodium);
    const add = (d: typeof z) => {
      const subject = {
        deviceId: d.deviceId,
        signPublicKey: d.signPublicKey,
        boxPublicKey: d.box.publicKey,
      };
      const cert = certifyDevice(sodium, recovery, subject, a.ring.vaultId);
      return buildDeviceAdded(recovery, a.ring.vaultId, newEid(), subject, "restored", cert);
    };
    const broken = add(z2);
    b.write([add(z), { ...broken, d: { ...broken.d, sig: "22".repeat(64) } }]);
    syncAll([a, b]);
    const reg = a.devices.registry;
    expect(reg.isTrusted(z.deviceId)).toBe(true);
    expect(reg.isTrusted(z2.deviceId)).toBe(false);
    expect(reg.ignored).toContainEqual({ eid: broken.i, reason: "bad_signature" });
  });

  it("a recovery-issued certificate under words that are not the vault's never counts", async () => {
    const { a, b } = await fourDevices();
    const other = recoveryIdentity(sodium, createRecoveryKey(sodium).phrase);
    const z = createDeviceIdentity(sodium);
    const subject = {
      deviceId: z.deviceId,
      signPublicKey: z.signPublicKey,
      boxPublicKey: z.box.publicKey,
    };
    const cert = certifyDevice(sodium, other, subject, a.ring.vaultId);
    b.write([buildDeviceAdded(other, a.ring.vaultId, newEid(), subject, "forged", cert)]);
    syncAll([a, b]);
    expect(a.devices.registry.isTrusted(z.deviceId)).toBe(false);
  });

  it("cost: one cold fold of the 300-junk log stays within a CPU budget", async () => {
    const { a, r } = await fourDevices();
    const events = [
      ...allEvents(a, r),
      ...Array.from({ length: 300 }, (_, i) =>
        stamp(junkAdded(RECOVERY_SIGNER_ID, RECOVERY_SIGNER_ID, lowId(i)), r.id, 100_000 + i),
      ),
      ...Array.from({ length: 300 }, (_, i) =>
        stamp(junkAdded(RECOVERY_SIGNER_ID, r.id, lowId(i)), r.id, 200_000 + i),
      ),
    ];
    const start = process.cpuUsage();
    foldRegistry(sodium, { vaultId: a.ring.vaultId, recovery: a.ring.recovery }, events);
    const used = process.cpuUsage(start);
    const ms = (used.user + used.system) / 1000;
    expect(ms).toBeLessThan(1500);
  });

  it("property: the registry is a function of the event set, junk writers and revocations included", async () => {
    const { a, b, r, c } = await fourDevices();
    const vaultId = a.ring.vaultId;
    const revokeR = stamp(
      buildDeviceRevoked(a.identity, vaultId, newEid(), [
        { device: r.id, cut: { seg: 1, offset: 100 } },
      ]),
      a.id,
      50_000,
    );
    const fresh = createDeviceIdentity(sodium).deviceId;
    const events = [
      ...allEvents(a, b, r, c),
      revokeR,
      ...Array.from({ length: 40 }, (_, i) =>
        stamp(junkAdded(r.id, r.id, lowId(i)), r.id, 60_000 + i),
      ),
      ...Array.from({ length: 40 }, (_, i) =>
        stamp(junkAdded(RECOVERY_SIGNER_ID, RECOVERY_SIGNER_ID, lowId(i)), fresh, 1 + i),
      ),
      ...Array.from({ length: 40 }, (_, i) =>
        stamp(junkAdded(b.id, c.id, lowId(i)), c.id, 70_000 + i),
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
