import { describe, expect, it } from "vitest";
import { START_CURSOR } from "../carrier.js";
import {
  certifyDevice,
  createDeviceIdentity,
  createRecoveryKey,
  RECOVERY_SIGNER_ID,
  recoveryIdentity,
  recoveryRecipient,
  unwrapKeys,
  wrapKeys,
} from "../crypto/index.js";
import { buildDeviceRevoked, buildRecoveryChanged, decodeRecoveryChanged } from "./events.js";
import { buildRecoveryChange } from "./recoveryChange.js";
import { epochPolicy } from "./rotation.js";
import {
  createSimVault,
  newEid,
  pairDevice,
  prepareConsented,
  SimDevice,
  sodium,
} from "./testkit.js";

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

describe("recovery key changed (n1)", () => {
  it("re-roots every device at the new words; the old words stop counting; new words restore; later pairings follow", async () => {
    const vault = createSimVault();
    const a = vault.creator;
    const b = await pairDevice(a, "phone");
    const c = await pairDevice(b, "tablet"); // certified by B
    const x = await pairDevice(a, "lost laptop");
    for (let i = 0; i < 2; i++) for (const d of [a, b, c, x]) d.sync();
    // With the OLD words the owner revoked a lost device: that revocation must survive the change.
    const lost = buildDeviceRevoked(vault.recovery, a.ring.vaultId, newEid(), [
      { device: x.id, cut: a.cursors.get(x.id) ?? START_CURSOR },
    ]);
    a.write([lost]);
    const rot = a.devices.prepareRotation(newEid());
    if (!rot.ok) throw new Error(rot.reason);
    a.write(rot.change.events);
    rot.change.commit();
    for (const d of [a, b, c]) d.sync();

    // New words on A.
    const fresh = createRecoveryKey(sodium);
    const next = recoveryIdentity(sodium, fresh.phrase);
    // Without the current words a trusted device cannot move the root (a stolen device could).
    const impostor = recoveryIdentity(sodium, createRecoveryKey(sodium).phrase);
    expect(() => a.devices.prepareRecoveryChange(impostor, next, newEid())).toThrow(RangeError);
    const change = a.devices.prepareRecoveryChange(vault.recovery, next, newEid());
    a.write([change]);
    expect(a.ring.recovery.signPublicKey).toEqual(next.publicKeys.signPublicKey);
    expect(a.devices.rotationNeeded()).toBe("recovery_changed");
    const after = a.devices.prepareRotation(newEid());
    if (!after.ok) throw new Error(after.reason);
    a.write(after.change.events);
    after.change.commit();
    expect(a.devices.rotationNeeded()).toBeUndefined();
    for (const d of [a, b, c]) d.sync();
    for (const d of [a, b, c]) {
      expect(d.ring.recovery.signPublicKey).toEqual(next.publicKeys.signPublicKey);
      expect([...d.devices.registry.trusted.keys()].sort()).toEqual([a.id, b.id, c.id].sort());
      expect(d.devices.registry.revoked.has(x.id)).toBe(true);
      expect(d.ring.active.kid).toBe(a.ring.active.kid);
    }

    // A thief with the OLD words: a new old-key revocation of A, and a puppet certified under the
    // old root that publishes a competing change. Devices pinned to the new words ignore both.
    const thiefWords = vault.recovery;
    const puppet = createDeviceIdentity(sodium);
    const puppetDevice = new SimDevice("puppet", vault.remote, 0, puppet);
    const stale = buildDeviceRevoked(thiefWords, a.ring.vaultId, newEid(), [
      { device: a.id, cut: START_CURSOR },
    ]);
    const puppetCert = certifyDevice(
      sodium,
      thiefWords,
      {
        deviceId: puppet.deviceId,
        signPublicKey: puppet.signPublicKey,
        boxPublicKey: puppet.box.publicKey,
      },
      a.ring.vaultId,
    );
    puppetDevice.attach(x.ring.clone(sodium), [puppetCert]);
    const other = recoveryIdentity(sodium, createRecoveryKey(sodium).phrase);
    // The puppet's view is rooted at the old words, where it is trusted.
    expect(puppetDevice.devices.registry.isTrusted(puppet.deviceId)).toBe(true);
    puppetDevice.write([
      stale,
      puppetDevice.devices.prepareRecoveryChange(thiefWords, other, newEid()),
    ]);
    puppetDevice.push();
    for (const d of [a, b, c]) d.pull();
    for (const d of [a, b, c]) {
      expect(d.devices.registry.isTrusted(a.id)).toBe(true);
      expect(d.devices.registry.isTrusted(puppet.deviceId)).toBe(false);
      expect(d.ring.recovery.signPublicKey).toEqual(next.publicKeys.signPublicKey);
    }

    // The new words seed a restore from the change's base wrap.
    const changed = decodeRecoveryChanged(change.d);
    if (!changed) throw new Error("change did not decode");
    const restored = unwrapKeys(
      sodium,
      Uint8Array.from(Buffer.from(changed.baseWrap, "hex")),
      next,
      { vaultId: vault.vaultId, recoveryPublicKey: next.publicKeys },
      (id) => (id === RECOVERY_SIGNER_ID ? next.publicKeys.signPublicKey : undefined),
      { acceptEpoch: () => true },
    );
    expect(restored.ring.recovery.signPublicKey).toEqual(next.publicKeys.signPublicKey);
    expect(restored.ring.gidSalt().expose()).toEqual(a.ring.gidSalt().expose());

    // A device paired after the change pins the new words and trusts the same devices.
    const d = await pairDevice(c, "new phone");
    expect(d.ring.recovery.signPublicKey).toEqual(next.publicKeys.signPublicKey);
    expect([...d.devices.registry.trusted.keys()].sort()).toEqual([a.id, b.id, c.id, d.id].sort());
    expect(d.devices.registry.revoked.has(x.id)).toBe(true);
  });

  it("a revoked device's change is ignored", async () => {
    const vault = createSimVault();
    const a = vault.creator;
    const r = await pairDevice(a, "stolen");
    for (const d of [a, r]) d.sync();
    const result = prepareConsented(a, [r]);
    if (!result.ok) throw new Error(result.reason);
    a.write(result.change.events);
    result.change.commit();
    a.push();
    const before = r.devices.registry; // R's view before it learns of its revocation
    const next = recoveryIdentity(sodium, createRecoveryKey(sodium).phrase);
    const event = buildRecoveryChange(
      sodium,
      r.identity,
      r.ring,
      before,
      vault.recovery,
      next,
      newEid(),
    );
    r.pull();
    r.write([event]);
    r.push();
    a.pull();
    expect(a.ring.recovery.signPublicKey).toEqual(vault.recovery.publicKeys.signPublicKey);
  });

  it("a still-trusted (stolen) device without the current words cannot move the root to its own", async () => {
    const vault = createSimVault();
    const a = vault.creator;
    const r = await pairDevice(a, "stolen");
    for (const d of [a, r]) d.sync();
    const thief = recoveryIdentity(sodium, createRecoveryKey(sodium).phrase);
    const clone = r.ring.clone(sodium);
    clone.replaceRecoveryKey(thief.publicKeys);
    const forged = buildRecoveryChanged(r.identity, thief, r.ring.vaultId, newEid(), {
      from: r.ring.recovery, // claims to replace the real words, but the real words did not sign
      to: thief.publicKeys,
      baseWrap: wrapKeys(sodium, clone, thief, recoveryRecipient(clone)),
      certificates: [...r.devices.registry.trusted.values()].map((d) =>
        certifyDevice(
          sodium,
          thief,
          { deviceId: d.deviceId, signPublicKey: d.signPublicKey, boxPublicKey: d.boxPublicKey },
          r.ring.vaultId,
        ),
      ),
      ratified: [],
    });
    r.write([forged]);
    r.push();
    a.pull();
    expect(a.ring.recovery.signPublicKey).toEqual(vault.recovery.publicKeys.signPublicKey);
    expect(r.ring.recovery.signPublicKey).toEqual(vault.recovery.publicKeys.signPublicKey);
  });
});
