// The genesis device (lead decision for S29c phase B2): certified by the recovery key with the
// vault, introduces itself in its first frame, writes the genesis stream, retires itself; a frame
// written after its retirement (a kept key) is rejected everywhere.

import { describe, expect, it } from "vitest";
import { certifyDevice, createDeviceIdentity, DeviceIdentity, Secret } from "../crypto/index.js";
import { buildDeviceAdded } from "./events.js";
import { createGenesisDevice, genesisAnnouncement, retireGenesis } from "./genesis.js";
import { note, syncAll } from "./orderSim.js";
import { createSimVault, forgeBatch, newEid, pairDevice, SimDevice, sodium } from "./testkit.js";

describe("genesis device", () => {
  it("writes the genesis stream, retires, and a post-retirement genesis frame is rejected", async () => {
    const vault = createSimVault();
    const a = vault.creator;
    const g = createGenesisDevice(sodium, vault.recovery, vault.vaultId);
    // What an attacker would need: a copy of the key kept past the retirement (never stored).
    const leaked = new DeviceIdentity(
      g.identity.deviceId,
      new Secret(g.identity.box.secretKey.expose().slice()),
      new Secret(g.identity.signSecretKey.expose().slice()),
    );
    const writer = new SimDevice("genesis", vault.remote, 0, g.identity);
    writer.attach(a.ring.clone(sodium), [g.certificate]);
    const history = [note(), note(), note()];
    writer.write([
      genesisAnnouncement(g, vault.vaultId, newEid()),
      history[0] as ReturnType<typeof note>,
    ]);
    writer.write(history.slice(1));
    const retire = retireGenesis(g, vault.vaultId, newEid());
    const retirement = writer.write([retire.event]);
    retire.done();
    expect(() => g.identity.sign("cashu/head/v1", new Uint8Array(1))).toThrow();
    writer.push();

    // After the retirement, the kept key writes more history and certifies a puppet.
    const puppet = createDeviceIdentity(sodium);
    const subject = {
      deviceId: puppet.deviceId,
      signPublicKey: puppet.signPublicKey,
      boxPublicKey: puppet.box.publicKey,
    };
    const late = note();
    const added = buildDeviceAdded(
      leaked,
      vault.vaultId,
      newEid(),
      subject,
      "puppet",
      certifyDevice(sodium, leaked, subject, vault.vaultId),
    );
    const at = {
      start: retirement.cursor,
      cursor: { seg: 1, offset: retirement.cursor.offset + 100 },
    };
    const events = [late, added].map((e) => ({
      eid: e.i,
      hlc: retirement.events[0]?.hlc ?? "",
      writer: leaked.deviceId,
      position: at.cursor,
      type: e.t,
      v: e.v,
      data: e.d,
    }));
    vault.remote.publish(
      forgeBatch(vault.vaultId, leaked, leaked.deviceId, at, events, retirement.head.chain),
    );

    const b = await pairDevice(a, "phone");
    syncAll([a, b]);
    for (const d of [a, b]) {
      const reg = d.devices.registry;
      // Retired at its own last batch: the history before it stands, nothing after it counts.
      expect(reg.revoked.get(g.identity.deviceId)?.cut, d.name).toEqual(retirement.cursor);
      expect(reg.isRegistered(puppet.deviceId), d.name).toBe(false);
      const eids = d.acceptedEids();
      for (const e of history) expect(eids, d.name).toContain(e.i);
      expect(eids, d.name).not.toContain(late.i);
    }
  });
});
