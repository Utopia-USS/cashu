// S29c review round 5: retired devices (H5''), certification loops in the consent chain check, and
// voluntary self-retirement (lead decision: kept, with a fixed cut, orphans handled, keys wiped).

import { describe, expect, it } from "vitest";
import type { UnstampedEvent } from "../carrier.js";
import {
  CertificateIndex,
  certifyDevice,
  createDeviceIdentity,
  type DeviceIdentity,
} from "../crypto/index.js";
import { fromHex } from "./bytes.js";
import { DecisionKeys } from "./decisionKeys.js";
import { buildDeviceAdded, buildDeviceRevoked } from "./events.js";
import {
  consentsOf,
  createSimVault,
  newEid,
  pairDevice,
  revokedWithConsent,
  type SimDevice,
  START_CURSOR,
  sodium,
} from "./testkit.js";

function syncAll(devices: readonly SimDevice[], rounds = 2): void {
  for (let i = 0; i < rounds; i++) for (const d of devices) d.sync();
}

function note(): UnstampedEvent {
  return { t: "note.added", v: 1, i: newEid(), d: {} };
}

/** `revoker` retires `target` on its consent (the attacker keeps the target: no wipe here). */
function retire(revoker: SimDevice, target: SimDevice): void {
  revoker.write([
    revokedWithConsent(
      revoker.identity,
      revoker.ring.vaultId,
      [{ device: target.id, cut: revoker.cursors.get(target.id) ?? START_CURSOR }],
      [target],
    ),
  ]);
}

function mint(issuer: DeviceIdentity, vaultId: string, victim: string) {
  const key = createDeviceIdentity(sodium, victim);
  const subject = {
    deviceId: victim,
    signPublicKey: key.signPublicKey,
    boxPublicKey: key.box.publicKey,
  };
  return {
    event: buildDeviceAdded(
      issuer,
      vaultId,
      newEid(),
      subject,
      "minted",
      certifyDevice(sodium, issuer, subject, vaultId),
    ),
    key,
  };
}

async function household() {
  const vault = createSimVault();
  const a = vault.creator;
  const b = await pairDevice(a, "phone");
  const c = await pairDevice(a, "tablet");
  const d = await pairDevice(a, "watch");
  const r = await pairDevice(a, "old laptop");
  const r2 = await pairDevice(a, "old phone");
  syncAll([a, b, c, d, r, r2]);
  return { ...vault, a, b, c, d, r, r2 };
}

describe("H5'': consent keys avoid every retired device", () => {
  it("a consent-retired old phone mints keys for B, C, D; a consent-retired laptop revokes them with those consents: only the two old devices are revoked", async () => {
    const { a, b, c, d, r, r2 } = await household();
    retire(b, r2); // the old phone, retired on its consent, then sold (not wiped)
    retire(b, r); // the old laptop, likewise
    syncAll([a, b, c, d]);
    r.pull();
    r2.pull();
    const vaultId = a.ring.vaultId;
    const minted = [b, c, d].map((x) => mint(r2.identity, vaultId, x.id));
    r2.write(minted.map((m) => m.event));
    r.write(
      minted.map((m) => {
        const entries = [{ device: m.key.deviceId, cut: START_CURSOR }];
        const eid = newEid();
        return buildDeviceRevoked(r.identity, vaultId, eid, entries, {
          consent: consentsOf([m.key], vaultId, eid, entries, r.id),
        });
      }),
    );
    syncAll([a, b, c, d, r, r2]);
    for (const x of [a, b, c, d]) {
      const reg = x.devices.registry;
      expect([...reg.revoked.keys()].sort(), x.name).toEqual([r.id, r2.id].sort());
      for (const t of [a, b, c, d]) expect(reg.isTrusted(t.id), `${x.name}: ${t.name}`).toBe(true);
    }
  });

  it("control: after those retirements, a genuine consented retirement still counts", async () => {
    const { a, b, c, d, r, r2 } = await household();
    retire(b, r2);
    retire(b, r);
    syncAll([a, b, c, d]);
    retire(c, d); // the owner retires the watch from the tablet, confirming on the watch
    syncAll([a, b, c, d]);
    const reg = a.devices.registry;
    expect([...reg.revoked.keys()].sort()).toEqual([d.id, r.id, r2.id].sort());
    expect(reg.revoked.get(d.id)?.signers).toEqual([c.id]);
  });
});

