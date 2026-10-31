// S29c review H5: a revoked device that retaliates against its revoker must not make every other
// revocation it writes after its cut count. Closed by H2: a device-signed revocation of another
// device needs that device's consent, so a retaliation is refused outright, and a stolen device is
// revoked with the recovery words, which it can never contest, so nothing it or its puppets sign
// afterwards ever counts, not even in the fixpoint's undecided readings. (A post-filter of the
// result was tried and rejected: it lets a minted key's forged self-revocation of the revoker erase
// the revoker's own revocation of the attacker; the decision-key property found it.)

import { describe, expect, it } from "vitest";
import type { UnstampedEvent } from "../carrier.js";
import { certifyDevice, createDeviceIdentity } from "../crypto/index.js";
import { buildDeviceAdded, buildDeviceRevoked } from "./events.js";
import {
  consentsOf,
  createSimVault,
  newEid,
  pairDevice,
  revokeWithConsent,
  type SimDevice,
  START_CURSOR,
  sodium,
} from "./testkit.js";

function syncAll(devices: readonly SimDevice[], rounds = 2): void {
  for (let i = 0; i < rounds; i++) for (const d of devices) d.sync();
}

async function vault() {
  const { creator: a } = createSimVault();
  const b = await pairDevice(a, "phone");
  const r = await pairDevice(a, "laptop");
  const c = await pairDevice(a, "tablet");
  const d = await pairDevice(a, "watch");
  syncAll([a, b, r, c, d]);
  // B revokes R (R consented: it was in the owner's hands), R reads it.
  revokeWithConsent(b, [r]);
  b.push();
  r.pull();
  return { a, b, r, c, d };
}

/** R's post-cut revocations of `targets`: one event, or one per target; consented or not. */
function retaliate(
  r: SimDevice,
  targets: readonly SimDevice[],
  oneEvent: boolean,
  consented: boolean,
) {
  const vaultId = r.ring.vaultId;
  const build = (group: readonly SimDevice[]): UnstampedEvent => {
    const entries = group.map((x) => ({ device: x.id, cut: START_CURSOR }));
    const eid = newEid();
    const consent = consented ? consentsOf(group, vaultId, eid, entries, r.id) : {};
    return buildDeviceRevoked(r.identity, vaultId, eid, entries, { consent });
  };
  r.write(oneEvent ? [build(targets)] : targets.map((t) => build([t])));
}

describe("H5: retaliation does not carry a revoked device's other post-cut revocations", () => {
  for (const oneEvent of [false, true]) {
    const shape = oneEvent ? "one event" : "three events";
    it(`R, revoked by B, revokes B, C and D (${shape}, no consent): only R is revoked`, async () => {
      const { a, b, r, c, d } = await vault();
      retaliate(r, [b, c, d], oneEvent, false);
      syncAll([a, b, r, c, d]);
      for (const x of [a, b, c, d]) {
        const reg = x.devices.registry;
        expect([...reg.revoked.keys()], x.name).toEqual([r.id]);
        expect([...reg.trusted.keys()].sort(), x.name).toEqual([a.id, b.id, c.id, d.id].sort());
      }
    });
  }
  it("a stolen device revoked with the words: neither it nor a puppet it paired while trusted can revoke anyone, even with a minted key's forged consent", async () => {
    const { creator: a, recovery } = createSimVault();
    const b = await pairDevice(a, "phone");
    const r = await pairDevice(a, "laptop");
    const c = await pairDevice(a, "tablet");
    const p = await pairDevice(r, "puppet"); // paired by R while R was trusted
    syncAll([a, b, r, c, p]);
    const vaultId = a.ring.vaultId;
    a.write([
      buildDeviceRevoked(recovery, vaultId, newEid(), [
        { device: r.id, cut: a.cursors.get(r.id) ?? START_CURSOR },
      ]),
    ]);
    syncAll([a, b, c]);
    r.pull();
    p.pull();
    // R mints a key for C's id and forges C's consent to the puppet's revocation of C.
    const fakeC = createDeviceIdentity(sodium, c.id);
    const subject = {
      deviceId: c.id,
      signPublicKey: fakeC.signPublicKey,
      boxPublicKey: fakeC.box.publicKey,
    };
    r.write([
      buildDeviceAdded(
        r.identity,
        vaultId,
        newEid(),
        subject,
        "tablet",
        certifyDevice(sodium, r.identity, subject, vaultId),
      ),
    ]);
    const entries = [{ device: c.id, cut: START_CURSOR }];
    const eid = newEid();
    p.write([
      buildDeviceRevoked(p.identity, vaultId, eid, entries, {
        consent: consentsOf([fakeC], vaultId, eid, entries, p.id),
      }),
    ]);
    syncAll([a, b, c, r, p]);
    for (const x of [a, b, c]) {
      const reg = x.devices.registry;
      expect([...reg.revoked.keys()], x.name).toEqual([r.id]);
      expect(reg.isTrusted(c.id), x.name).toBe(true);
    }
  });
});
