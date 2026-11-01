import { describe, expect, it } from "vitest";
import type { UnstampedEvent } from "../carrier.js";
import {
  certifyDevice,
  createDeviceId,
  createDeviceIdentity,
  type DeviceIdentity,
} from "../crypto/index.js";
import { toHex } from "./bytes.js";
import {
  buildDeviceAdded,
  buildDeviceRevoked,
  DEVICE_ADDED,
  DEVICE_REVOKED,
  type LogEvent,
} from "./events.js";
import { PairingInviter } from "./pairing.js";
import { foldRegistry, type Registry } from "./registry.js";
import { expectOrderFree, mutualRevocationScenario } from "./registryOrder.js";
import {
  createSimVault,
  hlcAt,
  newEid,
  pairDevice,
  revokedWithConsent,
  type SimDevice,
  START_TIME,
  sodium,
} from "./testkit.js";

function stamp(e: UnstampedEvent, writer: string, wall: number, offset = wall): LogEvent {
  return {
    eid: e.i,
    hlc: hlcAt(writer, wall),
    writer,
    position: { seg: 1, offset },
    type: e.t,
    v: e.v,
    data: e.d,
  };
}

function subjectOf(d: DeviceIdentity) {
  return { deviceId: d.deviceId, signPublicKey: d.signPublicKey, boxPublicKey: d.box.publicKey };
}

function fold(device: SimDevice, events: readonly LogEvent[]): Registry {
  return foldRegistry(
    sodium,
    { vaultId: device.ring.vaultId, recovery: device.ring.recovery },
    events,
    // The device's own signature caches (results are a function of the bytes): a test's folds and
    // the device's ingests verify each statement once, as a running device does.
    { verify: device.verify, certificateCache: device.certificateCache },
  );
}

function allEvents(...devices: SimDevice[]): LogEvent[] {
  return devices.flatMap((d) => d.stream.flatMap((s) => s.events));
}

async function vaultOfThree() {
  const { creator: a, recovery } = createSimVault();
  const b = await pairDevice(a, "phone");
  const c = await pairDevice(b, "laptop"); // certified by B, not by A
  for (const d of [a, b, c]) d.sync();
  return { a, b, c, recovery };
}

describe("device registry", () => {
  it("the fold depends only on the set of events (any order, duplicates; seeds 1-3, the sweep is exhaustive)", async () => {
    const scenario = await mutualRevocationScenario();
    for (let seed = 1; seed <= 3; seed++) expectOrderFree(scenario, seed);
  });

  it("ignores forged statements: tampered, another eid, another vault, signer not the writer", async () => {
    const { a, b, c } = await vaultOfThree();
    const vaultId = a.ring.vaultId;
    const revoke = revokedWithConsent(
      b.identity,
      vaultId,
      [{ device: c.id, cut: { seg: 1, offset: 0 } }],
      [c],
    );
    const tampered = stamp(
      { ...revoke, d: { ...revoke.d, devices: [{ device: a.id, cut: { seg: 1, offset: 0 } }] } },
      b.id,
      START_TIME + 1e7,
    );
    const reKeyed = stamp({ ...revoke, i: newEid() }, b.id, START_TIME + 1e7 + 1);
    const otherVault = stamp(
      revokedWithConsent(
        b.identity,
        "ab".repeat(16),
        [{ device: c.id, cut: { seg: 1, offset: 0 } }],
        [c],
      ),
      b.id,
      START_TIME + 1e7 + 2,
    );
    const wrongWriter = stamp({ ...revoke, i: newEid() }, a.id, START_TIME + 1e7 + 3);
    const r = fold(a, [...allEvents(a, b, c), tampered, reKeyed, otherVault, wrongWriter]);
    expect(r.revocationCount).toBe(0);
    // The tampered copy names a target its consent does not cover: malformed before any signature.
    expect(r.ignored.map((i) => i.reason).sort()).toEqual([
      "bad_signature",
      "bad_signature",
      "malformed",
      "untrusted_signer",
    ]);
  });

  it("revoking a device untrusts its certificate subtree until another trusted device re-certifies", async () => {
    const { a, b, c, recovery } = await vaultOfThree();
    const vaultId = a.ring.vaultId;
    const revokeB = stamp(
      // A certified B, so it cannot revoke B on B's consent (H5'): the owner uses the words.
      buildDeviceRevoked(recovery, vaultId, newEid(), [
        { device: b.id, cut: { seg: 1, offset: 1e6 } },
      ]),
      a.id,
      START_TIME + 1e8,
      1e6,
    );
    const r = fold(a, [...allEvents(a, b, c), revokeB]);
    expect(r.isTrusted(c.id)).toBe(false); // C was certified only by B
    expect(r.devices.get(c.id)?.name).toBe("laptop");
    const recert = certifyDevice(sodium, a.identity, subjectOf(c.identity), vaultId);
    const added = stamp(
      buildDeviceAdded(a.identity, vaultId, newEid(), subjectOf(c.identity), "laptop", recert),
      a.id,
      START_TIME + 1e8 + 1,
      1e6 + 1,
    );
    expect(fold(a, [...allEvents(a, b, c), revokeB, added]).isTrusted(c.id)).toBe(true);
  });

  it("names need the declared keys to match the certified ones; an edited copy of a statement never verifies", async () => {
    const { a, b, c } = await vaultOfThree();
    const vaultId = a.ring.vaultId;
    const other = createDeviceIdentity(sodium);
    const cert = certifyDevice(sodium, a.identity, subjectOf(c.identity), vaultId);
    const lying = stamp(
      buildDeviceAdded(
        a.identity,
        vaultId,
        newEid(),
        { ...subjectOf(c.identity), signPublicKey: other.signPublicKey },
        "evil",
        cert,
      ),
      a.id,
      START_TIME - 1, // sorts first: it must still not rename C
    );
    const original = allEvents(a, b, c);
    const first = original[0] as LogEvent;
    const duplicate = { ...first, data: { ...first.data, name: "changed" } };
    const r = fold(a, [...original, lying, duplicate]);
    expect(r.devices.get(c.id)?.name).toBe("laptop");
    expect(r.ignored.map((i) => i.reason).sort()).toEqual(["bad_signature", "key_mismatch"]);
  });

  it("a revocation of an unknown device does not count; the recovery identity may revoke from any writer", async () => {
    const { a, b, c, recovery } = await vaultOfThree();
    const vaultId = a.ring.vaultId;
    const ghost = createDeviceIdentity(sodium).deviceId;
    const unknown = stamp(
      buildDeviceRevoked(a.identity, vaultId, newEid(), [
        { device: ghost, cut: { seg: 1, offset: 0 } },
      ]),
      a.id,
      START_TIME + 1e7,
    );
    const restorer = createDeviceIdentity(sodium);
    const byRecovery = stamp(
      buildDeviceRevoked(
        recovery,
        vaultId,
        newEid(),
        [a, b, c].map((d) => ({ device: d.id, cut: { seg: 1, offset: 1e6 } })),
      ),
      restorer.deviceId,
      START_TIME + 2e7,
    );
    const r = fold(a, [...allEvents(a, b, c), unknown, byRecovery]);
    expect(r.ignored).toContainEqual({ eid: unknown.eid, reason: "no_effect" });
    expect(r.revocationCount).toBe(1); // one event revoking three devices is one epoch step
    expect(r.trusted.size).toBe(0);
    expect(r.trustedSigner("0".repeat(32))).toEqual(a.ring.recovery.signPublicKey);
  });
});