describe("consent chain check on a certification loop", () => {
  it("a loop (X certifies Y, Y certifies X) never hides a chain that roots: every query order agrees", () => {
    const { creator: a } = createSimVault();
    const vaultId = a.ring.vaultId;
    const [x, y, z, w] = [0, 1, 2, 3].map(() => createDeviceIdentity(sodium)) as [
      DeviceIdentity,
      DeviceIdentity,
      DeviceIdentity,
      DeviceIdentity,
    ];
    const subject = (d: DeviceIdentity) => ({
      deviceId: d.deviceId,
      signPublicKey: d.signPublicKey,
      boxPublicKey: d.box.publicKey,
    });
    const certs: Uint8Array[] = [fromHex(a.stream[0]?.events[0]?.data.certificate as string)];
    certs.push(
      certifyDevice(sodium, a.identity, subject(x), vaultId),
      certifyDevice(sodium, x, subject(y), vaultId),
      certifyDevice(sodium, y, subject(x), vaultId), // the loop
      certifyDevice(sodium, y, subject(w), vaultId),
      certifyDevice(sodium, w, subject(y), vaultId), // a second loop
      certifyDevice(sodium, w, subject(z), vaultId),
    );
    const index = new CertificateIndex(sodium, vaultId, a.ring.recovery.signPublicKey, certs);
    const avoid = createDeviceIdentity(sodium).deviceId; // avoids nobody on the chain
    for (const order of [
      [x, y, w, z],
      [z, w, y, x],
      [y, z, x, w],
    ]) {
      const keys = new DecisionKeys(index, new Set());
      for (const d of order) {
        expect(keys.keysAvoiding(d.deviceId, avoid).length, d.deviceId).toBe(1);
      }
      // Avoiding Y cuts W and Z off (their only chain runs through Y), never X.
      expect(keys.keysAvoiding(z.deviceId, y.deviceId)).toEqual([]);
      expect(keys.keysAvoiding(x.deviceId, y.deviceId).length).toBe(1);
      expect(keys.keysAvoiding(z.deviceId, avoid).length).toBe(1); // the cache is per avoid
    }
  });
});

describe("self-retirement (lead decision: kept, with conditions)", () => {
  it("the cut of a self-revocation is its own position: a stolen device stating START cannot erase its history", async () => {
    const { a, b, r } = await household();
    r.write([note()]);
    r.write([note()]);
    syncAll([a, b, r]);
    const before = a.acceptedData().filter((x) => x.startsWith(r.id));
    expect(before.length).toBeGreaterThanOrEqual(2);
    const self = r.write([
      buildDeviceRevoked(r.identity, r.ring.vaultId, newEid(), [
        { device: r.id, cut: START_CURSOR },
      ]),
    ]);
    syncAll([a, b, r]);
    for (const x of [a, b]) {
      expect(x.devices.registry.revoked.get(r.id)?.cut, x.name).toEqual(self.cursor);
      for (const kept of before) expect(x.acceptedData(), x.name).toContain(kept);
    }
  });

  it("a device that paired others cannot retire itself alone: the orphans are listed; the words or a sibling re-certify them", async () => {
    const { a, b } = await household();
    const desk = await pairDevice(a, "desktop");
    const phone = await pairDevice(desk, "work phone");
    syncAll([a, b, desk, phone]);
    const self = [{ device: desk.id, cut: START_CURSOR }];
    const eids = () => ({ revoke: newEid(), rotate: newEid(), recertify: newEid });
    // Without a choice the orphan is listed and left untrusted (W1: nothing is automatic) ...
    const plain = desk.devices.prepareRevocation(self, eids());
    if (!plain.ok) throw new Error(plain.reason);
    expect(plain.change.affected).toMatchObject([
      { device: phone.id, recertified: false, reason: "not_selected", pairedBy: desk.id },
    ]);
    plain.change.discard();
    // ... and re-certifying it needs a sibling or the words: alone, the desktop is refused.
    const refused = desk.devices.prepareRevocation(self, eids(), undefined, {
      recertify: [phone.id],
    });
    expect(refused).toMatchObject({ ok: false, reason: "recovery_required" });
    if (refused.ok || refused.reason !== "recovery_required") throw new Error("expected a refusal");
    expect(refused.affected.map((x) => x.device)).toEqual([phone.id]);
    // A sibling (the phone B) retires the desktop on its consent: the desktop wipes its keys.
    const entries = [{ device: desk.id, cut: b.cursors.get(desk.id) ?? START_CURSOR }];
    const ids = eids();
    const consent = desk.devices.consentToRetirement(ids.revoke, entries, b.id);
    expect(() => desk.identity.sign("cashu/registry/v1", new Uint8Array(1))).toThrow();
    const result = b.devices.prepareRevocation(
      entries,
      ids,
      { consent: { [desk.id]: consent } },
      { recertify: [phone.id] },
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.change.affected).toMatchObject([
      { device: phone.id, name: "work phone", recertified: true, suggested: true },
    ]);
    b.write(result.change.events);
    result.change.commit();
    syncAll([a, b, phone]);
    expect(a.devices.registry.revoked.has(desk.id)).toBe(true);
    expect(a.devices.registry.isTrusted(phone.id)).toBe(true);
  });

  it("with the words the device retires itself, its orphans are re-certified, and it wipes its keys", async () => {
    const { a, b } = await household();
    const desk = await pairDevice(a, "desktop");
    const phone = await pairDevice(desk, "work phone");
    syncAll([a, b, desk, phone]);
    const words = a.words;
    if (!words) throw new Error("the test vault knows its words");
    const result = desk.devices.prepareRevocation(
      [{ device: desk.id, cut: START_CURSOR }],
      { revoke: newEid(), rotate: newEid(), recertify: newEid },
      words,
      { recertify: [phone.id] },
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.change.affected).toMatchObject([
      { device: phone.id, name: "work phone", recertified: true, suggested: false },
    ]);
    desk.write(result.change.events);
    result.change.commit();
    expect(() => desk.identity.sign("cashu/registry/v1", new Uint8Array(1))).toThrow();
    desk.push();
    syncAll([a, b, phone]);
    expect(a.devices.registry.revoked.has(desk.id)).toBe(true);
    expect(a.devices.registry.isTrusted(phone.id)).toBe(true);
  });
});
