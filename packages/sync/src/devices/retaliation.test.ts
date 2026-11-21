// S29c review H5: a revoked device that retaliates against its revoker must not make every other
// revocation it writes after its cut count. Closed by H2: a device-signed revocation of another
// device needs that device's consent, so a retaliation is refused outright, together with every
// other post-cut revocation in it. (A post-filter of the result was tried and rejected: it lets a
// minted key's forged self-revocation of the revoker erase the revoker's own revocation of the
// attacker; the decision-key property found it.) Forged consents from minted keys are
// consent.test.ts and retirement.test.ts; a backdated retaliation against the revoker alone is
// attacks.test.ts A1.

import { describe, expect, it } from "vitest";
import {
  createSimVault,
  newEid,
  pairDevice,
  revokeWithConsent,
  type SimDevice,
  START_CURSOR,
} from "../testing/devices/testkit.js";
import { buildDeviceRevoked } from "./events.js";

function syncAll(devices: readonly SimDevice[], rounds = 2): void {
  for (let i = 0; i < rounds; i++) for (const d of devices) d.sync();
}

describe("H5: retaliation does not carry a revoked device's other post-cut revocations", () => {
  it("R, revoked by B, revokes B and C in one event (no consent): only R is revoked", async () => {
    const { creator: a } = createSimVault();
    const b = await pairDevice(a, "phone");
    const r = await pairDevice(a, "laptop");
    const c = await pairDevice(a, "tablet");
    syncAll([a, b, r, c]);
    // B revokes R (R consented: it was in the owner's hands), R reads it.
    revokeWithConsent(b, [r]);
    b.push();
    r.pull();
    const entries = [b, c].map((x) => ({ device: x.id, cut: START_CURSOR }));
    r.write([buildDeviceRevoked(r.identity, r.ring.vaultId, newEid(), entries)]);
    syncAll([a, b, r, c]);
    for (const x of [a, b, c]) {
      const reg = x.devices.registry;
      expect([...reg.revoked.keys()], x.name).toEqual([r.id]);
      expect([...reg.trusted.keys()].sort(), x.name).toEqual([a.id, b.id, c.id].sort());
    }
  });
});
