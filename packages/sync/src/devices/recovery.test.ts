import { describe, expect, it } from "vitest";
import { START_CURSOR } from "../carrier.js";
import {
  certifyDevice,
  createDeviceIdentity,
  RECOVERY_SIGNER_ID,
  unwrapKeys,
} from "../crypto/index.js";
import { epochPolicy } from "./rotation.js";
import { createSimVault, newEid, pairDevice, SimDevice, sodium } from "./testkit.js";

describe("recovery (n3)", () => {
  it("a device restored from the words caps epochs, revokes every pre-recovery device and rotates first", async () => {
    const vault = createSimVault();
    const a = vault.creator;
    const b = await pairDevice(a, "phone");
    for (const d of [a, b]) d.sync();

    // The restoring device seeds its ring only from the recovery-signed base wrap.
    const n = new SimDevice("restored", vault.remote);
    const recoveryKeys = vault.recovery.publicKeys;
    const base = unwrapKeys(
      sodium,
      vault.recoveryWrap,
      vault.recovery,
      { vaultId: vault.vaultId, recoveryPublicKey: recoveryKeys },
      (id) => (id === RECOVERY_SIGNER_ID ? recoveryKeys.signPublicKey : undefined),
      { acceptEpoch: (_sender, entry) => entry.epoch <= 1 },
    );
    const subject = {
      deviceId: n.id,
      signPublicKey: n.identity.signPublicKey,
      boxPublicKey: n.identity.box.publicKey,
    };
    const cert = certifyDevice(sodium, vault.recovery, subject, vault.vaultId);
    n.attach(base.ring, [cert], { highestRecoveryEpoch: 0 });
    n.pull();
    // Not yet: rotate before writing anything.
    expect(n.devices.rotationNeeded()).toBe("recovered");
    const policy = epochPolicy({ ...n.devices.keyContext() });
    expect(policy.acceptEpoch(a.id, { ...a.ring.active, epoch: 2 })).toBe(false);
    expect(policy.refusal).toBe("epoch_above_revocations");

    const result = n.devices.prepareRevocation(
      [a, b].map((d) => ({ device: d.id, cut: n.cursors.get(d.id) ?? START_CURSOR })),
      { revoke: newEid(), rotate: newEid() },
      vault.recovery,
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.change.recipients).toEqual([RECOVERY_SIGNER_ID]);
    n.write(result.change.events);
    result.change.commit();
    n.push();
    expect(n.devices.rotationNeeded()).toBeUndefined();
    expect(n.ring.active.epoch).toBe(1);

    // The old devices learn they are revoked and cannot read what the restored device writes.
    a.pull();
    expect(a.devices.registry.revoked.has(a.id)).toBe(true);
    expect(a.ring.get(n.ring.active.kid)).toBeUndefined();
    expect(createDeviceIdentity(sodium).deviceId).not.toBe(n.id);
  });
});