describe("registry caps and cut boundary (review M4, m3)", () => {
  it("counts at most 64 certificates per issuer and 64 revocations per signer; unsigned junk counts toward nothing", async () => {
    const { creator: a, recovery } = createSimVault();
    const vaultId = a.ring.vaultId;
    // The revoker of the puppets A certified must not be A (H5'): a device the words certified,
    // which takes none of A's 64 certificate slots.
    const signer = createDeviceIdentity(sodium);
    const signerAdded = stamp(
      buildDeviceAdded(
        recovery,
        vaultId,
        newEid(),
        subjectOf(signer),
        "revoker",
        certifyDevice(sodium, recovery, subjectOf(signer), vaultId),
      ),
      a.id,
      START_TIME + 500,
      500,
    );
    const puppets = Array.from({ length: 70 }, () => createDeviceIdentity(sodium));
    const adds = puppets.map((p, i) =>
      stamp(
        buildDeviceAdded(
          a.identity,
          vaultId,
          newEid(),
          subjectOf(p),
          `puppet ${i}`,
          certifyDevice(sodium, a.identity, subjectOf(p), vaultId),
        ),
        a.id,
        START_TIME + 1000 + i,
        1000 + i,
      ),
    );
    const revokes = puppets.map((_, i) =>
      stamp(
        revokedWithConsent(
          signer,
          vaultId,
          [{ device: puppets[i % 64]?.deviceId ?? "", cut: { seg: 1, offset: 0 } }],
          [puppets[i % 64] as DeviceIdentity],
        ),
        signer.deviceId,
        START_TIME + 2000 + i,
        2000 + i,
      ),
    );
    // Junk: unsigned statements naming fresh ids, in a stranger's stream.
    const stranger = createDeviceIdentity(sodium).deviceId;
    // Built without signing (the junk is unsigned anyway): fresh ids, one key pair, zero certificate.
    const junkKeys = createDeviceIdentity(sodium);
    const junk: LogEvent[] = Array.from({ length: 2000 }, (_, i) => {
      const e: UnstampedEvent = {
        t: DEVICE_ADDED,
        v: 1,
        i: newEid(),
        d: {
          device: createDeviceId(sodium),
          signPublicKey: toHex(junkKeys.signPublicKey),
          boxPublicKey: toHex(junkKeys.box.publicKey),
          name: "junk",
          certificate: "00".repeat(225),
          signer: a.id,
          sig: "00".repeat(64),
        },
      };
      return stamp(e, stranger, START_TIME + 5000 + i, 5000 + i);
    });
    const base = [...allEvents(a), signerAdded];
    const r = fold(a, [...base, ...adds, ...junk]);
    expect(r.certificatesIssuedBy(a.id)).toBe(64);
    expect(puppets.filter((p) => r.isTrusted(p.deviceId))).toHaveLength(64);
    expect(r.isRegistered(puppets[69]?.deviceId ?? "")).toBe(false); // the issuer's 65th onward
    expect(r.events.length).toBe(2 + 64); // only authentic statements (and the revoker): no junk
    const withRevocations = fold(a, [...base, ...adds, ...revokes, ...junk]);
    expect(withRevocations.revocationCount).toBe(64);
    const capped = withRevocations.ignored.filter((i) => i.reason === "capped");
    const revokeEids = new Set(revokes.map((e) => e.eid));
    expect(capped.filter((i) => revokeEids.has(i.eid))).toHaveLength(6);
    // The issuer's 65th to 70th certificates are capped too (S29c R2: a reason, not a key mismatch).
    expect(capped.filter((i) => !revokeEids.has(i.eid))).toHaveLength(6);
    // The junk sits in a stranger's stream: never even a candidate (malformed bytes here).
    expect(r.ignored.filter((i) => i.reason === "malformed")).toHaveLength(2000);
    // Pairing refuses at the cap rather than certify a 65th device that would not count.
    a.devices.ingest([...adds, ...junk]);
    expect(
      PairingInviter.create({
        sodium,
        identity: a.identity,
        ring: a.ring,
        registry: a.devices.registry,
        now: a.now(),
      }),
    ).toMatchObject({ ok: false, reason: "capacity" });
  });

  it("forged certificates naming a real issuer never consume its quota", async () => {
    const { creator: a } = createSimVault();
    const vaultId = a.ring.vaultId;
    const stranger = createDeviceIdentity(sodium).deviceId;
    const forged: LogEvent[] = Array.from({ length: 200 }, (_, i) => {
      const p = createDeviceIdentity(sodium);
      const cert = certifyDevice(sodium, a.identity, subjectOf(p), vaultId);
      cert.fill(7, cert.length - 64); // keep "signer = A", break the signature
      const e = buildDeviceAdded(a.identity, vaultId, newEid(), subjectOf(p), "forged", cert);
      // Half sit in a stranger's stream, half in frames forged under A's id.
      return stamp(e, i % 2 === 0 ? stranger : a.id, START_TIME + i, 10_000 + i);
    });
    a.devices.ingest(forged);
    expect(a.devices.registry.certificatesIssuedBy(a.id)).toBe(0);
    const b = await pairDevice(a, "phone");
    expect(a.devices.registry.certificatesIssuedBy(a.id)).toBe(1);
    expect(b.devices.registry.isTrusted(b.id)).toBe(true);
  });

  it("junk in the log never blocks pairing (the welcome carries authentic statements only)", async () => {
    const { creator: a } = createSimVault();
    const stranger = createDeviceIdentity(sodium).deviceId;
    // Built without signing (the junk carries a junk signature anyway).
    const junk: LogEvent[] = Array.from({ length: 5000 }, (_, i) => {
      const e: UnstampedEvent = {
        t: DEVICE_REVOKED,
        v: 1,
        i: newEid(),
        d: {
          devices: [{ device: a.id, cut: { seg: 1, offset: 0 } }],
          signer: a.id,
          sig: "11".repeat(64),
        },
      };
      return stamp(e, stranger, START_TIME + i, i + 1);
    });
    a.devices.ingest(junk);
    expect(a.devices.registry.isTrusted(a.id)).toBe(true);
    const b = await pairDevice(a, "phone");
    expect(b.devices.registry.isTrusted(b.id)).toBe(true);
  });

  it("one cut definition: a cut inside a batch rejects that batch's data and its statements alike", async () => {
    const { a, b, c, recovery } = await vaultOfThree();
    const vaultId = a.ring.vaultId;
    // C is revoked with a cut in the middle of the batch [100, 200).
    const revokeC = stamp(
      buildDeviceRevoked(recovery, vaultId, newEid(), [
        { device: c.id, cut: { seg: 1, offset: 150 } },
      ]),
      a.id,
      START_TIME + 1e7,
      1e6,
    );
    const inside = stamp(
      revokedWithConsent(c.identity, vaultId, [{ device: b.id, cut: { seg: 1, offset: 0 } }], [b]),
      c.id,
      START_TIME + 1,
      200, // the batch ends at 200, after the cut
    );
    const r = fold(a, [...allEvents(a, b, c), revokeC, inside]);
    expect(r.isTrusted(b.id)).toBe(true);
    expect(r.ignored).toContainEqual({ eid: inside.eid, reason: "after_revocation" });
    a.devices.ingest([revokeC, inside]);
    const guard = a.devices.guard;
    const key = { epoch: 0, generation: 1 };
    expect(
      guard.check(
        { device: c.id, start: { seg: 1, offset: 100 }, end: { seg: 1, offset: 200 } },
        key,
      ),
    ).toEqual({ ok: false, reason: "revoked_writer" });
    expect(
      guard.check({ device: c.id, start: { seg: 1, offset: 0 }, end: { seg: 1, offset: 100 } }, key)
        .ok,
    ).toBe(true);
  });
});
