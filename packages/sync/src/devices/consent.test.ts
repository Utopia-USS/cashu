// S29c review H5': a revocation consent counts only with a decision key of its target that does not
// rest on the revocation's signer (or anything it certified) or on a device the words revoked. The
// attack: R, revoked by B, certifies fresh keys for B, C and D after its cut and signs their
// "consent" to R's revocations of them with those keys.

import { describe, expect, it } from "vitest";
import type { UnstampedEvent } from "../carrier.js";
import { certifyDevice, createDeviceIdentity, type DeviceIdentity } from "../crypto/index.js";
import { buildDeviceAdded, buildDeviceRevoked } from "./events.js";
import {
  consentsOf,
  createSimVault,
  newEid,
  pairDevice,
  revokedWithConsent,
  revokeWithConsent,
  SimDevice,
  START_CURSOR,
  sodium,
} from "./testkit.js";

function syncAll(devices: readonly SimDevice[], rounds = 2): void {
  for (let i = 0; i < rounds; i++) for (const d of devices) d.sync();
}

async function vault() {
  const v = createSimVault();
  const a = v.creator;
  const b = await pairDevice(a, "phone");
  const r = await pairDevice(a, "laptop");
  const c = await pairDevice(a, "tablet");
  const d = await pairDevice(a, "watch");
  const r2 = await pairDevice(a, "old phone");
  syncAll([a, b, r, c, d, r2]);
  // B revokes R on R's consent (B did not certify R).
  revokeWithConsent(b, [r]);
  b.push();
  r.pull();
  return { ...v, a, b, r, c, d, r2 };
}

/** `issuer` certifies a fresh key pair for `victim`'s id (in its own stream, as a batch event). */
function mint(
  issuer: DeviceIdentity,
  vaultId: string,
  victim: string,
): {
  event: UnstampedEvent;
  key: DeviceIdentity;
} {
  const key = createDeviceIdentity(sodium, victim);
  const subject = {
    deviceId: victim,
    signPublicKey: key.signPublicKey,
    boxPublicKey: key.box.publicKey,
  };
  const cert = certifyDevice(sodium, issuer, subject, vaultId);
  return { event: buildDeviceAdded(issuer, vaultId, newEid(), subject, "minted", cert), key };
}

/** R revokes each victim, with a "consent" signed by the minted key. */
function forgedRevocations(r: SimDevice, minted: readonly DeviceIdentity[]): UnstampedEvent[] {
  return minted.map((k) => {
    const entries = [{ device: k.deviceId, cut: START_CURSOR }];
    const eid = newEid();
    const consent = consentsOf([k], r.ring.vaultId, eid, entries, r.id);
    return buildDeviceRevoked(r.identity, r.ring.vaultId, eid, entries, { consent });
  });
}

function expectOnlyR(devices: readonly SimDevice[], r: SimDevice, trusted: readonly SimDevice[]) {
  for (const x of devices) {
    const reg = x.devices.registry;
    expect([...reg.revoked.keys()], x.name).toEqual([r.id]);
    for (const t of trusted) expect(reg.isTrusted(t.id), `${x.name}: ${t.name}`).toBe(true);
    expect(reg.ignored.filter((i) => i.reason === "no_consent").length, x.name).toBeGreaterThan(0);
  }
}

describe("H5': consent keys never rest on the revocation's signer", () => {
  it("R mints keys for B, C and D after its cut and forges their consent: only R is revoked", async () => {
    const { a, b, r, c, d } = await vault();
    const minted = [b, c, d].map((x) => mint(r.identity, r.ring.vaultId, x.id));
    r.write(minted.map((m) => m.event));
    r.write(
      forgedRevocations(
        r,
        minted.map((m) => m.key),
      ),
    );
    syncAll([a, b, c, d, r]);
    expectOnlyR([a, b, c, d], r, [a, b, c, d]);
  });

  it("an accomplice revoked with the words mints the keys: still only R is revoked", async () => {
    const { a, b, r, c, d, r2, recovery } = await vault();
    a.write([
      buildDeviceRevoked(recovery, a.ring.vaultId, newEid(), [
        { device: r2.id, cut: a.cursors.get(r2.id) ?? START_CURSOR },
      ]),
    ]);
    syncAll([a, b, c, d]);
    const minted = [b, c, d].map((x) => mint(r2.identity, r2.ring.vaultId, x.id));
    r2.write(minted.map((m) => m.event));
    r.write(
      forgedRevocations(
        r,
        minted.map((m) => m.key),
      ),
    );
    syncAll([a, b, c, d, r, r2]);
    for (const x of [a, b, c, d]) {
      const reg = x.devices.registry;
      expect([...reg.revoked.keys()].sort(), x.name).toEqual([r.id, r2.id].sort());
      for (const t of [b, c, d]) expect(reg.isTrusted(t.id), x.name).toBe(true);
    }
  });

  it("a chain R -> puppet -> minted key does not help either", async () => {
    const { a, b, r, c, d } = await vault();
    const puppet = createDeviceIdentity(sodium);
    const subject = {
      deviceId: puppet.deviceId,
      signPublicKey: puppet.signPublicKey,
      boxPublicKey: puppet.box.publicKey,
    };
    r.write([
      buildDeviceAdded(
        r.identity,
        r.ring.vaultId,
        newEid(),
        subject,
        "puppet",
        certifyDevice(sodium, r.identity, subject, r.ring.vaultId),
      ),
    ]);
    const minted = [b, c, d].map((x) => mint(puppet, r.ring.vaultId, x.id));
    // The puppet's certificates sit in the puppet's own stream (written by the thief).
    const pDevice = new SimDevice("puppet", r.remote, 0, puppet);
    pDevice.attach(r.ring, []);
    pDevice.write(minted.map((m) => m.event));
    pDevice.push();
    r.write(
      forgedRevocations(
        r,
        minted.map((m) => m.key),
      ),
    );
    syncAll([a, b, c, d, r]);
    expectOnlyR([a, b, c, d], r, [a, b, c, d]);
  });

  it("control: a genuine consent from the target's legitimately certified key counts", async () => {
    const { a, b, r, c, d } = await vault();
    syncAll([a, b, c, d]);
    // C (B's sibling: it did not certify B) revokes B on B's genuine consent.
    c.write([
      revokedWithConsent(
        c.identity,
        c.ring.vaultId,
        [{ device: b.id, cut: c.cursors.get(b.id) ?? START_CURSOR }],
        [b],
      ),
    ]);
    syncAll([a, b, c, d, r]);
    const reg = a.devices.registry;
    expect([...reg.revoked.keys()].sort()).toEqual([b.id, r.id].sort());
    expect(reg.revoked.get(b.id)?.signers).toEqual([c.id]);
  });
});
